// @vitest-environment happy-dom
// useFleetAuth after an auth error, and when another tab changes the session:
// the page hides at once, the server decides (sign out only on proof), a fleet
// switch reloads the tab, and a sign-out in another tab clears this one.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const local = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock('@/lib/session-local-state', () => ({ clearSessionLocalState: local.clear }));
// Pings this tab writes are recorded, not delivered back to it: browsers fire
// storage events only in *other* tabs. Tests deliver a cross-tab ping with ping().
const pings = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock('@/lib/safe-storage', () => ({
  safeGet: () => null,
  safeRemove: () => {},
  safeSet: (key: string, value: string) => { if (key === 'wr_auth_ping') pings.log.push(value); },
}));
const feed = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), performanceLiveFeed: feed.fn }));

const { useFleetAuth } = await import('@/hooks/useFleetAuth');
const { LiveFeedPanel } = await import('@/components/home/LiveFeedPanel');
type Auth = ReturnType<typeof useFleetAuth>;

// The server, as the session route answers. `session` is the fleet the
// browser's cookie/account now holds (null = signed out).
const server = vi.hoisted(() => ({
  session: 'fleet-a' as string | null,
  signedIn: true,
  deleteVerdict: null as null | (() => Promise<Response>),
  calls: [] as string[],
}));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fakeFetch(url: string, init?: RequestInit) {
  const method = init?.method ?? 'GET';
  server.calls.push(method);
  if (method === 'GET') return Promise.resolve(server.session ? json({ fleetId: server.session }) : json({ error: 'No fleet session.', signedIn: server.signedIn }, 401));
  if (method === 'DELETE') return server.deleteVerdict ? server.deleteVerdict() : Promise.resolve(json({ ok: true }));
  return Promise.reject(new Error(`unexpected ${method} ${url}`));
}

let auth: Auth;
/** Like a real page: content only while authenticated (FleetLogin otherwise). */
function Page() {
  auth = useFleetAuth();
  if (auth.status !== 'authenticated') return h('div', { 'data-testid': 'login' }, `${auth.status} ${auth.needs ?? ''} ${auth.retryableError ?? ''}`);
  return h(LiveFeedPanel, { fleetId: auth.fleetId!, refreshSignal: 0 });
}

let root: Root;
let el: HTMLDivElement;
const reload = vi.fn();
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => root.render(h(Page))); await flush();
}
const ping = async () => { await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'wr_auth_ping', newValue: String(Date.now()) })); }); await flush(); };
const deletes = () => server.calls.filter((c) => c === 'DELETE').length;

beforeEach(() => {
  vi.clearAllMocks();
  pings.log = [];
  Object.assign(server, { session: 'fleet-a', signedIn: true, deleteVerdict: null, calls: [] });
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload, assign: vi.fn() } });
  feed.fn.mockResolvedValue({ entries: [{ id: 'a1', type: 'task_complete', timestamp: '2026-11-03T16:00:00Z', agentId: 'fleet-a-agent', taskName: 'private to fleet A' }], total: 1 });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

// --- Another tab changed the session (ping path) ---

it('a ping that finds a different fleet unmounts the page and reloads', async () => {
  await mount();
  expect(auth.fleetId).toBe('fleet-a');
  server.session = 'fleet-b';
  await ping();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(auth.status).toBe('checking');
  expect(el.querySelector('[data-testid="login"]')).not.toBeNull();
});

it('a ping that finds the same fleet changes nothing', async () => {
  await mount();
  await ping();
  expect(reload).not.toHaveBeenCalled();
  expect(auth.status).toBe('authenticated');
});

it('a ping that finds no session (another tab signed out) signs this tab out and clears its local state', async () => {
  await mount();
  server.session = null; server.signedIn = false;
  await ping();
  expect(reload).not.toHaveBeenCalled();
  expect(auth.status).toBe('unauthenticated');
  expect(auth.needs).toBe('sign_in');
  expect(local.clear).toHaveBeenCalled();
});

