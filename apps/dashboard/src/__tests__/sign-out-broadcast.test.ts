// @vitest-environment happy-dom
// The sign-out page, driven for real, with a second "tab" (a useFleetAuth
// consumer) listening. Other tabs are told only after Auth.js has finished:
// told sooner, they re-check while the account is still signed in and adopt
// its fleet into a fresh cookie.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const order = vi.hoisted(() => ({ log: [] as string[] }));
// The ping the sign-out page writes reaches the other tab as a storage event.
vi.mock('@/lib/safe-storage', () => ({
  safeGet: () => null,
  safeRemove: () => {},
  safeSet: (key: string, value: string) => {
    if (key !== 'wr_auth_ping') return;
    order.log.push('ping');
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
  },
}));
const local = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock('@/lib/session-local-state', () => ({ clearSessionLocalState: local.clear }));
vi.mock('@/lib/sandbox/api', () => ({ clearSandboxToken: () => {}, forgetSandboxChoices: () => {} }));
vi.mock('@/components/ThemedShell', () => ({ ThemedShell: ({ children }: { children: React.ReactNode }) => h('div', null, children) }));

// Auth.js: the account session ends only when signOut() resolves.
const account = vi.hoisted(() => ({ signedIn: true, hold: null as null | Promise<void>, fail: false }));
vi.mock('next-auth/react', () => ({
  signOut: vi.fn(async () => {
    if (account.hold) await account.hold;
    if (account.fail) throw new Error('auth down');
    account.signedIn = false;
    order.log.push('signOut');
  }),
}));

// The session route: with the account signed in, GET adopts its linked fleet
// even after the fleet cookie was deleted (that's the hazard).
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fakeFetch(_url: string, init?: RequestInit) {
  const method = init?.method ?? 'GET';
  if (method === 'DELETE') { order.log.push('DELETE'); return Promise.resolve(json({ ok: true })); }
  return Promise.resolve(account.signedIn ? json({ fleetId: 'fleet-a' }) : json({ error: 'No fleet session.', signedIn: false }, 401));
}

const { useFleetAuth } = await import('@/hooks/useFleetAuth');
const { default: SignOut } = await import('@/app/auth/sign-out/page');
let other: ReturnType<typeof useFleetAuth>;
function OtherTab() { other = useFleetAuth(); return h('span', null, other.status); }

const roots: Root[] = [];
const flush = () => act(async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); });
async function render(node: React.ReactNode) {
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el); roots.push(root);
  await act(async () => root.render(node)); await flush();
  return el;
}
const assign = vi.fn((url: string) => { order.log.push(`assign ${url}`); });

beforeEach(() => {
  vi.clearAllMocks();
  order.log = [];
  Object.assign(account, { signedIn: true, hold: null, fail: false });
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, reload: vi.fn() } });
});
afterEach(async () => { for (const r of roots.splice(0)) await act(async () => r.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

it('signs out in order (cookie, account, tell other tabs, leave) and the other tab ends signed out', async () => {
  await render(h(OtherTab));
  expect(other.status).toBe('authenticated');
  await render(h(SignOut));
  expect(order.log).toEqual(['DELETE', 'signOut', 'ping', 'assign https://whiteroom.tech']);
  expect(other.status).toBe('unauthenticated');
  expect(other.needs).toBe('sign_in');
  expect(local.clear).toHaveBeenCalled(); // this tab's, and the other tab's on its 401
});

it('negative control: a ping before the account sign-out finishes leaves the other tab signed in again', async () => {
  // Shows the test above can tell the order apart: told early, the other tab
  // re-checks while the account is still signed in and is handed its fleet back.
  let release!: () => void;
  account.hold = new Promise<void>((resolve) => { release = resolve; });
  await render(h(OtherTab));
  await render(h(SignOut)); // waiting inside signOut()
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'wr_auth_ping', newValue: 'early' })); }); await flush();
  expect(other.status).toBe('authenticated');
  expect(other.fleetId).toBe('fleet-a');
  await act(async () => release()); await flush();
});

it('if the account sign-out fails: no ping, no navigation, and Try again', async () => {
  account.fail = true;
  await render(h(OtherTab));
  const page = await render(h(SignOut));
  expect(order.log).toEqual(['DELETE']);
  expect(assign).not.toHaveBeenCalled();
  expect(page.textContent).toContain('Couldn’t sign out. Try again.');
  expect(other.status).toBe('authenticated');
  account.fail = false;
  await act(async () => [...page.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Try again')!.click()); await flush();
  expect(assign).toHaveBeenCalledWith('https://whiteroom.tech');
  expect(other.status).toBe('unauthenticated');
});
