// @vitest-environment happy-dom
// Run page on an engine without run totals (before engine PR 298): the summary
// line takes the run's row from list_runs, looked up once, not on every poll.
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunEventsResult } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const now = new Date().toISOString();
const api = vi.hoisted(() => ({ events: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), getRunEvents: api.events, listRuns: api.list }));

const { RunDetail } = await import('@/components/runs/RunDetail');
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

describe('run page totals fallback', () => {
  it('fills the summary from the runs list once, and keeps it across polls', async () => {
    // A fresh run object on every load, as a poll returns.
    api.events.mockImplementation(async (): Promise<RunEventsResult> => ({
      fleetId: 'f1', run: { runId: 'a~4', agentId: 'a', shift: 4, startedAt: now, endedAt: now }, events: [], page: 0, pages: 1, total: 0, eventFound: null,
    }));
    api.list.mockResolvedValue({ runs: [{ runId: 'a~4', agentId: 'a', shift: 4, startedAt: now, endedAt: now, lengthSeconds: 24, calls: 6, failedCalls: 0, blockedCalls: 0, spendMicros: 50_000, unpricedAttempts: 0, coverage: { calls: 6, checked: 6 }, wouldActCalls: 6 }], total: 1, cursor: null });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(RunDetail, { fleetId: 'f1', runId: 'a~4' })); });
    await flush();
    expect(el.querySelector('.wr-run-summary')?.textContent).toContain('6 model calls · $0.05 · 0 failed · 6 would have blocked');
    // Another load (Events only) brings a new run object: no second lookup.
    const events = [...el.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Events only') as HTMLElement;
    await act(async () => { events.click(); });
    await flush();
    expect(api.events.mock.calls.length).toBeGreaterThan(1);
    expect(api.list).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    el.remove();
  });
});
