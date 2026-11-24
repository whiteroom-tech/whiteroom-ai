import 'server-only';

// Agent contacts (gap-closing spec A5, contract 0.1). Who may be a contact,
// and who a notice about an agent goes to. The checks read the database each
// time, so a member who left or a fleet that changed hands is caught when a
// notice is sent, not only when the contact was set.

import { db } from '@/lib/db';
import { fleetOwners } from '@/lib/control-auth';

type Queryable = Pick<ReturnType<typeof db>, 'query'>;

/**
 * Keeps junk out of the contacts table: an id is 1–128 characters with no
 * spaces or control characters. What an agent id may be is the engine's to
 * say (a copy of its rule here would drift): an id the engine never accepts
 * just never gets a notice, and values only ever reach queries as parameters.
 */
export const AGENT_ID = /^[^\s\p{Cc}]{1,128}$/u;

export interface ContactPerson {
  userId: string;
  email: string | null;
  name: string | null;
}

/** Who can be an agent's contact: the owner, then the active members of the owner's organization. */
export async function contactCandidates(ownerId: string, q: Queryable = db()): Promise<ContactPerson[]> {
  const { rows } = await q.query(
    // The same rule as isContactAllowed: anyone active in an organization the
    // owner is active in. A user is active in at most one (006's
    // organization_members_one_active_idx), so this is that one.
    `SELECT u.id AS "userId", u.email, u.name, (u.id = $1) AS owner
       FROM users u
      WHERE u.id = $1
         OR u.id IN (SELECT b.user_id FROM organization_members a
                       JOIN organization_members b ON b.org_id = a.org_id
                      WHERE a.user_id = $1 AND a.status = 'active' AND b.status = 'active')
      ORDER BY owner DESC, u.email NULLS LAST, u.id`,
    [ownerId],
  );
  return rows.map((r) => ({ userId: r.userId, email: r.email ?? null, name: r.name ?? null }));
}

/** Whether `userId` may be the contact for a fleet `ownerId` owns. */
export async function isContactAllowed(ownerId: string, userId: string, q: Queryable = db()): Promise<boolean> {
  if (userId === ownerId) return true;
  const { rows } = await q.query(
    `SELECT 1 FROM organization_members a
       JOIN organization_members b ON b.org_id = a.org_id
      WHERE a.user_id = $1 AND a.status = 'active' AND b.user_id = $2 AND b.status = 'active'
      LIMIT 1`,
    [ownerId, userId],
  );
  return rows.length > 0;
}

export async function storedContact(fleetId: string, agentId: string, q: Queryable = db()): Promise<string | null> {
  const { rows } = await q.query('SELECT contact_user_id FROM agent_contacts WHERE fleet_id = $1 AND agent_id = $2', [fleetId, agentId]);
  return rows[0]?.contact_user_id ?? null;
}

/**
 * Most contacts a fleet keeps. The agent id isn't checked against the engine
 * (it may have no calls yet), so this bounds what a script calling the
 * action could add.
 */
export const MAX_CONTACTS_PER_FLEET = 1000;

/**
 * Sets or (null) clears a contact. The caller has checked the owner and the
 * person. False: the fleet is at its cap. Runs on the pool: a save takes its
 * own connection for the lock and transaction that keep the cap.
 */
