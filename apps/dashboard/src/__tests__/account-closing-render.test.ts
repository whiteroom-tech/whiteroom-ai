// @vitest-environment happy-dom
// Phase 7c on screen: Delete account's confirm step says what happens and
// starts the 14-day window; while it runs, Settings and the banner on every
// page offer Cancel deletion; a lapsed plan's banner offers Choose a plan.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  closing: null as { reason: 'deleted' | 'lapsed'; closesAt: string; blocked?: { reason: string; kind: 'subscription' | 'organization' } } | null,
  deleteAccount: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; error: string }),
  cancel: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; error: string }),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: api.refresh, push: vi.fn() }), usePathname: () => '/settings' }));
vi.mock('@/lib/account', () => ({
  getAccountClosing: async () => api.closing,
  cancelAccountDeletion: api.cancel,
  deleteAccount: api.deleteAccount,
  cancelEmailChange: vi.fn(), requestEmailChange: vi.fn(), signOutEverywhere: vi.fn(), unlinkProvider: vi.fn(), updateProfile: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/lib/billing', () => ({ openBillingPortal: vi.fn(), startCheckout: vi.fn() }));

const { AccountClosingBanner, closingMessage, daysLeft } = await import('@/components/AccountClosingBanner');
const { DangerSection } = await import('@/app/settings/settings-view');

const DAY = 86_400_000;
const ACCOUNT = { id: 'u1', email: 'owner@example.test', name: null, image: null, timezone: null, emailVerified: true, methods: [], pendingEmailChange: null, fleetCount: 1 };

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
async function mount(node: React.ReactElement) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  await flush();
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const link = (label: string) => [...el.querySelectorAll('a')].find((a) => a.textContent?.trim() === label) as HTMLAnchorElement | undefined;
  const click = async (b: HTMLElement) => { await act(async () => { b.click(); }); await flush(); };
  return { el, root, text: () => el.textContent ?? '', button, link, click };
}

beforeEach(() => {
  api.closing = null;
  api.deleteAccount.mockReset().mockImplementation(async () => ({ ok: true }));
  api.cancel.mockReset().mockImplementation(async () => ({ ok: true }));
  api.refresh.mockClear();
  document.body.innerHTML = '';
});

describe('the closing banner', () => {
  it('shows nothing when the account is not closing', async () => {
    const m = await mount(h(AccountClosingBanner));
    expect(m.el.querySelector('[data-testid="account-closing-banner"]')).toBeNull();
  });

  it('during a deletion: days left, Download export and Cancel deletion, which ends it', async () => {
    api.closing = { reason: 'deleted', closesAt: new Date(Date.now() + 14 * DAY - 60_000).toISOString() };
    const m = await mount(h(AccountClosingBanner));
    expect(m.text()).toContain('Your account will be deleted on');
    expect(m.text()).toContain('in 14 days');
    expect(m.text()).toContain('Your fleet keeps working until then.');
    expect(m.link('Download export')?.getAttribute('href')).toBe('/settings#audit-integrity');

    api.cancel.mockImplementation(async () => { api.closing = null; return { ok: true }; });
    await m.click(m.button('Cancel deletion')!);
    expect(api.cancel).toHaveBeenCalledTimes(1);
    expect(m.el.querySelector('[data-testid="account-closing-banner"]')).toBeNull();
  });

  it('a failed cancel says so and keeps the banner', async () => {
    api.closing = { reason: 'deleted', closesAt: new Date(Date.now() + 3 * DAY).toISOString() };
    api.cancel.mockImplementation(async () => ({ ok: false, error: 'There is no deletion to cancel.' }));
    const m = await mount(h(AccountClosingBanner));
    await m.click(m.button('Cancel deletion')!);
    expect(m.text()).toContain('There is no deletion to cancel.');
    expect(m.el.querySelector('[data-testid="account-closing-banner"]')).not.toBeNull();
  });

  it('after a lapse: Choose a plan instead of Cancel deletion', async () => {
    api.closing = { reason: 'lapsed', closesAt: new Date(Date.now() + 5 * DAY).toISOString() };
    const m = await mount(h(AccountClosingBanner));
    expect(m.text()).toContain('Your plan has ended. Your fleet keeps working until');
    expect(m.text()).toContain('WhiteRoom fleet key stops working');
    expect(m.link('Choose a plan')?.getAttribute('href')).toBe('/settings#plan');
    expect(m.button('Cancel deletion')).toBeUndefined();
  });

  it('words for each state, plain and short', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(daysLeft('2026-11-10T12:00:00Z', now)).toBe(14);
    expect(daysLeft('2026-10-27T13:00:00Z', now)).toBe(1);
    expect(daysLeft('2026-10-26T12:00:00Z', now)).toBe(0);
    expect(closingMessage({ reason: 'deleted', closesAt: '2026-11-10T12:00:00Z' }, now))
      .toBe('Your account will be deleted on November 10, 2026, in 14 days. Your fleet keeps working until then.');
    expect(closingMessage({ reason: 'lapsed', closesAt: '2026-10-28T12:00:00Z' }, now)).toContain('in 1 day.');
    expect(closingMessage({ reason: 'lapsed', closesAt: '2026-10-20T12:00:00Z' }, now))
      .toBe('Your fleet closed on October 20, 2026. Its audit trail is kept for 12 months.');
    for (const reason of ['deleted', 'lapsed'] as const) {
      expect(closingMessage({ reason, closesAt: '2026-11-10T12:00:00Z' }, now)).not.toMatch(/API key|whoever holds/i);
    }
  });
});

describe('Settings › Delete account', () => {
  it('the confirm step says what happens, needs the email, and starts the window', async () => {
    const m = await mount(h(DangerSection, { account: ACCOUNT, closing: null, pending: false }));
    expect(m.text()).not.toMatch(/whoever holds/i);
    await m.click(m.button('Delete my account')!);
    expect(m.text()).toContain('For the next 14 days your fleet keeps working');
    expect(m.text()).toContain('WhiteRoom fleet key stops working and calls through it are refused');
    expect(m.text()).toContain('The audit trail is kept for 12 months.');

    const go = m.button('Delete in 14 days')!;
    expect(go.disabled).toBe(true);
    const input = m.el.querySelector('#confirmDelete') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'owner@example.test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(go.disabled).toBe(false);

    const changed = vi.fn();
    window.addEventListener('wr:account-closing-changed', changed);
    await m.click(go);
    expect(api.deleteAccount).toHaveBeenCalledWith('owner@example.test');
    expect(changed).toHaveBeenCalled();
    expect(api.refresh).toHaveBeenCalled();
    window.removeEventListener('wr:account-closing-changed', changed);
  });

  it('shows a refusal (a live subscription) and starts nothing', async () => {
    api.deleteAccount.mockImplementationOnce(async () => ({ ok: false, error: 'Cancel your subscription in Manage billing before deleting your account.' }));
    const m = await mount(h(DangerSection, { account: ACCOUNT, closing: null, pending: false }));
    await m.click(m.button('Delete my account')!);
    const input = m.el.querySelector('#confirmDelete') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'owner@example.test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await m.click(m.button('Delete in 14 days')!);
    expect(m.text()).toContain('Cancel your subscription in Manage billing');
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('while a deletion runs: the date and Cancel deletion', async () => {
    const closing = { reason: 'deleted' as const, closesAt: '2026-11-10T12:00:00Z' };
    const m = await mount(h(DangerSection, { account: ACCOUNT, closing, pending: false }));
    expect(m.text()).toContain('Your account will be deleted on November 10, 2026.');
    expect(m.button('Delete my account')).toBeUndefined();
    await m.click(m.button('Cancel deletion')!);
    expect(api.cancel).toHaveBeenCalledTimes(1);
    expect(api.refresh).toHaveBeenCalled();
  });
});

describe('a blocked deletion (the window ended, something stops the removal)', () => {
  const SUB = 'Cancel your subscription in Manage billing before deleting your account.';
  const ORG = "You're the only owner of Acme. Make someone else an owner before deleting your account.";
  const past = new Date(Date.now() - DAY).toISOString();

  it('the banner says why, links to the fix and offers Keep my account', async () => {
    api.closing = { reason: 'deleted', closesAt: past, blocked: { kind: 'subscription', reason: SUB } };
    const m = await mount(h(AccountClosingBanner));
    expect(m.text()).toContain(`Your account can't be deleted yet: ${SUB}`);
    expect(m.text()).toContain('Or keep your account.');
    expect(m.link('Manage billing')?.getAttribute('href')).toBe('/settings#plan');
    api.cancel.mockImplementation(async () => { api.closing = { reason: 'lapsed', closesAt: past }; return { ok: true }; });
    await m.click(m.button('Keep my account')!);
    expect(api.cancel).toHaveBeenCalledTimes(1);
    expect(m.text()).toContain('Your fleet closed on');
    expect(m.button('Keep my account')).toBeUndefined();
  });

  it('an organization blocker links to the organization', async () => {
    api.closing = { reason: 'deleted', closesAt: past, blocked: { kind: 'organization', reason: ORG } };
    const m = await mount(h(AccountClosingBanner));
    expect(m.link('Open organization')?.getAttribute('href')).toBe('/organization');
    expect(m.link('Manage billing')).toBeUndefined();
  });

  it('Settings shows the same message, the fix and Keep my account', async () => {
    const closing = { reason: 'deleted' as const, closesAt: past, blocked: { kind: 'subscription' as const, reason: SUB } };
    const m = await mount(h(DangerSection, { account: ACCOUNT, closing, pending: false }));
    expect(m.text()).toContain(`Your account can't be deleted yet: ${SUB}`);
    expect(m.link('Manage billing')).toBeTruthy();
    expect(m.button('Cancel deletion')).toBeUndefined();
    await m.click(m.button('Keep my account')!);
    expect(api.cancel).toHaveBeenCalledTimes(1);
    expect(api.refresh).toHaveBeenCalled();
  });

  it('an ended deletion not (yet) found blocked shows no action', async () => {
    const closing = { reason: 'deleted' as const, closesAt: past };
    const m = await mount(h(DangerSection, { account: ACCOUNT, closing, pending: false }));
    expect(m.text()).toContain('Your account is being deleted.');
    expect(m.el.querySelectorAll('button')).toHaveLength(0);
  });

  it('the email says the same thing as the banner', async () => {
    const { deletionBlockedEmail } = await import('@/lib/magic-link-email');
    const { blockedMessage } = await import('@/lib/closing-shared');
    expect(deletionBlockedEmail(SUB, 'https://app.example.test/settings').text).toContain(blockedMessage(SUB));
  });
});
