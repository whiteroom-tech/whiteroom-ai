import { beforeEach, describe, expect, it, vi } from 'vitest';

// Agent contact actions (gap-closing spec A5): the owner check runs on every
// call, and only the owner or their organization's members can be set.
const m = vi.hoisted(() => ({
  session: { user: { id: 'owner' } } as { user: { id: string } } | null,
  token: 'tok' as string | null,
  denied: null as { status: number; error: string } | null,
  allowed: true,
  write: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/auth', () => ({ auth: async () => m.session }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: async () => m.token }));
vi.mock('@/lib/control-auth', () => ({ controlAccessError: async () => m.denied }));
vi.mock('@/lib/agent-contacts', async (orig) => ({
  ...(await orig<typeof import('@/lib/agent-contacts')>()),
  isContactAllowed: async () => m.allowed,
  writeContact: m.write,
  contactCandidates: async () => [{ userId: 'owner', email: null, name: null }, { userId: 'mate', email: null, name: null }],
  storedContact: async () => 'mate',
}));

import { agentContactView, setAgentContact } from '@/lib/agent-contact-actions';

beforeEach(() => {
  Object.assign(m, { session: { user: { id: 'owner' } }, token: 'tok', denied: null, allowed: true });
  m.write.mockReset();
});

describe('agent contact actions', () => {
  it('save for the owner, storing the owner as no contact', async () => {
    expect(await setAgentContact('f1', 'a1', 'mate')).toEqual({ ok: true });
    expect(m.write).toHaveBeenLastCalledWith('f1', 'a1', 'mate', 'owner');
    await setAgentContact('f1', 'a1', 'owner');
    expect(m.write).toHaveBeenLastCalledWith('f1', 'a1', null, 'owner');
  });

  it('refuse anyone but the owner, signed out, or an unlinked fleet', async () => {
    m.denied = { status: 403, error: 'Only this fleet’s owner can change it.' };
    expect(await setAgentContact('f1', 'a1', 'mate')).toEqual({ ok: false, error: 'Only this fleet’s owner can change it.' });
    expect(await agentContactView('f1', 'a1')).toEqual({ ok: false, error: 'Only this fleet’s owner can change it.' });
    m.denied = null;
    m.session = null;
    expect((await setAgentContact('f1', 'a1', 'mate')).ok).toBe(false);
    m.session = { user: { id: 'owner' } };
    m.token = null;
    expect((await setAgentContact('f1', 'a1', 'mate')).ok).toBe(false);
    expect(m.write).not.toHaveBeenCalled();
  });

  it('refuse a person outside the owner’s organization, and a bad agent id', async () => {
    m.allowed = false;
    expect(await setAgentContact('f1', 'a1', 'stranger')).toEqual({ ok: false, error: 'A contact must be you or a member of your organization.' });
    expect((await setAgentContact('f1', 'not an id!', 'mate')).ok).toBe(false);
    expect(m.write).not.toHaveBeenCalled();
  });

  it('show the stored contact to the owner', async () => {
    expect(await agentContactView('f1', 'a1')).toMatchObject({ ok: true, contact: { userId: 'mate' } });
  });
});
