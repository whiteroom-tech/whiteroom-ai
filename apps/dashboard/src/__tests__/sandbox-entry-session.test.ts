// @vitest-environment happy-dom
// /sandbox: only "no fleet session" (401) opens the older connection test. A
// failed session check (502, network) is shown as one, with Try again.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nav = vi.hoisted(() => ({ params: new URLSearchParams(), router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => nav.router, useSearchParams: () => nav.params, usePathname: () => '/sandbox' }));
vi.mock('@/components/sandbox/TestRunFlow', () => ({ TestRunFlow: () => h('div', null, 'LEGACY CONNECTION TEST') }));
vi.mock('@/components/sandbox/v2/SandboxHome', () => ({
  SANDBOX_LEAD: 'LEAD',
  SandboxHome: ({ fleet, planLine }: { fleet: string; planLine?: unknown }) => h('div', null, planLine as never, `CURRENT SANDBOX ${fleet}`),
}));
// The home fleet (free tier B3): a paid account by default, so every older test runs as before.
const home = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock('@/lib/home-fleet', () => ({ ensureHomeFleet: home.ensure }));
vi.mock('@/components/citadel/PageChrome', () => ({ PageHeader: () => null }));
const { SandboxEntry } = await import('@/components/sandbox/SandboxEntry');
const { FleetAuthProvider } = await import('@/hooks/useFleetAuth');

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => root.render(h(SandboxEntry))); await flush();
}
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tryAgain = () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Try again');

beforeEach(() => {
  nav.params = new URLSearchParams(); vi.clearAllMocks();
  home.ensure.mockResolvedValue({ kind: 'not_free' });
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

it('a 502 shows a failed check with Try again, not the old flow; Try again then opens the Sandbox', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(json({ error: 'engine_unreachable', retryable: true }, 502))
    .mockResolvedValueOnce(json({ fleetId: 'fleet-a' }, 200));
  vi.stubGlobal('fetch', request);
  await mount();
  expect(el.textContent).not.toContain('LEGACY CONNECTION TEST');
  expect(el.textContent).toContain('Couldn’t load the Sandbox.');
  await act(async () => tryAgain()!.click()); await flush();
  expect(request).toHaveBeenCalledTimes(2);
  expect(el.textContent).toContain('CURRENT SANDBOX fleet-a');
});

it('a network failure is a failed check too', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await mount();
  expect(el.textContent).toContain('Couldn’t load the Sandbox.');
  expect(el.textContent).not.toContain('LEGACY CONNECTION TEST');
});

it('401 (no fleet session) keeps the older connection test', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'No fleet session.', signedIn: true }, 401)));
  await mount();
  expect(el.textContent).toBe('LEGACY CONNECTION TEST');
});

it('?connection=1 opens the connection test without checking the session', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  nav.params = new URLSearchParams('connection=1');
  await mount();
  expect(el.textContent).toBe('LEGACY CONNECTION TEST');
  expect(request).not.toHaveBeenCalled();
});

it('under the layout’s FleetAuthProvider, uses its session check instead of making another', async () => {
  const request = vi.fn().mockResolvedValue(json({ fleetId: 'fleet-a' }, 200));
  vi.stubGlobal('fetch', request);
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => root.render(h(FleetAuthProvider, null, h(SandboxEntry)))); await flush();
  expect(el.textContent).toBe('CURRENT SANDBOX fleet-a');
  expect(request).toHaveBeenCalledTimes(1);
});

// ── The Free home fleet (B3) ─────────────────────────────────────────

const ready = (fleetId: string, extra: Record<string, boolean> = {}) => ({ kind: 'ready', fleetId, changed: false, cleared: false, firstFleet: false, ...extra });

it('a paid account opens as before: the home fleet is asked once, nothing else changes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ fleetId: 'fleet-a' }, 200)));
  await mount();
  expect(home.ensure).toHaveBeenCalledTimes(1);
  expect(el.textContent).toBe('CURRENT SANDBOX fleet-a');
});

it('while the home fleet is made, the skeleton says Opening your Sandbox…', async () => {
  home.ensure.mockReturnValue(new Promise(() => {}));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'No fleet session.', signedIn: true }, 401)));
  await mount();
  expect(el.textContent).toContain('Opening your Sandbox…');
  expect(el.textContent).not.toContain('LEGACY CONNECTION TEST');
});

