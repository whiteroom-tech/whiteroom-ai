'use server';

// Agent page › Contact (gap-closing spec A5). Only the fleet's owner sees or
// sets it (contract 0.1); the owner check runs on every call.

import { auth } from '@/auth';
import { controlAccessError } from '@/lib/control-auth';
import { getFleetAuthCookie } from '@/lib/fleet-session';
import { AGENT_ID, clearStaleContact, contactCandidates, isContactAllowed, storedContact, writeContact, type ContactPerson } from '@/lib/agent-contacts';

export type ContactView =
  | { ok: true; contact: ContactPerson | null; candidates: ContactPerson[] }
  | { ok: false; error: string };

async function ownerOf(fleetId: string): Promise<{ userId: string } | { error: string }> {
  const session = await auth().catch(() => null);
  const userId = session?.user?.id;
  if (!userId) return { error: 'Sign in with your WhiteRoom account to set a contact.' };
  const token = await getFleetAuthCookie(session);
  if (!token) return { error: 'Open this fleet again to set a contact.' };
  const denied = await controlAccessError(fleetId, token, session);
  if (denied) return { error: denied.error };
  return { userId };
}

/** The agent's contact and who can be one. Owner only. */
export async function agentContactView(fleetId: string, agentId: string): Promise<ContactView> {
  if (!AGENT_ID.test(agentId)) return { ok: false, error: 'That isn’t an agent id.' };
  const o = await ownerOf(fleetId);
  if ('error' in o) return { ok: false, error: o.error };
  try {
    const [candidates, stored] = await Promise.all([contactCandidates(o.userId), storedContact(fleetId, agentId)]);
    const contact = candidates.find((c) => c.userId === stored) ?? null;
    // A contact who's no longer allowed (left the organization) is cleared
    // here as well as when a notice is sent, so the table never keeps them.
    if (stored && !contact) await clearStaleContact(fleetId, agentId, stored);
    return { ok: true, candidates, contact };
  } catch {
    return { ok: false, error: 'Couldn’t load the contact. Try again.' };
  }
}

/** Sets the agent's contact, or (null) goes back to the owner. Owner only. */
export async function setAgentContact(fleetId: string, agentId: string, contactUserId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!AGENT_ID.test(agentId)) return { ok: false, error: 'That isn’t an agent id.' };
  if (contactUserId !== null && (typeof contactUserId !== 'string' || !contactUserId)) return { ok: false, error: 'Pick a person.' };
  const o = await ownerOf(fleetId);
  if ('error' in o) return { ok: false, error: o.error };
  try {
    if (contactUserId !== null && !(await isContactAllowed(o.userId, contactUserId))) {
      return { ok: false, error: 'A contact must be you or a member of your organization.' };
    }
    const saved = await writeContact(fleetId, agentId, contactUserId === o.userId ? null : contactUserId, o.userId);
    if (!saved) return { ok: false, error: 'This fleet has as many contacts as it can keep. Clear one first.' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Couldn’t save. Try again.' };
  }
}
