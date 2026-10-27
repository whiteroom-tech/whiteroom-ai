// @vitest-environment happy-dom
// Performance › Smaller context in a DOM (effects run): it reads the fleet
// report, reads again on each page refresh, keeps the last figure if a read
// fails, and starts over for another fleet.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
const api = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  fleetReport: api.report,
  performanceRecommendationsList: async () => ({ recommendations: [], total: 0, cursor: null }),
}));
vi.mock('@/lib/diagnosis/useDiagnosis', () => ({ useDiagnosis: () => ({ data: null, run: null, justRan: false, checkNow: async () => false }) }));
vi.mock('@/components/performance/UnusualBehaviour', async (orig) => ({ ...(await orig<typeof import('@/components/performance/UnusualBehaviour')>()), useFlaggedRuns: () => ({ runs: [], truncated: false, failed: false, loading: false, days: [] }) }));
vi.mock('@/app/(citadel)/performance/_components/CostPrediction', () => ({ CostPredictionSection: () => null }));

const { IndexView } = await import('@/app/(citadel)/performance/_components/IndexView');
const DATA = { fleetId: 'f1', period: { start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' }, summary: { totalCalls: 1, totalCost: 0, avgLatencyMs: 1, errorRate: 0, models: [] }, recommendations: [], priceInfo: { version: '1', ageDays: 1, stale: false, expired: false } };
const props = (fleetId: string, loadedAt: number, authKey = 'k') => ({
  data: DATA, hourlyData: { hourly: [] }, auditFailed: false, loadedAt, govSavings: null, govCounts: null, savingsDays: null, agentIds: null, rangeLabel: 'last 24 h',
  fleetId, authKey, onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback: async () => 'done', feedbackLoading: null, feedbackError: null,
} as never);
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const card = (el: HTMLElement) => [...el.querySelectorAll('.wr-stat-card')].find((c) => c.textContent?.startsWith('Smaller context'))!.textContent ?? '';

beforeEach(() => api.report.mockReset());

describe('Smaller context on Performance', () => {
  it('reads the report, again on refresh, keeps the last figure on a failed read, and starts over for another fleet', async () => {
    api.report.mockResolvedValue({ energySavings: { compressionRatio: 90.8 } });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(IndexView, props('f1', 1))); });
    await flush();
    expect(card(el)).toContain('90.8%');
    // A page refresh reads again; this read fails, so the last figure stays.
    api.report.mockRejectedValueOnce(new Error('down'));
    await act(async () => { root.render(h(IndexView, props('f1', 2))); });
    await flush();
    expect(api.report).toHaveBeenCalledTimes(2);
    expect(card(el)).toContain('90.8%');
    // Another fleet starts over; a report without the figure is unknown, never 0.
    api.report.mockResolvedValueOnce({ energySavings: {} });
    await act(async () => { root.render(h(IndexView, props('f2', 3))); });
    await flush();
    expect(card(el)).toContain('not available yet');
    expect(card(el)).not.toContain('90.8%');
    root.unmount();
  });

  it('reads once while a read is in flight, and drops a late answer for a fleet no longer shown', async () => {
    let answerF1!: (v: unknown) => void;
    api.report.mockImplementationOnce(() => new Promise((r) => { answerF1 = r; }));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    // A cached page, then the fresh one, while the first read is still out: one read.
    await act(async () => { root.render(h(IndexView, props('f1', 1))); });
    await act(async () => { root.render(h(IndexView, props('f1', 2))); });
    expect(api.report).toHaveBeenCalledTimes(1);
    // Switch fleets; f2 answers first, then f1's late answer arrives and is dropped.
    api.report.mockResolvedValueOnce({ energySavings: { compressionRatio: 40 } });
    await act(async () => { root.render(h(IndexView, props('f2', 3))); });
    await flush();
    await act(async () => { answerF1({ energySavings: { compressionRatio: 90.8 } }); });
    await flush();
    expect(card(el)).toContain('40.0%');
    root.unmount();
  });

  it('drops a late answer read with a key that is no longer current', async () => {
    let answerOld!: (v: unknown) => void;
    api.report.mockImplementationOnce(() => new Promise((r) => { answerOld = r; }));
    api.report.mockResolvedValueOnce({ energySavings: { compressionRatio: 40 } });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(IndexView, props('f1', 1, 'old'))); });
    await act(async () => { root.render(h(IndexView, props('f1', 1, 'new'))); });
    await flush();
    await act(async () => { answerOld({ energySavings: { compressionRatio: 90.8 } }); });
    await flush();
    expect(card(el)).toContain('40.0%');
    root.unmount();
  });
});
