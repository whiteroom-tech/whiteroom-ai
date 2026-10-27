// @vitest-environment happy-dom
// The Runs table's Show filter in a DOM, with the engine mocked: Rule activity
// asks the engine for runs with rule activity, keeps it in the URL, hides day
// totals, and falls back to All on an engine that doesn't count rule actions.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunSummary } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: nav.replace, push: nav.push }), useSearchParams: () => nav.params }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'f1', authKey: 'k', resetSession: vi.fn() }) }));

const api = vi.hoisted(() => ({ list: vi.fn(), counted: true }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  listRuns: api.list,
  runDays: async () => ({ days: [] }),
  fleetReport: async () => ({ error: 'no' }),
}));

const run = (shift: number, x: Partial<RunSummary> = {}): RunSummary => ({
  runId: `lead-agent~${shift}`, agentId: 'lead-agent', shift, startedAt: new Date(Date.now() - shift * 60_000).toISOString(), endedAt: new Date().toISOString(),
  lengthSeconds: 60, calls: 3, failedCalls: 0, blockedCalls: 0, spendMicros: 0, unpricedAttempts: 0, coverage: { calls: 3, checked: 3 }, flags: [], ...x,
});

const { RunsTable } = await import('@/components/runs/RunsTable');
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(RunsTable, {})); });
  await flush();
  const radio = (label: string) => [...el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const click = async (b: Element | undefined) => { await act(async () => { (b as HTMLElement).click(); }); await flush(); };
  return { el, root, radio, click, text: () => el.textContent ?? '' };
}

beforeEach(() => {
  nav.params = new URLSearchParams();
  nav.replace.mockClear();
  api.list.mockReset();
  api.list.mockImplementation(async (_f: string, opts: { ruleActivity?: boolean }) => {
    const runs = [run(1, { wouldActCalls: 2 }), run(2, { wouldActCalls: 0 })];
    if (!api.counted) return { runs: runs.map(({ wouldActCalls: _, ...r }) => r), total: 2, cursor: null };
    return opts.ruleActivity ? { runs: [runs[0]], total: 1, cursor: null } : { runs, total: 2, cursor: null };
  });
  api.counted = true;
});

describe('Runs › Show › Rule activity', () => {
  it('asks the engine for runs with rule activity and keeps the choice in the URL', async () => {
    const m = await mount();
    expect(m.text()).toContain('A Record only rule would have acted 2 times');
    await m.click(m.radio('Rule activity'));
    expect(api.list).toHaveBeenLastCalledWith('f1', expect.objectContaining({ ruleActivity: true, flagged: false }), 'k');
    expect(nav.replace).toHaveBeenLastCalledWith(expect.stringContaining('show=rules'), { scroll: false });
    m.root.unmount();
  });

  it('opens on a shared ?show=rules link', async () => {
    nav.params = new URLSearchParams('show=rules');
    const m = await mount();
    expect(api.list).toHaveBeenCalledWith('f1', expect.objectContaining({ ruleActivity: true }), 'k');
    expect(m.radio('Rule activity')?.getAttribute('aria-checked')).toBe('true');
    m.root.unmount();
  });

  it('falls back to All, and offers no Rule activity, on an engine that doesn’t count rule actions', async () => {
    api.counted = false;
    nav.params = new URLSearchParams('show=rules');
    const m = await mount();
    expect(m.radio('Rule activity')).toBeUndefined();
    expect(api.list).toHaveBeenLastCalledWith('f1', expect.objectContaining({ ruleActivity: false }), 'k');
    m.root.unmount();
  });
});
