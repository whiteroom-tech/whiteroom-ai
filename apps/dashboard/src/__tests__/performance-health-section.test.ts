// @vitest-environment happy-dom
// Performance, mounted: the page's order, and Agent health as its reads land:
// the loading card, the problems-by-agent table, a problem opening its own
// recommendation, and a failed health read said rather than shown as nothing found.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), performanceRecommendationsList: api.list, performanceRecommendationGet: api.get }));
const diag = vi.hoisted(() => ({ data: null as unknown, state: 'unavailable' as string }));
vi.mock('@/lib/diagnosis/useDiagnosis', () => ({ useDiagnosis: () => ({ data: diag.data, state: diag.state, run: 'idle', justRan: false, refresh: async () => {}, checkNow: async () => false }) }));
const DAYS = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
const flags = vi.hoisted(() => ({ state: { runs: [] as unknown[] | null, truncated: false, failed: false, loading: false } }));
vi.mock('@/components/performance/UnusualBehaviour', async (orig) => ({ ...(await orig<typeof import('@/components/performance/UnusualBehaviour')>()), useFlaggedRuns: () => ({ ...flags.state, days: DAYS }) }));
vi.mock('@/app/(citadel)/performance/_components/CostPrediction', () => ({ CostPredictionSection: () => null }));
const { IndexView, REC_OPEN_FAILED } = await import('@/app/(citadel)/performance/_components/IndexView');
const { HEALTH_READ_FAILED } = await import('@/lib/agent-health');

const DATA = {
  fleetId: 'f1', period: { start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' },
  summary: { totalCalls: 1, totalCost: 0, avgLatencyMs: null, errorRate: 0, models: [] },
  recommendations: [], priceInfo: { version: '1', ageDays: 1, stale: false, expired: false },
};
const rec = (id: string, o: object = {}) => ({ id, detector: 'review_cache_behavior', agentId: 'lead-agent', status: 'open', summary: `Summary ${id}.`, createdAt: '2026-10-01T00:00:00Z', feedbackCount: 0, currentFindingId: `pf_${id}`, ...o });
const page = (ids: string[]) => ({ recommendations: ids.map((id) => rec(id)), cursor: null, total: ids.length });
const finding = (recommendationId: string, detector = 'review_tool_errors') => ({ recommendationId, findingId: 'pf', findingVersion: 1, detector, detectorVersion: 1, status: 'open', measures: {}, evidenceCallIds: [] });
const fleet = (findings: unknown[]) => ({
  checkedAt: '2026-10-27T10:00:00Z', source: 'background', truncated: false, readyAgents: 1, busiest: null, minCalls: 50, waiting: [], skipped: [],
  reports: [{ schema: 'diagnosis.v1', agentId: 'lead-agent', window: { from: '', to: '', days: 7, calls: 80, watches: 12 }, findings, clear: [{ detector: 'review_tool_loops', note: null }], notMeasured: [] }],
});
const flaggedRun = (agentId: string) => ({ agentId, startedAt: '2026-10-26T12:00:00', flags: [{ signal: 'repeating_call' }] });
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

const viewProps = (o: object = {}) => ({
  data: DATA, hourlyData: { hourly: [] }, auditFailed: false, govSavings: null, govCounts: null, savingsDays: null, agentIds: null,
  rangeLabel: 'last 24 h', fleetId: 'f1', authKey: 'k', onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback: async () => 'done' as const, feedbackLoading: null, feedbackError: null, ...o,
});

async function mount(o: object = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = (p: object = {}) => act(async () => { root.render(h(IndexView, viewProps({ ...o, ...p }) as never)); });
  await render();
  await flush();
  return { el, root, render };
}
const tag = (el: HTMLElement, title: string) => [...el.querySelectorAll<HTMLButtonElement>('.wr-hba__tag')].find((b) => b.textContent === title)!;
const rows = (el: HTMLElement) => [...el.querySelectorAll('#recommendations article')].map((a) => a.id);
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text);

afterEach(() => {
  api.list.mockReset();
  api.get.mockReset();
  document.body.innerHTML = '';
  flags.state = { runs: [], truncated: false, failed: false, loading: false };
  diag.data = null;
  diag.state = 'unavailable';
});