it('a new home fleet: the session is checked again and its Sandbox opens', async () => {
  home.ensure.mockResolvedValue(ready('home-new', { changed: true, firstFleet: true }));
  const request = vi.fn()
    .mockResolvedValueOnce(json({ error: 'No fleet session.', signedIn: true }, 401))
    .mockResolvedValueOnce(json({ fleetId: 'home-new' }, 200));
  vi.stubGlobal('fetch', request);
  await mount();
  expect(request).toHaveBeenCalledTimes(2);
  expect(el.textContent).toBe('CURRENT SANDBOX home-new');
});

it('a replaced retired home fleet shows the cleared line over the new Sandbox, once', async () => {
  home.ensure.mockResolvedValue(ready('home-new', { changed: true, cleared: true }));
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(json({ error: 'No fleet session.', signedIn: true }, 401))
    .mockResolvedValue(json({ fleetId: 'home-new' }, 200)));
  await mount();
  expect(el.textContent).toBe('Your Sandbox was cleared after 30 days unused. This is a new one.CURRENT SANDBOX home-new');
  expect(el.querySelector('.wr-plan-banner')).not.toBeNull();
  expect(localStorage.getItem('wr_sandbox_cleared')).toBeNull();
});

it('the cleared line survives the reload a fleet switch makes', async () => {
  localStorage.setItem('wr_sandbox_cleared', 'home-new');
  home.ensure.mockResolvedValue(ready('home-new'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ fleetId: 'home-new' }, 200)));
  await mount();
  expect(el.textContent).toContain('Your Sandbox was cleared after 30 days unused.');
});

it('a stale cleared mark for another fleet never shows, and is dropped', async () => {
  localStorage.setItem('wr_sandbox_cleared', 'home-old');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ fleetId: 'fleet-a' }, 200)));
  await mount();
  expect(el.textContent).toBe('CURRENT SANDBOX fleet-a');
  expect(localStorage.getItem('wr_sandbox_cleared')).toBeNull();
});

it('plan unknown: the Sandbox opens as before', async () => {
  home.ensure.mockResolvedValue({ kind: 'unknown' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ fleetId: 'fleet-a' }, 200)));
  await mount();
  expect(el.textContent).toBe('CURRENT SANDBOX fleet-a');
});

it('a home fleet that can’t be made (an error or the new-fleet limit): Couldn’t open your Sandbox, and Try again asks again', async () => {
  home.ensure.mockResolvedValueOnce({ kind: 'failed' }).mockResolvedValueOnce(ready('home-a'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ fleetId: 'home-a' }, 200)));
  await mount();
  expect(el.textContent).toContain('Couldn’t open your Sandbox. Try again.');
  expect(el.textContent).not.toContain('CURRENT SANDBOX');
  await act(async () => tryAgain()!.click()); await flush();
  expect(home.ensure).toHaveBeenCalledTimes(2);
  expect(el.textContent).toBe('CURRENT SANDBOX home-a');
});

it('a thrown server action is the same failure', async () => {
  home.ensure.mockRejectedValue(new Error('network'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ fleetId: 'home-a' }, 200)));
  await mount();
  expect(el.textContent).toContain('Couldn’t open your Sandbox. Try again.');
});

it('over the sign-up cap: the lead and when it opens, in place of Connect', async () => {
  home.ensure.mockResolvedValue({ kind: 'over_cap', opensAt: new Date(Date.now() + 3_600_000).toISOString() });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'No fleet session.', signedIn: true }, 401)));
  await mount();
  expect(el.textContent).toContain('LEAD');
  expect(el.textContent).toMatch(/Your account is ready\. We'll open your Sandbox (tomorrow )?at \d{1,2}:\d{2}\s?[AP]M your time\./);
  expect(el.textContent).not.toContain('LEGACY CONNECTION TEST');
});

it('?connection=1 doesn’t ask for the home fleet', async () => {
  vi.stubGlobal('fetch', vi.fn());
  nav.params = new URLSearchParams('connection=1');
  await mount();
  expect(home.ensure).not.toHaveBeenCalled();
});
