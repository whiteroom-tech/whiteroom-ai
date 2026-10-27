// Performance's overview, rendered to HTML: Cost, then a read-only Control
// summary, then Performance, with the figures each card works out.
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { IndexView, smallerContextCard } = await import('@/app/(citadel)/performance/_components/IndexView');

const DATA = {
  fleetId: 'f1',
  period: { start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' },
  summary: { totalCalls: 99, totalCost: 912_000, avgLatencyMs: 1900, errorRate: 0.02, blockedCount: 2, models: [{ model: 'claude-haiku-4-5', calls: 99, costMicros: 912_000, inputTokens: 1, outputTokens: 1 }] },
  recommendations: [],
  priceInfo: { version: '1', ageDays: 1, stale: false, expired: false },
};

const view = (data: object = DATA, rangeLabel = 'last 24 h') => renderToStaticMarkup(h(IndexView, {
  data, hourlyData: { hourly: [] }, auditFailed: false, loadedAt: null, govSavings: null, govCounts: { blocks: 2, wouldBlocks: 57, byAgent: {}, byRule: {} },
  savingsDays: null, agentIds: null, rangeLabel, fleetId: 'f1', authKey: 'k',
  onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback: async () => 'done', feedbackLoading: null, feedbackError: null,
} as never));

describe('Performance overview layout', () => {
  it('reads Cost, then Control, then Performance', () => {
    const html = view();
    const order = ['id="perf-cost"', 'id="perf-control"', 'id="perf-performance"'].map((id) => html.indexOf(id));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('puts spend, savings, the hourly rate and smaller context under Cost, and rule activity under Control', () => {
    const html = view();
    const cost = html.slice(html.indexOf('id="perf-cost"'), html.indexOf('id="perf-control"'));
    for (const label of ['Spend', 'Saved by WhiteRoom', 'Hourly', 'Smaller context']) expect(cost).toContain(`>${label}<`);
    expect(cost).toContain('$0.912');
    const control = html.slice(html.indexOf('id="perf-control"'), html.indexOf('id="perf-performance"'));
    expect(control).toContain('Rule activity');
    expect(control).toContain('2 blocked · 57 in Record only');
    expect(control).toContain('href="/controls"');
    const perf = html.slice(html.indexOf('id="perf-performance"'));
    expect(perf).toContain('Failed calls');
    expect(perf).toContain('Typical response');
  });

  it('works out the card figures: spend, spend per hour over the range, and the typical response', () => {
    const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    // $2.40 over 24 hours is $0.100 an hour; the sub-line is the range when nothing makes it inexact.
    const exact = text(view({ ...DATA, summary: { ...DATA.summary, totalCost: 2_400_000 } }, 'last 24 hours'));
    expect(exact).toMatch(/Spend .*\$2\.40 last 24 hours/);
    expect(exact).toMatch(/Hourly .*\$0\.100 spend per hour/);
    expect(exact).toMatch(/Typical response .*1\.9s median time per call/);
    // Unpriced calls make both a lower bound ("+"), and the Spend sub-line says why.
    const partial = text(view({ ...DATA, summary: { ...DATA.summary, totalCost: 2_400_000, unpricedAttempts: 3 } }, 'last 24 hours'));
    expect(partial).toMatch(/\$2\.40\+/);
    expect(partial).toMatch(/\$0\.100\+/);
    expect(partial).not.toMatch(/\$2\.40\+ last 24 hours/);
  });
});

describe('Smaller context card', () => {
  it('shows the ratio over all time, nothing saved as —, and unknown as — never 0', () => {
    expect(smallerContextCard(90.84)).toEqual({ value: '90.8%', sub: 'smaller than full history, all time' });
    expect(smallerContextCard(0)).toEqual({ value: '—', sub: 'nothing saved yet' });
    expect(smallerContextCard(null)).toEqual({ value: '—', sub: 'not available yet' });
  });
});