describe('Performance, mounted', () => {
  it('reads the tiles (cost first), Cost, Agent health with Recommendations, then Rules', async () => {
    api.list.mockResolvedValue(page(['a']));
    diag.data = fleet([finding('a')]); diag.state = 'ready';
    const m = await mount();
    const html = m.el.innerHTML;
    const order = ['wr-perf-strip--5', 'id="perf-cost"', 'id="agent-health-heading"', 'wr-hba__top', 'id="recommendations"', 'wr-hck', 'id="perf-rules"'].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const labels = [...m.el.querySelectorAll('.wr-perf-strip--5 .wr-stat-card')].map((c) => c.firstElementChild?.textContent?.trim().replace(/\s*ⓘ?$/, ''));
    expect(labels.map((l) => l && ['Spend', 'Saved by WhiteRoom', 'Model calls', 'Failed calls', 'Typical response'].find((n) => l.startsWith(n)))).toEqual(['Spend', 'Saved by WhiteRoom', 'Model calls', 'Failed calls', 'Typical response']);
    // The old lead line and section are gone.
    expect(m.el.textContent).not.toContain('Needs you');
    expect(html).not.toContain('perf-reliability');
    m.root.unmount();
  });

  it('holds one loading card until both health reads settle, so the table does not fill in twice', async () => {
    api.list.mockResolvedValue(page([]));
    diag.state = 'pending';
    const m = await mount();
    expect(m.el.textContent).toContain('Loading agent health…');
    expect(m.el.querySelector('.wr-hba__top')).toBeNull();
    // The heading and its anchor are there throughout: the agent page links to it.
    expect(m.el.querySelector('#agent-health-heading')).not.toBeNull();
    diag.state = 'unavailable'; flags.state = { ...flags.state, loading: true };
    await m.render();
    expect(m.el.textContent).toContain('Loading agent health…');
    flags.state = { ...flags.state, loading: false };
    await m.render();
    expect(m.el.textContent).not.toContain('Loading agent health…');
    expect(m.el.textContent).toContain('Nothing unusual in the last 7 days');
    m.root.unmount();
  });

  it('a problem opens its own recommendation: first, marked, and focused, without another read when the list has it', async () => {
    api.list.mockResolvedValue(page(['a', 'b', 'c', 'd', 'e']));
    diag.data = fleet([finding('e', 'review_tool_errors')]); diag.state = 'ready';
    const m = await mount();
    // Five open, three on show: the problem's row is not among them.
    expect(rows(m.el)).toEqual(['rec-a', 'rec-b', 'rec-c']);
    await act(async () => { tag(m.el, 'A tool keeps failing').click(); });
    await flush();
    expect(api.get).not.toHaveBeenCalled();
    expect(rows(m.el)).toEqual(['rec-e', 'rec-a', 'rec-b', 'rec-c']);
    expect(m.el.querySelector('#rec-e')!.textContent).toContain('Opened from the health table');
    expect(document.activeElement?.id).toBe('rec-e');
    m.root.unmount();
  });

  it('reads a recommendation past the loaded page by its id, and shows one that is no longer open with its status', async () => {
    api.list.mockResolvedValue(page(['a', 'b']));
    api.get.mockResolvedValue({ contractVersion: '1', recommendation: rec('far', { status: 'snoozed' }), finding: null });
    diag.data = fleet([finding('far')]); diag.state = 'ready';
    const m = await mount();
    await act(async () => { tag(m.el, 'A tool keeps failing').click(); });
    await flush();
    expect(api.get).toHaveBeenCalledWith('f1', 'far', 'k');
    expect(rows(m.el)).toEqual(['rec-far', 'rec-a', 'rec-b']);
    expect(m.el.querySelector('#rec-far')!.textContent).toContain('snoozed');
    expect(document.activeElement?.id).toBe('rec-far');
    m.root.unmount();
  });

  it('when that read fails or finds nothing, shows the agent’s open ones and says so', async () => {
    for (const answer of [() => Promise.reject(new Error('down')), async () => ({ contractVersion: '1', recommendation: null, finding: null })]) {
      api.list.mockReset(); api.get.mockReset();
      api.list.mockResolvedValue(page(['a']));
      api.get.mockImplementation(answer);
      diag.data = fleet([finding('gone')]); diag.state = 'ready';
      const m = await mount();
      await act(async () => { tag(m.el, 'A tool keeps failing').click(); });
      await flush();
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      await flush();
      expect(m.el.textContent).toContain(REC_OPEN_FAILED);
      expect(api.list.mock.calls.at(-1)![1]).toMatchObject({ status: 'open', agentId: 'lead-agent' });
      expect((m.el.querySelector('input[aria-label="Filter by agent"]') as HTMLInputElement).value).toBe('lead-agent');
      m.root.unmount();
      document.body.innerHTML = '';
    }
  });

  it('drops a recommendation read that answers after the fleet changed', async () => {
    api.list.mockResolvedValue(page(['a']));
    let late!: (v: unknown) => void;
    api.get.mockReturnValue(new Promise((r) => { late = r; }));
    diag.data = fleet([finding('far')]); diag.state = 'ready';
    const m = await mount();
    await act(async () => { tag(m.el, 'A tool keeps failing').click(); });
    await m.render({ fleetId: 'f2' });
    await flush();
    await act(async () => { late({ contractVersion: '1', recommendation: rec('far'), finding: null }); });
    await flush();
    expect(rows(m.el)).not.toContain('rec-far');
    m.root.unmount();
  });

  it('a failed health read says so, keeps the flagged runs, and shows no checks: never an all-clear', async () => {
    api.list.mockResolvedValue(page([]));
    diag.state = 'failed';
    flags.state = { ...flags.state, runs: [flaggedRun('scout')] };
    const m = await mount();
    expect(m.el.textContent).toContain(HEALTH_READ_FAILED);
    expect(m.el.textContent).not.toContain('No issues');
    expect(m.el.textContent).toContain('1 run flagged in the last 7 days');
    expect(m.el.querySelector('.wr-hba__agent')!.textContent).toBe('scout');
    expect(m.el.querySelector('.wr-hck')).toBeNull();
    expect(button(m.el, 'Download report')).toBeDefined();
    m.root.unmount();
  });

  it('with neither source there is only the heading and Recommendations; the report link needs something to report on', async () => {
    api.list.mockResolvedValue(page(['a']));
    flags.state = { ...flags.state, runs: null };
    const m = await mount();
    expect(m.el.querySelector('#agent-health-heading')).not.toBeNull();
    expect(m.el.querySelector('.wr-hba')).toBeNull();
    expect(rows(m.el)).toEqual(['rec-a']);
    expect(button(m.el, 'Download report')).toBeUndefined();
    m.root.unmount();
  });

  it('Show more asks the page to open the list, which then shows every loaded row; a status or filter opens it too', async () => {
    api.list.mockResolvedValue(page(['a', 'b', 'c', 'd']));
    const onRecsExpanded = vi.fn();
    const m = await mount({ onRecsExpanded });
    expect(rows(m.el)).toHaveLength(3);
    await act(async () => { button(m.el, 'Show more')!.click(); });
    expect(onRecsExpanded).toHaveBeenCalledWith(true);
    await m.render({ recsExpanded: true });
    expect(rows(m.el)).toHaveLength(4);
    expect(button(m.el, 'Show more')).toBeUndefined();
    await m.render({ recsExpanded: false });
    expect(rows(m.el)).toHaveLength(3);
    await act(async () => { button(m.el, 'Show past recommendations')!.click(); });
    await flush();
    expect(rows(m.el)).toHaveLength(4);
    m.root.unmount();
  });

  it('links Rules to Runs for the range the page gives it', async () => {
    api.list.mockResolvedValue(page([]));
    const m = await mount({ runsHref: '/runs?show=rules&range=30d' });
    const link = [...m.el.querySelectorAll('a')].find((a) => a.textContent === 'See in Runs →')!;
    expect(link.getAttribute('href')).toBe('/runs?show=rules&range=30d');
    m.root.unmount();
  });
});
