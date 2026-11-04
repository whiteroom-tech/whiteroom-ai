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
// Pre-cookie credentials in localStorage, which the bootstrap migrates.
const legacy = vi.hoisted(() => ({ creds: { fleetId: null as string | null, fleetToken: null as string | null } }));
vi.mock('@/lib/fleet-credentials', () => ({ getFleetCredentials: () => legacy.creds, clearFleetCredentials: () => { legacy.creds = { fleetId: null, fleetToken: null }; } }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), performanceLiveFeed: feed.fn }));

const { useFleetAuth } = await import('@/hooks/useFleetAuth');
const { LiveFeedPanel } = await import('@/components/home/LiveFeedPanel');
type Auth = ReturnType<typeof useFleetAuth>;

// The server, as the session route answers. `session` is the fleet the
// browser's cookie/account now holds (null = signed out).
const server = vi.hoisted(() => ({
  session: 'fleet-a' as string | null,
  signedIn: true,
  verdict: null as null | (() => Promise<Response>),
  post: null as null | (() => Promise<Response>),
  calls: [] as string[],
}));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fakeFetch(url: string, init?: RequestInit) {
  const method = init?.method ?? 'GET';
  server.calls.push(method);
  if (method === 'GET') return Promise.resolve(server.session ? json({ fleetId: server.session }) : json({ error: 'No fleet session.', signedIn: server.signedIn }, 401));
  if (method === 'POST' && url.endsWith('/recheck')) { server.calls.push('RECHECK'); return server.verdict ? server.verdict() : Promise.resolve(json({ cleared: true })); }
  if (method === 'DELETE') return Promise.resolve(json({ ok: true }));
  if (method === 'POST') return server.post ? server.post() : Promise.reject(new Error('unexpected POST'));
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
// The recheck after an auth error (verdict answers it); a plain DELETE is the no-fleet fallback.
const rechecks = () => server.calls.filter((c) => c === 'RECHECK').length;
const plainDeletes = () => server.calls.filter((c) => c === 'DELETE').length;

beforeEach(() => {
  vi.clearAllMocks();
  pings.log = [];
  Object.assign(server, { session: 'fleet-a', signedIn: true, verdict: null, post: null, calls: [] });
  legacy.creds = { fleetId: null, fleetToken: null };
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
  server.verdict = () => Promise.resolve(json({ cleared: true }));
  await reset();
  expect(auth.status).toBe('unauthenticated');
  expect(auth.needs).toBe('setup');
  expect(auth.loginError).toContain('Your session expired');
  expect(local.clear).toHaveBeenCalled();
  expect(pings.log.length).toBeGreaterThan(0);
});

it('cleared with no account session: signs out to sign-in', async () => {
  await mount();
  server.verdict = () => Promise.resolve(json({ cleared: true, signedIn: false }));
  await reset();
  expect(auth.needs).toBe('sign_in');
});

it('another fleet holds the session now: reloads, with one recheck and nothing cleared', async () => {
  await mount();
  server.verdict = () => Promise.resolve(json({ cleared: false, fleetId: 'fleet-b' }));
  await reset();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(rechecks()).toBe(1);
  expect(pings.log).toHaveLength(0);
});

it('same fleet, session fine: keeps it and offers Try again, without looping', async () => {
  await mount();
  server.verdict = () => Promise.resolve(json({ cleared: false, fleetId: 'fleet-a' }));
  await reset();
  expect(auth.status).toBe('unauthenticated');
  expect(auth.retryableError).toMatch(/still signed in/);
  expect(local.clear).not.toHaveBeenCalled();
  await flush(); await flush(); await flush();
  expect(rechecks()).toBe(1);
  expect(reload).not.toHaveBeenCalled();
});

it('server unreachable (502): nothing cleared, retryable', async () => {
  await mount();
  server.verdict = () => Promise.resolve(json({ error: 'engine_unreachable' }, 502));
  await reset();
  expect(auth.status).toBe('unauthenticated');
  expect(auth.retryableError).toMatch(/session was kept/);
  expect(local.clear).not.toHaveBeenCalled();
  expect(pings.log).toHaveLength(0);
});

it('network failure on the check: nothing cleared, retryable, no second recheck', async () => {
  await mount();
  server.verdict = () => Promise.reject(new TypeError('Failed to fetch'));
  await reset();
  expect(auth.retryableError).toMatch(/session was kept/);
  expect(rechecks()).toBe(1);
});

it('several auth errors at once send one check', async () => {
  await mount();
  let answer!: (r: Response) => void;
  server.verdict = () => new Promise((resolve) => { answer = resolve; });
  await act(async () => { auth.resetSession(); auth.resetSession(); auth.resetSession(); });
  await flush();
  expect(rechecks()).toBe(1);
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
  server.verdict = () => new Promise(() => {}); // the verdict never arrives
  await act(async () => { auth.resetSession(); }); await flush();
  expect(el.textContent).not.toContain('fleet-a-agent');
  await act(async () => lateFeed?.({ entries: [{ id: 'a2', type: 'task_complete', timestamp: '2026-11-03T16:01:00Z', agentId: 'fleet-a-agent', taskName: 'late' }], total: 1 })); await flush();
  expect(el.textContent).not.toContain('fleet-a-agent');
});

// --- The paths review asked to cover ---

it('resetSession with no fleet known yet: plain sign-out (DELETE), to setup, and other tabs told', async () => {
  server.session = null; server.signedIn = true; // the page never got a fleet
  await mount();
  expect(auth.fleetId).toBeNull();
  await act(async () => { auth.resetSession('Your session expired. Please sign in again.'); }); await flush();
  expect(plainDeletes()).toBe(1);
  expect(rechecks()).toBe(0);
  expect(auth.status).toBe('unauthenticated');
  expect(auth.needs).toBe('setup');
  expect(pings.log.length).toBeGreaterThan(0);
});

it('a ping that migrates legacy credentials for a different fleet reloads', async () => {
  await mount();
  expect(auth.fleetId).toBe('fleet-a');
  legacy.creds = { fleetId: 'fleet-b', fleetToken: 'placeholder-legacy-token' };
  server.post = () => Promise.resolve(json({ fleetId: 'fleet-b' }));
  await ping();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(auth.status).toBe('checking');
});

it('a ping that migrates legacy credentials for the same fleet changes nothing', async () => {
  await mount();
  legacy.creds = { fleetId: 'fleet-a', fleetToken: 'placeholder-legacy-token' };
  server.post = () => Promise.resolve(json({ fleetId: 'fleet-a' }));
  await ping();
  expect(reload).not.toHaveBeenCalled();
  expect(auth.status).toBe('authenticated');
});

it('a ping while a verdict is pending does not show the page again; it checks once the verdict is in', async () => {
  await mount();
  let answer!: (r: Response) => void;
  server.verdict = () => new Promise((resolve) => { answer = resolve; });
  await act(async () => { auth.resetSession(); }); await flush();
  expect(auth.status).toBe('checking');
  const gets = server.calls.filter((c) => c === 'GET').length;
  await ping(); // another tab: the session still reads as fleet A
  expect(auth.status).toBe('checking');
  expect(el.textContent).not.toContain('fleet-a-agent');
  expect(server.calls.filter((c) => c === 'GET').length).toBe(gets);
  server.session = null; server.signedIn = false;
  await act(async () => answer(json({ cleared: true }))); await flush();
  // The waiting check ran after the verdict, and agrees: signed out.
  expect(server.calls.filter((c) => c === 'GET').length).toBe(gets + 1);
  expect(auth.status).toBe('unauthenticated');
});
