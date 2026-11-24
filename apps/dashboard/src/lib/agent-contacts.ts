import 'server-only';

// Agent contacts (gap-closing spec A5, contract 0.1). Who may be a contact,
// and who a notice about an agent goes to. The checks read the database each
// time, so a member who left or a fleet that changed hands is caught when a
// notice is sent, not only when the contact was set.

import { db } from '@/lib/db';
import { fleetOwners } from '@/lib/control-auth';

type Queryable = Pick<ReturnType<typeof db>, 'query'>;

/** The engine's agent id characters (run-id.ts), up to 128. */
export const AGENT_ID = /^[a-zA-Z0-9_\-.:@]{1,128}$/;

export interface ContactPerson {
  userId: string;
  email: string | null;
  name: string | null;
}

/** Who can be an agent's contact: the owner, then the active members of the owner's organization. */
export async function contactCandidates(ownerId: string, q: Queryable = db()): Promise<ContactPerson[]> {
  const { rows } = await q.query(
    `SELECT u.id AS "userId", u.email, u.name, (u.id = $1) AS owner
       FROM users u
      WHERE u.id = $1
         OR u.id IN (SELECT m.user_id FROM organization_members m
                      WHERE m.status = 'active'
                        AND m.org_id = (SELECT org_id FROM organization_members WHERE user_id = $1 AND status = 'active' LIMIT 1))
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

/** Sets or (null) clears a contact. The caller has checked the owner and the person. */
export async function writeContact(fleetId: string, agentId: string, contactUserId: string | null, by: string, q: Queryable = db()): Promise<void> {
  if (contactUserId === null) {
    await q.query('DELETE FROM agent_contacts WHERE fleet_id = $1 AND agent_id = $2', [fleetId, agentId]);
    return;
  }
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
