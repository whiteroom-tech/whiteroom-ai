// @vitest-environment happy-dom
// Practice tasks take the fleet from the layout's one session check
// (FleetAuthProvider) instead of asking /api/fleet/session again; with no
// fleet session they still say to sign in, and a failed check offers a reload.
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/sandbox/practice' }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));
const api = vi.hoisted(() => ({ list: vi.fn(), gov: vi.fn() }));
vi.mock('@/lib/sandbox/practice/api', async (orig) => ({ ...(await orig<typeof import('@/lib/sandbox/practice/api')>()), listPracticeRuns: api.list }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), governanceList: api.gov }));
const { PracticeTest } = await import('@/components/sandbox/practice/PracticeTest');
const { FleetAuthProvider } = await import('@/hooks/useFleetAuth');

let root: Root | null = null;
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); api.list.mockReset(); api.gov.mockReset(); });

async function mount(session: () => Promise<Response>) {
  const request = vi.fn((url: string) => (String(url) === '/api/fleet/session' ? session() : Promise.reject(new Error(`unexpected ${url}`))));
  vi.stubGlobal('fetch', request);
  const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => root!.render(h(FleetAuthProvider, null, h(PracticeTest)))); await flush();
  return { el, sessionChecks: () => request.mock.calls.filter(([u]) => String(u) === '/api/fleet/session').length };
}

it('reads the fleet’s tests with the provider’s session: one session check for the page', async () => {
  api.list.mockResolvedValue([]);
  api.gov.mockResolvedValue({ agents: [], rules: [], history: [] });
  const m = await mount(async () => json({ fleetId: 'fleet-a' }, 200));
  expect(m.sessionChecks()).toBe(1);
  expect(api.list).toHaveBeenCalledWith('fleet-a');
  expect(api.gov).toHaveBeenCalledWith('fleet-a');
});

it('with no fleet session, says to sign in and asks the engine nothing', async () => {
  const m = await mount(async () => json({ error: 'No fleet session.', signedIn: true }, 401));
  expect(m.el.textContent).toContain('Sign in and connect a fleet first');
  expect(api.list).not.toHaveBeenCalled();
});

it('a session check that failed offers a reload, not sign-in', async () => {
  const m = await mount(async () => json({ error: 'engine_unreachable' }, 502));
  expect(m.el.textContent).toContain('Couldn’t load your fleet from WhiteRoom');
  expect(api.list).not.toHaveBeenCalled();
});
