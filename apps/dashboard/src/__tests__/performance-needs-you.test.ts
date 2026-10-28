// @vitest-environment happy-dom
// Performance › Needs you: the open recommendation count once it's known, kept
// right after feedback while another list is showing, and never "nothing"
// before the first read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), performanceRecommendationsList: api.list }));
// The page's other reads aren't what this tests.
vi.mock('@/lib/diagnosis/useDiagnosis', () => ({ useDiagnosis: () => ({ data: null, run: null, justRan: false, refresh: async () => {}, checkNow: async () => false }) }));
vi.mock('@/components/performance/UnusualBehaviour', () => ({ useFlaggedRuns: () => ({ runs: [], truncated: false, failed: false, loading: false }), flaggedRunCount: () => 0, UnusualDetails: () => null }));
vi.mock('@/app/(citadel)/performance/_components/CostPrediction', () => ({ CostPredictionSection: () => null }));
const { IndexView } = await import('@/app/(citadel)/performance/_components/IndexView');

const DATA = {
  fleetId: 'f1', period: { start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' },
  summary: { totalCalls: 1, totalCost: 0, avgLatencyMs: null, errorRate: 0, models: [] },
  recommendations: [], priceInfo: { version: '1', ageDays: 1, stale: false, expired: false },
};
const REC = { id: 'rec1', detector: 'review_cache_behavior', agentId: 'a', status: 'open', summary: 'x', createdAt: '2026-10-01T00:00:00Z', feedbackCount: 0, currentFindingId: 'f1' };
const reply = (total: number) => ({ recommendations: total ? [REC] : [], cursor: null, total });
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

async function mount(onFeedback = async () => 'done' as const) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(h(IndexView, {
      data: DATA, hourlyData: { hourly: [] }, auditFailed: false, govSavings: null, govCounts: null, savingsDays: null, agentIds: null,
      rangeLabel: 'last 24 h', fleetId: 'f1', authKey: 'k', onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback, feedbackLoading: null, feedbackError: null,
    } as never));
  });
  await flush();
  return { el, root };
}
const needsYou = (el: HTMLElement) => el.querySelector('.wr-perf-lead')?.textContent ?? null;

afterEach(() => { api.list.mockReset(); document.body.innerHTML = ''; });

describe('Needs you', () => {
  it('says nothing until the open list is read, then the count or that nothing does', async () => {
    let resolve!: (v: unknown) => void;
    api.list.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const m = await mount();
    expect(needsYou(m.el)).toBeNull();
    await act(async () => { resolve(reply(2)); });
    await flush();
    expect(needsYou(m.el)).toContain('2 recommendations ↓');
    m.root.unmount();

    api.list.mockResolvedValueOnce(reply(0));
    const none = await mount();
    expect(needsYou(none.el)).toContain('Nothing needs you right now.');
    none.root.unmount();
  });

  it('rereads the open count after feedback while past recommendations are showing', async () => {
    api.list.mockResolvedValue(reply(1));
    const m = await mount();
    expect(needsYou(m.el)).toContain('1 recommendation ↓');
    // Show past recommendations: the list is now every status.
    const past = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Show past recommendations')!;
    await act(async () => { past.click(); });
    await flush();
    // Dismiss from that list: the open count is read on its own.
    api.list.mockImplementation(async (_f: string, opts: { status?: string }) => (opts.status === 'open' ? reply(0) : reply(1)));
    const options = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Options')!;
    await act(async () => { options.click(); });
    const dismiss = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!;
    await act(async () => { dismiss.click(); });
    await flush();
    expect(api.list).toHaveBeenCalledWith('f1', { status: 'open', pageSize: 1 }, 'k');
    expect(needsYou(m.el)).toContain('Nothing needs you right now.');
    m.root.unmount();
  });
});