// --- resetSession: the server's verdict ---

async function reset() { await act(async () => { auth.resetSession('Your session expired. Please sign in again.'); }); await flush(); }

it('cleared (token rejected): signs out to setup, tells other tabs', async () => {
  await mount();
  server.deleteVerdict = () => Promise.resolve(json({ cleared: true }));
  await reset();
  expect(auth.status).toBe('unauthenticated');
  expect(auth.needs).toBe('setup');
  expect(auth.loginError).toContain('Your session expired');
  expect(local.clear).toHaveBeenCalled();
  expect(pings.log.length).toBeGreaterThan(0);
});

it('cleared with no account session: signs out to sign-in', async () => {
  await mount();
  server.deleteVerdict = () => Promise.resolve(json({ cleared: true, signedIn: false }));
  await reset();
  expect(auth.needs).toBe('sign_in');
});

it('another fleet holds the session now: reloads, deletes nothing more', async () => {
  await mount();
  server.deleteVerdict = () => Promise.resolve(json({ cleared: false, fleetId: 'fleet-b' }));
  await reset();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(deletes()).toBe(1);
  expect(pings.log).toHaveLength(0);
});

it('same fleet, session fine: keeps it and offers Try again, without looping', async () => {
  await mount();
  server.deleteVerdict = () => Promise.resolve(json({ cleared: false, fleetId: 'fleet-a' }));
  await reset();
  expect(auth.status).toBe('unauthenticated');
  expect(auth.retryableError).toMatch(/still signed in/);
  expect(local.clear).not.toHaveBeenCalled();
  await flush(); await flush(); await flush();
  expect(deletes()).toBe(1);
  expect(reload).not.toHaveBeenCalled();
});

it('server unreachable (502): nothing cleared, retryable', async () => {
  await mount();
  server.deleteVerdict = () => Promise.resolve(json({ error: 'engine_unreachable' }, 502));
  await reset();
  expect(auth.status).toBe('unauthenticated');
  expect(auth.retryableError).toMatch(/session was kept/);
  expect(local.clear).not.toHaveBeenCalled();
  expect(pings.log).toHaveLength(0);
});

it('network failure on the check: nothing cleared, retryable, no second DELETE', async () => {
  await mount();
  server.deleteVerdict = () => Promise.reject(new TypeError('Failed to fetch'));
  await reset();
  expect(auth.retryableError).toMatch(/session was kept/);
  expect(deletes()).toBe(1);
});

it('several auth errors at once send one check', async () => {
  await mount();
  let answer!: (r: Response) => void;
  server.deleteVerdict = () => new Promise((resolve) => { answer = resolve; });
  await act(async () => { auth.resetSession(); auth.resetSession(); auth.resetSession(); });
  await flush();
  expect(deletes()).toBe(1);
  await act(async () => answer(json({ cleared: true }))); await flush();
  expect(auth.status).toBe('unauthenticated');
});

// --- The content boundary ---

it('the private feed leaves the screen the moment an auth error starts, and a late response for it stays gone', async () => {
  let lateFeed!: (v: unknown) => void;
  await mount();
  await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show live feed')!.click()); await flush();
  expect(el.textContent).toContain('fleet-a-agent');
  feed.fn.mockReturnValue(new Promise((resolve) => { lateFeed = resolve; }));
  server.deleteVerdict = () => new Promise(() => {}); // the verdict never arrives
  await act(async () => { auth.resetSession(); }); await flush();
  expect(el.textContent).not.toContain('fleet-a-agent');
  await act(async () => lateFeed?.({ entries: [{ id: 'a2', type: 'task_complete', timestamp: '2026-11-03T16:01:00Z', agentId: 'fleet-a-agent', taskName: 'late' }], total: 1 })); await flush();
  expect(el.textContent).not.toContain('fleet-a-agent');
});