export async function writeContact(fleetId: string, agentId: string, contactUserId: string | null, by: string): Promise<boolean> {
  if (contactUserId === null) {
    await db().query('DELETE FROM agent_contacts WHERE fleet_id = $1 AND agent_id = $2', [fleetId, agentId]);
    return true;
  }
  // A new row only while the fleet is under its cap; changing an existing one
  // always works. Counted and written under a per-fleet lock in one
  // transaction, so saves at the same moment can't each see room and overshoot.
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`agent-contacts:${fleetId}`]);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n, coalesce(bool_or(agent_id = $2), false) AS has FROM agent_contacts WHERE fleet_id = $1`, [fleetId, agentId]);
    if (!rows[0]?.has && Number(rows[0]?.n ?? 0) >= MAX_CONTACTS_PER_FLEET) {
      await client.query('ROLLBACK');
      return false;
    }
    await upsertContact(client, fleetId, agentId, contactUserId, by);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function upsertContact(q: Queryable, fleetId: string, agentId: string, contactUserId: string, by: string): Promise<void> {
  await q.query(
    `INSERT INTO agent_contacts (fleet_id, agent_id, contact_user_id, set_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (fleet_id, agent_id) DO UPDATE SET contact_user_id = EXCLUDED.contact_user_id, set_by = EXCLUDED.set_by, set_at = now()`,
    [fleetId, agentId, contactUserId, by],
  );
}

/**
 * Clears a contact only if it is still `staleUserId`, so a contact the owner
 * set a moment ago (another tab) is never the one removed.
 */
export async function clearStaleContact(fleetId: string, agentId: string, staleUserId: string, q: Queryable = db()): Promise<void> {
  await q.query('DELETE FROM agent_contacts WHERE fleet_id = $1 AND agent_id = $2 AND contact_user_id = $3', [fleetId, agentId, staleUserId]);
}

/**
 * For the first per-agent notice, C5's pause and ask (Phase 6): nothing sends
 * one yet, so nothing calls this yet. Kept here, tested, so the rule it
 * applies is settled before C5 is built.
 *
 * Who a notice about this agent goes to, checked now: its contact while they
 * are still the owner or in the owner's organization, else the owner. A
 * contact no longer allowed is cleared. Null: the fleet has no owner.
 */
export async function noticeRecipient(fleetId: string, agentId: string, q: Queryable = db()): Promise<{ userId: string; via: 'contact' | 'owner' } | null> {
  const owner = (await fleetOwners([fleetId], q)).get(fleetId) ?? null;
  if (!owner) return null;
  const contact = await storedContact(fleetId, agentId, q);
  if (!contact) return { userId: owner, via: 'owner' };
  if (await isContactAllowed(owner, contact, q)) return { userId: contact, via: contact === owner ? 'owner' : 'contact' };
  await clearStaleContact(fleetId, agentId, contact, q);
  return { userId: owner, via: 'owner' };
}

/**
 * After a control action the engine accepted: the agent it removed (a
 * successful deregister_agent), whose contact goes with it, so an agent that
 * later reuses the id starts with none. Null for anything else.
 */
export function removedAgentOf(action: string, body: string, reply: string): { fleetId: string; agentId: string } | null {
  if (action !== 'deregister_agent') return null;
  try {
    const sent = JSON.parse(body) as { fleet_id?: unknown; agent_id?: unknown };
    const got = JSON.parse(reply) as { success?: unknown; error?: unknown };
    if (got.success !== true || got.error) return null;
    if (typeof sent.fleet_id !== 'string' || typeof sent.agent_id !== 'string' || !AGENT_ID.test(sent.agent_id)) return null;
    return { fleetId: sent.fleet_id, agentId: sent.agent_id };
  } catch {
    return null;
  }
}

/** Removes an agent's contact (it was removed from the fleet). */
export async function forgetAgentContact(fleetId: string, agentId: string, q: Queryable = db()): Promise<void> {
  await q.query('DELETE FROM agent_contacts WHERE fleet_id = $1 AND agent_id = $2', [fleetId, agentId]);
}

/**
 * The cleanup after a control action the engine accepted (api/fleet/engine):
 * a removed agent's contact goes. Only for the fleet the action was
 * authorised on. Never throws: the change already happened.
 */
export async function afterControlAccepted(
  allowed: { action: string; fleetId: string }, body: string, reply: string,
  forget: (fleetId: string, agentId: string) => Promise<void> = forgetAgentContact,
): Promise<void> {
  const removed = removedAgentOf(allowed.action, body, reply);
  if (!removed || removed.fleetId !== allowed.fleetId) return;
  try { await forget(removed.fleetId, removed.agentId); } catch { /* left; noticeRecipient still checks it */ }
}
