import { beforeEach, describe, expect, it, vi } from 'vitest';

// Security fixes S7: the current address hears about an email change, at the
// request and once it's confirmed, so a borrowed session can't move the
// account quietly. A failed notice never blocks the change.
const mocks = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; text: string }>,
  failFor: null as string | null,
  pending: null as Record<string, unknown> | null,
  currentEmail: 'owner@example.test' as string | null,
}));

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u1' } }), signOut: vi.fn() }));
vi.mock('@/lib/app-origin', () => ({ appOrigin: () => 'https://app.example.test' }));
vi.mock('@/lib/session-check', () => ({ forgetSessionCheck: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ enqueueEntitlementSync: vi.fn(), resolvePlan: vi.fn(), syncEntitlementsToEngine: vi.fn() }));
vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn(async (m: { to: string; subject: string; text: string }) => {
    if (m.to === mocks.failFor) throw new Error('send failed');
    mocks.sent.push(m);
  }),
}));
vi.mock('@/lib/db', () => {
  const query = async (sql: string) => {
    if (sql.startsWith('SELECT email FROM users')) return { rows: [{ email: mocks.currentEmail }] };
    if (sql.includes('FROM email_change_requests')) return { rows: mocks.pending ? [mocks.pending] : [] };
    return { rows: [] };
  };
  return { db: () => ({ query, connect: async () => ({ query, release: () => {} }) }) };
});

vi.stubEnv('AUTH_SECRET', 'test-only-auth-secret');
const { requestEmailChange, confirmEmailChange } = await import('@/lib/account');

beforeEach(() => {
  mocks.sent = [];
  mocks.failFor = null;
  mocks.pending = null;
  mocks.currentEmail = 'owner@example.test';
});

describe('email change notices to the current address', () => {
  it('at the request: the new address gets the link, the current one is told', async () => {
    expect(await requestEmailChange('new@example.test')).toEqual({ ok: true });
    expect(mocks.sent.map((m) => m.to)).toEqual(['new@example.test', 'owner@example.test']);
    const notice = mocks.sent[1];
    expect(notice.subject).toBe('A change to your WhiteRoom sign-in email');
    expect(notice.text).toContain('new@example.test');
    expect(notice.text).toContain('cancel the change in Settings and sign out everywhere');
  });

  it('a failed notice does not block the request', async () => {
    mocks.failFor = 'owner@example.test';
    expect(await requestEmailChange('new@example.test')).toEqual({ ok: true });
    expect(mocks.sent.map((m) => m.to)).toEqual(['new@example.test']);
  });

  it('no notice when the confirmation link could not be sent (nothing was requested)', async () => {
    mocks.failFor = 'new@example.test';
    expect((await requestEmailChange('new@example.test')).ok).toBe(false);
    expect(mocks.sent).toEqual([]);
  });

  it('once confirmed: the old address is told the account moved', async () => {
    mocks.pending = { id: 'r1', user_id: 'u1', new_email: 'new@example.test', token_hash: 'h', expires_at: new Date(Date.now() + 60_000).toISOString() };
    expect(await confirmEmailChange('tok')).toEqual({ ok: true, newEmail: 'new@example.test' });
    expect(mocks.sent).toHaveLength(1);
    expect(mocks.sent[0].to).toBe('owner@example.test');
    expect(mocks.sent[0].subject).toBe('Your WhiteRoom sign-in email changed');
    expect(mocks.sent[0].text).toContain('info@whiteroom.tech');
  });

  it('a failed notice does not undo a confirmed change', async () => {
    mocks.pending = { id: 'r1', user_id: 'u1', new_email: 'new@example.test', token_hash: 'h', expires_at: new Date(Date.now() + 60_000).toISOString() };
    mocks.failFor = 'owner@example.test';
    expect(await confirmEmailChange('tok')).toEqual({ ok: true, newEmail: 'new@example.test' });
  });
});
