// @vitest-environment happy-dom
// Agent detail reads its recent runs once its status is known, links the Now
// card's run number to that run, and reads them again when the run changes.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/agents/scout' }));
const api = vi.hoisted(() => ({ watch: vi.fn(), runs: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  checkWatch: api.watch,
  auditLog: async () => ({ entries: [] }),
  listRuns: api.runs,
  getDiagnosis: async () => { throw new Error('off'); },
}));
vi.mock('@/lib/control-actors', async (orig) => ({ ...(await orig<typeof import('@/lib/control-actors')>()), fetchControlActors: async () => [] }));
vi.mock('@/components/agent/AgentWeekCard', () => ({ AgentWeekCard: () => null }));
vi.mock('@/components/agent/RulesOnAgent', () => ({ RulesOnAgent: () => null }));
vi.mock('@/components/citadel/PageChrome', async () => {
  const { createElement } = await import('react');
  return { PageHeader: ({ children }: { children?: React.ReactNode }) => createElement('header', null, children), LiveStatus: () => null };
});

import { AgentDetail } from '@/components/agent/AgentDetail';
import { WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { RunSummary } from '@/lib/whiteroom/types';

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const run = (shift: number): RunSummary => ({ runId: `scout~${shift}`, agentId: 'scout', shift, startedAt: '2026-10-24T20:45:00Z', endedAt: '2026-10-24T20:46:00Z', lengthSeconds: 60, calls: 6, failedCalls: 0, blockedCalls: 0, wouldActCalls: 0, spendMicros: 0, unpricedAttempts: 0, coverage: { calls: 6, checked: 6 }, flags: [] });
const idle = (n: number) => ({ status: 'idle', govV1: true, currentShift: null, lastShift: { watchNumber: n, tasksCompleted: 6, tokensUsed: 10, minutesWorked: 1 } });

async function mount(onAuthError = vi.fn()) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(AgentDetail, { fleetId: 'f1', authKey: 'k', agentId: 'scout', from: 'home', onAuthError })); });
  await flush();
  return { el, root };
}

beforeEach(() => { api.watch.mockReset(); api.runs.mockReset(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('Agent detail recent runs', () => {
  it('reads the runs once the status is in, and links the last run from the Now card', async () => {
    api.watch.mockResolvedValue(idle(4));
    api.runs.mockResolvedValue({ runs: [run(4)] });
    const m = await mount();
    expect(api.runs).toHaveBeenCalledTimes(1);
    expect(m.el.querySelector('a[href="/runs/scout~4"]')?.textContent).toBe('#4');
    m.root.unmount();
  });

  it('keeps a plain run number when the runs could not be read, and reads them again when the run changes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    api.watch.mockResolvedValue(idle(4));
    api.runs.mockRejectedValueOnce(new Error('down')).mockResolvedValue({ runs: [run(5), run(4)] });
    const m = await mount();
    expect(m.el.textContent).toContain('Last run #4');
    expect(m.el.querySelector('a[href="/runs/scout~4"]')).toBeNull();
    expect(m.el.textContent).toContain('Couldn’t load recent runs.');
    api.watch.mockResolvedValue(idle(5));
    await act(async () => { vi.advanceTimersByTime(10_500); });
    await flush();
    expect(api.runs).toHaveBeenCalledTimes(2);
    expect(m.el.querySelector('a[href="/runs/scout~5"]')?.textContent).toBe('#5');
    m.root.unmount();
  });

  it('an expired session signs out instead of saying the runs failed', async () => {
    api.watch.mockResolvedValue(idle(4));
    api.runs.mockRejectedValue(new WhiteRoomApiError('Unauthorized', 401));
    const onAuthError = vi.fn();
    const m = await mount(onAuthError);
    expect(onAuthError).toHaveBeenCalledWith('Session expired. Please sign in again.');
    m.root.unmount();
  });
});
