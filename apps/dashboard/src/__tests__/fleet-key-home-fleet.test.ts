// @vitest-environment happy-dom
// Fleet key on a Free account (free tier B3): its fleet is the home fleet,
// never the email-derived one; a retired one is replaced with the cleared
// line; over the sign-up cap it waits; a failure never falls back to the
// email-derived fleet. Paid accounts provision as before.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const m = vi.hoisted(() => ({
  ensure: vi.fn(),
  provisioning: vi.fn(),
  createFleet: vi.fn(),
  finishSignIn: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: 'authenticated', data: { user: { id: 'u1', email: 'free.user@example.com', name: 'Free' } } }) }));
vi.mock('@/lib/users', () => ({ getUserProvisioning: m.provisioning }));
vi.mock('@/lib/home-fleet', () => ({ ensureHomeFleet: m.ensure }));
vi.mock('@/lib/analytics', () => ({ initAnalytics: vi.fn(), analytics: { identify: vi.fn(), capture: vi.fn() } }));
vi.mock('@/components/ThemedShell', () => ({ ThemedShell: ({ children }: { children: unknown }) => h('div', null, children as never) }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: unknown }) => h('div', null, children as never) }));
// One-time lines (the cleared line, "You're live") come in through Onboarding's notice slot.
vi.mock('@/app/fleet-key/onboarding', () => ({ Onboarding: ({ fleetId, isNew, notice }: { fleetId: string; isNew: boolean; notice?: unknown }) => h('div', null, notice as never, `ONBOARDING ${fleetId}${isNew ? ' new' : ''}`) }));
// The plan state (banner, caveat) reads the signed-in account: none here.
vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('@/lib/whiteroom/client', () => ({
  createFleet: m.createFleet,
  fleetProvisioned: (res: { fleetToken?: string }) => typeof res.fleetToken === 'string' && res.fleetToken.length > 0,
  tokenLogin: vi.fn(async () => ({ success: true, report: {} })),
  registerAgent: vi.fn(),
  claimFleet: vi.fn(),
}));
vi.mock('@/app/fleet-key/provision', () => ({ finishSignIn: m.finishSignIn, resyncFleetToken: vi.fn() }));
const { default: FleetKeyPage } = await import('@/app/fleet-key/page');

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => root.render(h(FleetKeyPage))); await flush();
}
const KEY = 'sk-wr-x';
const homeRow = { apiKey: KEY, fleetId: 'home-abc', fleetToken: 'wr_home', byok: false, apiKeyUnreadable: false };
const noRow = { apiKey: null, fleetId: null, fleetToken: null, byok: false, apiKeyUnreadable: false };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  m.createFleet.mockImplementation(async (fleetId: string) => ({ fleetToken: `wr_${fleetId}` }));
  m.finishSignIn.mockImplementation(async (s: { fleetId: string; fleetToken: string }) => ({ kind: 'ready', fleetId: s.fleetId, fleetToken: s.fleetToken }));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; });

it('a new Free account uses its home fleet, never the email-derived id', async () => {
  m.ensure.mockResolvedValue({ kind: 'ready', fleetId: 'home-abc', changed: true, cleared: false, firstFleet: true });
  m.provisioning.mockResolvedValueOnce(noRow).mockResolvedValue(homeRow);
  await mount();
  expect(m.provisioning).toHaveBeenCalledTimes(2);
  expect(m.createFleet).toHaveBeenCalledWith('home-abc', KEY);
  expect(m.createFleet.mock.calls.map(([id]) => id)).not.toContain('free-user-example-com');
  expect(el.textContent).toBe('ONBOARDING home-abc new');
});

it('a replaced retired home fleet shows the cleared line', async () => {
  m.ensure.mockResolvedValue({ kind: 'ready', fleetId: 'home-abc', changed: true, cleared: true, firstFleet: false });
  m.provisioning.mockResolvedValue(homeRow);
  await mount();
  expect(el.querySelector('.wr-plan-banner')?.textContent).toBe('Your Sandbox was cleared after 30 days unused. This is a new one.');
  expect(el.textContent).toContain('ONBOARDING home-abc');
});

it('the cleared line survives a reload, only for the fleet that replaced the retired one, and shows once', async () => {
  localStorage.setItem('wr_sandbox_cleared', 'home-abc');
  m.ensure.mockResolvedValue({ kind: 'ready', fleetId: 'home-abc', changed: false, cleared: false, firstFleet: false });
  m.provisioning.mockResolvedValue(homeRow);
  await mount();
  expect(el.querySelector('.wr-plan-banner')?.textContent).toBe('Your Sandbox was cleared after 30 days unused. This is a new one.');
  expect(localStorage.getItem('wr_sandbox_cleared')).toBeNull();
  await act(async () => root.unmount()); document.body.innerHTML = '';
  localStorage.setItem('wr_sandbox_cleared', 'home-other');
  await mount();
  expect(el.querySelector('.wr-plan-banner')).toBeNull();
  expect(localStorage.getItem('wr_sandbox_cleared')).toBeNull();
});

it('a home fleet that can’t be made shows the load error and makes no fleet', async () => {
  m.ensure.mockResolvedValue({ kind: 'failed' });
  m.provisioning.mockResolvedValue(noRow);
  await mount();
  expect(el.textContent).toContain('Could not load your fleet. Please reload and try again.');
  expect(m.createFleet).not.toHaveBeenCalled();
});

it('a stored key that can’t be read keeps its own message, before any home fleet is asked for', async () => {
  m.provisioning.mockResolvedValue({ ...noRow, apiKeyUnreadable: true });
  await mount();
  expect(el.textContent).toContain('Your agents are not affected.');
  expect(m.ensure).not.toHaveBeenCalled();
});

it('plan unknown: an account with a fleet loads as before; one with none makes nothing', async () => {
  m.ensure.mockResolvedValue({ kind: 'unknown' });
  m.provisioning.mockResolvedValue(homeRow);
  await mount();
  expect(el.textContent).toBe('ONBOARDING home-abc');
  await act(async () => root.unmount()); document.body.innerHTML = '';
  vi.clearAllMocks();
  m.ensure.mockResolvedValue({ kind: 'unknown' });
  m.provisioning.mockResolvedValue(noRow);
  await mount();
  expect(el.textContent).toContain('Could not load your fleet.');
  expect(m.createFleet).not.toHaveBeenCalled();
});

it('over the sign-up cap: says when the Sandbox opens and makes no fleet', async () => {
  m.ensure.mockResolvedValue({ kind: 'over_cap', opensAt: new Date(Date.now() + 3_600_000).toISOString() });
  m.provisioning.mockResolvedValue(noRow);
  await mount();
  expect(el.textContent).toMatch(/Your account is ready\. We'll open your Sandbox/);
  expect(m.createFleet).not.toHaveBeenCalled();
});

it('a paid account provisions as before (the email-derived id for a first sign-in)', async () => {
  m.ensure.mockResolvedValue({ kind: 'not_free' });
  m.provisioning.mockResolvedValue(noRow);
  await mount();
  expect(m.createFleet).toHaveBeenCalledWith('free-user-example-com', expect.stringMatching(/^sk-wr-/));
  expect(el.textContent).toBe('ONBOARDING free-user-example-com new');
  expect(el.querySelector('.wr-plan-banner')).toBeNull();
});
