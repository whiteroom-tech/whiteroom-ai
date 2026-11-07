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
const flags = vi.hoisted(() => ({ state: { runs: [] as unknown[], truncated: false, failed: false, loading: false }, count: 0 }));
vi.mock('@/components/performance/UnusualBehaviour', () => ({ useFlaggedRuns: () => flags.state, flaggedRunCount: () => flags.count, UnusualDetails: () => null }));
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

const viewProps = (fleetId = 'f1', onFeedback = async () => 'done' as const) => ({
  data: DATA, hourlyData: { hourly: [] }, auditFailed: false, govSavings: null, govCounts: null, savingsDays: null, agentIds: null,
  rangeLabel: 'last 24 h', fleetId, authKey: 'k', onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback, feedbackLoading: null, feedbackError: null,
});

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(IndexView, viewProps() as never)); });
  await flush();
  return { el, root };
}
const needsYou = (el: HTMLElement) => el.querySelector('.wr-perf-lead')?.textContent ?? null;

afterEach(() => {
  api.list.mockReset();
  document.body.innerHTML = '';
  flags.state = { runs: [], truncated: false, failed: false, loading: false };
  flags.count = 0;
});

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

  async function dismissFromPast(m: { el: HTMLElement }) {
    const past = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Show past recommendations')!;
    await act(async () => { past.click(); });
    await flush();
    const options = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Options')!;
    await act(async () => { options.click(); });
    const dismiss = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!;
    await act(async () => { dismiss.click(); });
    await flush();
  }

  it('hides the line, never a stale count, when that reread fails', async () => {
    for (const fail of [() => Promise.reject(new Error('down')), async () => ({ error: 'nope', recommendations: [], cursor: null, total: 0 })]) {
      api.list.mockReset();
      api.list.mockResolvedValue(reply(1));
      const m = await mount();
      expect(needsYou(m.el)).toContain('1 recommendation ↓');
      api.list.mockImplementation(async (_f: string, opts: { status?: string; pageSize?: number }) => (opts.pageSize === 1 ? fail() : reply(1)));
      await dismissFromPast(m);
      expect(needsYou(m.el)).toBeNull();
      m.root.unmount();
    }
  });

  it('keeps a newer Open list\'s count over a reread that answers late', async () => {
    api.list.mockResolvedValue(reply(1));
    const m = await mount();
    let late!: (v: unknown) => void;
    api.list.mockImplementation((_f: string, opts: { status?: string; pageSize?: number }) =>
      opts.pageSize === 1 ? new Promise((r) => { late = r; }) : Promise.resolve(opts.status === 'open' ? reply(3) : reply(1)));
    await dismissFromPast(m);
    // Back to the Open list: its read lands first, with 3 open.
    const open = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'open')!;
    await act(async () => { open.click(); });
    await flush();
    expect(needsYou(m.el)).toContain('3 recommendations ↓');
    // The older reread answers afterwards: ignored.
    await act(async () => { late(reply(0)); });
    await flush();
    expect(needsYou(m.el)).toContain('3 recommendations ↓');
    m.root.unmount();
  });

  it('hides the line when a later Open read fails', async () => {
    api.list.mockResolvedValue(reply(1));
    const m = await mount();
    expect(needsYou(m.el)).toContain('1 recommendation ↓');
    // Show past, then back to Open: that read fails.
    const past = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Show past recommendations')!;
    await act(async () => { past.click(); });
    await flush();
    api.list.mockRejectedValue(new Error('down'));
    const open = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'open')!;
    await act(async () => { open.click(); });
    await flush();
    expect(needsYou(m.el)).toBeNull();
    m.root.unmount();
  });

  it('forgets the last fleet\'s count when the fleet changes', async () => {
    api.list.mockResolvedValueOnce(reply(1));
    const m = await mount();
    expect(needsYou(m.el)).toContain('1 recommendation ↓');
    let next!: (v: unknown) => void;
    api.list.mockReturnValueOnce(new Promise((r) => { next = r; }));
    await act(async () => { m.root.render(h(IndexView, viewProps('f2') as never)); });
    await flush();
    expect(needsYou(m.el)).toBeNull();
    await act(async () => { next(reply(0)); });
    await flush();
    expect(needsYou(m.el)).toContain('Nothing needs you right now.');
    m.root.unmount();
  });

  it('counts flagged runs too, and says nothing needs you only once they are known', async () => {
    api.list.mockResolvedValue(reply(0));
    flags.count = 2;
    const flagged = await mount();
    expect(needsYou(flagged.el)).toContain('2 runs flagged ↓');
    expect(needsYou(flagged.el)).not.toContain('Nothing needs you');
    flagged.root.unmount();

    flags.count = 0;
    for (const state of [{ loading: true, failed: false }, { loading: false, failed: true }]) {
      flags.state = { runs: [], truncated: false, ...state };
      const unknown = await mount();
      expect(needsYou(unknown.el)).toBeNull();
      unknown.root.unmount();
    }
  });

  it('jumps to, and focuses, what each button names', async () => {
    api.list.mockResolvedValue(reply(1));
    flags.count = 2;
    const m = await mount();
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    const button = (text: string) => [...m.el.querySelectorAll('.wr-perf-lead button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
    await act(async () => { button('recommendation').click(); });
    expect(scrolled.at(-1)).toBe('recommendations');
    expect(document.activeElement?.id).toBe('recommendations-heading');
    await act(async () => { button('flagged').click(); });
    expect(scrolled.at(-1)).toBe('agent-health-heading');
    expect(document.activeElement?.id).toBe('agent-health-heading');
    m.root.unmount();
  });

  it('shows known flagged runs even while the recommendations can\'t be read', async () => {
    api.list.mockRejectedValue(new Error('down'));
    flags.count = 3;
    const m = await mount();
    expect(needsYou(m.el)).toContain('3 runs flagged ↓');
    expect(needsYou(m.el)).not.toContain('recommendation');
    expect(needsYou(m.el)).not.toContain('Nothing needs you');
    m.root.unmount();
  });
});
