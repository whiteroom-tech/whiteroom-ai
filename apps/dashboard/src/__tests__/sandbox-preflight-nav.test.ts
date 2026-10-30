// @vitest-environment happy-dom
// Sandbox pre-flight Phase 2, mounted: the address drives the view (the sample
// report, a named test, setup) without remounting, a named test opens even when
// Past tests can't be read, and /sandbox decides between the pre-flight and the
// connection test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PracticeSource } from '@/lib/sandbox/practice/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The app router's instance is stable across renders, as Next's is.
const nav = vi.hoisted(() => { const replace = vi.fn(); return { params: new URLSearchParams(), replace, router: { replace } }; });
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params, useRouter: () => nav.router }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));
const engine = vi.hoisted(() => ({ list: vi.fn(), run: vi.fn(), result: vi.fn(), source: vi.fn(), gov: vi.fn() }));
vi.mock('@/lib/sandbox/practice/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/sandbox/practice/api')>()),
  listPracticeRuns: engine.list, getPracticeRun: engine.run, getPracticeResult: engine.result, sourceModel: engine.source,
}));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), governanceList: engine.gov }));
vi.mock('@/lib/sandbox/api', async (orig) => ({ ...(await orig<typeof import('@/lib/sandbox/api')>()), getHistory: async () => ({ sessions: [] }) }));
vi.mock('@/components/sandbox/TestRunFlow', () => ({ TestRunFlow: () => h('p', null, 'CONNECTION TEST') }));

const { PracticeTest } = await import('@/components/sandbox/practice/PracticeTest');
const { SandboxEntry } = await import('@/components/sandbox/SandboxEntry');
const { PracticeError } = await import('@/lib/sandbox/practice/api');
const { PRACTICE_STATES } = await import('@/app/dev/practice/states');
const { ROUTES } = await import('@/lib/routes');

const FINISHED = PRACTICE_STATES.failed;
const RUN_ID = FINISHED.run!.id;
const SOURCE: PracticeSource = { model: 'claude-haiku-4-5', provider: 'direct-anthropic', directKey: true, blocked: null, providerKeys: [], controls: { checks: [], calls: 0 } };

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
let root: Root;
let el: HTMLDivElement;
const go = async (query: string, component: typeof PracticeTest | typeof SandboxEntry = PracticeTest) => {
  nav.params = new URLSearchParams(query);
  // The same element at the same place: a re-render, never a remount, as a query-only link does.
  await act(async () => { root.render(h(component as typeof PracticeTest)); });
  await flush();
};
const text = () => el.textContent ?? '';

beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  for (const f of Object.values(engine)) f.mockReset();
  nav.replace.mockReset();
  engine.list.mockResolvedValue([]);
  engine.run.mockResolvedValue(FINISHED.run);
  engine.result.mockResolvedValue(FINISHED.result);
  engine.source.mockResolvedValue(SOURCE);
  engine.gov.mockResolvedValue({ fleetId: 'prod-eu', rules: [], history: [], agents: ['support-bot'], lastActiveAt: { 'support-bot': null } });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ fleetId: 'prod-eu' })));
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('the pre-flight follows the address', () => {
  it('switches between setup and the sample report both ways, loading the fleet once', async () => {
    await go('demo=1');
    expect(text()).toContain('A sample report with made-up results');
    // The sample report asks the engine nothing.
    expect(engine.list).not.toHaveBeenCalled();
    await go('');
    expect(text()).toContain('Pre-flight check');
    expect(text()).not.toContain('A sample report');
    await go('demo=1');
    expect(text()).toContain('A sample report with made-up results');
    await go('');
    expect(text()).toContain('Pre-flight check');
    expect(engine.list).toHaveBeenCalledTimes(1);
    expect(engine.gov).toHaveBeenCalledTimes(1);
  });

  it('a named test opens even when Past tests can’t be read', async () => {
    engine.list.mockRejectedValue(new PracticeError('Couldn’t reach WhiteRoom.', 502));
    await go(`run=${RUN_ID}`);
    expect(engine.run).toHaveBeenCalledWith('prod-eu', RUN_ID);
    expect(text()).toContain("Didn't pass · Fails gracefully");
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('a named test stays on screen when the list then says practice tests are off', async () => {
    engine.list.mockRejectedValue(new PracticeError('off', 404, 'practice_unavailable'));
    await go(`run=${RUN_ID}`);
    expect(text()).toContain("Didn't pass · Fails gracefully");
    expect(text()).not.toContain('Practice tests aren’t available yet');
  });

  it('a stale named test with a failing list shows one error and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    engine.list.mockRejectedValue(new PracticeError('off', 404, 'practice_unavailable'));
    engine.run.mockRejectedValue(new PracticeError('That test wasn’t found.', 404));
    await go(`run=${RUN_ID}`);
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('practice tests off still shows the calm page, named test or not', async () => {
    engine.list.mockRejectedValue(new PracticeError('off', 404, 'practice_unavailable'));
    engine.run.mockRejectedValue(new PracticeError('off', 404, 'practice_unavailable'));
    await go('');
    expect(text()).toContain('Practice tests aren’t available yet');
  });

  it('leaves a finished result for setup, and opens another test from a link', async () => {
    await go(`run=${RUN_ID}`);
    expect(text()).toContain("Didn't pass · Fails gracefully");
    // Start a new test: the same page without ?run=.
    await go('');
    expect(text()).toContain('Pre-flight check');
    // Past tests' Open the result: ?run= again.
    await go(`run=${RUN_ID}`);
    expect(text()).toContain("Didn't pass · Fails gracefully");
    expect(engine.run).toHaveBeenCalledTimes(2);
  });

  it('keeps an open test when the address drops ?run= (one test at a time)', async () => {
    const open = { ...FINISHED.run!, lifecycle: 'active' as const, progress: { done: 1, total: 6, lastContactAt: new Date().toISOString() } };
    engine.run.mockResolvedValue(open);
    await go(`run=${RUN_ID}`);
    expect(text()).toContain('Practice test running');
    await go('');
    expect(text()).toContain('Practice test running');
  });
});

describe('/sandbox: Sandbox v2, else the pre-flight or the connection test', () => {
  // The session answers the fleet; the Sandbox v2 BFF answers `sandbox` (a status, or no v2 on this engine).
  const routes = (sandbox: () => Response) => vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).startsWith('/api/sandbox/fleet/') ? sandbox() : Response.json({ fleetId: 'prod-eu' })));
  const noV2 = () => Response.json({ error: 'Sandbox isn’t available yet.', reason: 'sandbox_fleet_unavailable' }, { status: 404 });
  const v2 = () => Response.json({ success: true, exists: false });

  it('?connection=1 stays on the connection test without asking anything', async () => {
    await go('connection=1', SandboxEntry);
    expect(text()).toContain('CONNECTION TEST');
    expect(fetch).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('shows a skeleton while deciding, then the signed-in fleet’s Sandbox (no redirect)', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => String(url).startsWith('/api/sandbox/fleet/')
      ? Promise.resolve(v2())
      : new Promise<Response>((r) => { answer = r; })));
    await go('', SandboxEntry);
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => { answer(Response.json({ fleetId: 'prod-eu' })); });
    await flush();
    expect(text()).toContain('Paste your agent’s API key');
    expect(text()).not.toContain('CONNECTION TEST');
    expect(nav.replace).not.toHaveBeenCalled();
    expect(engine.source).not.toHaveBeenCalled();
    const [url, init] = vi.mocked(fetch).mock.calls.find(([u]) => String(u).startsWith('/api/sandbox/fleet/'))!;
    expect(url).toBe('/api/sandbox/fleet/status');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ fleet: 'prod-eu' });
  });

  it('with no Sandbox v2 on the engine, sends a fleet the pre-flight takes to it', async () => {
    routes(noV2);
    await go('', SandboxEntry);
    expect(nav.replace).toHaveBeenCalledWith(ROUTES.practiceTest);
  });

  it.each([
    ['a refused fleet (Bedrock IAM role)', () => { routes(noV2); engine.source.mockResolvedValue({ ...SOURCE, provider: 'cloud', blocked: 'bedrock_role' }); }],
    ['no session', () => { vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 }))); }],
    ['a failed lookup', () => { routes(noV2); engine.source.mockRejectedValue(new PracticeError('off', 404, 'practice_unavailable')); }],
  ])('keeps the connection test for %s', async (_, arrange) => {
    arrange();
    await go('', SandboxEntry);
    expect(text()).toContain('CONNECTION TEST');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('decides nothing once unmounted', async () => {
    routes(noV2);
    let answer!: (v: PracticeSource) => void;
    engine.source.mockReturnValue(new Promise<PracticeSource>((r) => { answer = r; }));
    await go('', SandboxEntry);
    act(() => root.unmount());
    root = createRoot(el);
    await act(async () => { answer(SOURCE); });
    await flush();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
