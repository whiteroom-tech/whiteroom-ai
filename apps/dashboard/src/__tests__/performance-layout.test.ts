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

const props = (data: object = DATA, rangeLabel = 'last 24 h') => ({
  data, hourlyData: { hourly: [] }, auditFailed: false, loadedAt: null, govSavings: null, govCounts: { blocks: 2, wouldBlocks: 57, byAgent: {}, byRule: { spend_cap: { blocks: 2, wouldBlocks: 57 } } },
  savingsDays: null, agentIds: null, rangeLabel, fleetId: 'f1', authKey: 'k',
  onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback: async () => 'done', feedbackLoading: null, feedbackError: null,
});
const view = (data: object = DATA, rangeLabel = 'last 24 h') => renderToStaticMarkup(h(IndexView, props(data, rangeLabel) as never));

describe('Performance overview layout', () => {
  it('reads Cost, then Control, then Performance', () => {
    const html = view();
    const order = ['id="perf-cost"', 'id="perf-control"', 'id="perf-performance"'].map((id) => html.indexOf(id));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('opens with one line for the range, and closes with the link to Home → Agents', () => {
    const text = view().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toMatch(/Last 24 h: \$0\.912 spent · rules caught 59 times, 2 blocked · 2 failed calls/);
    expect(text).toContain('Per-agent numbers and scores are on Home → Agents');
  });

  it('puts spend, savings, the hourly cost and smaller context under Cost, and rule activity under Control', () => {
    const html = view();
    const cost = html.slice(html.indexOf('id="perf-cost"'), html.indexOf('id="perf-control"'));
    for (const label of ['Spend', 'Saved by WhiteRoom', 'Hourly cost', 'Smaller context']) expect(cost).toContain(`>${label}<`);
    expect(cost).not.toContain('Average per hour');
    expect(cost).toContain('$0.912');
    expect(cost).toContain('99 model calls');
    expect(cost).toContain('Spend by model');
    const control = html.slice(html.indexOf('id="perf-control"'), html.indexOf('id="perf-performance"'));
    expect(control).toContain('Rule activity');
    expect(control).toMatch(/2<\/strong> blocked · <strong[^>]*>57<\/strong> would have acted/);
    expect(control).toContain('All rules and agents');
    expect(control).toContain('href="/controls"');
    const perf = html.slice(html.indexOf('id="perf-performance"'));
    for (const label of ['Failed calls', 'Typical response', 'Model calls']) expect(perf).toContain(`>${label}<`);
  });

  it('works out the card figures: the working-hour rate, trends against the prior window, and the typical response', () => {
    const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const withPrev = text(renderToStaticMarkup(h(IndexView, {
      ...props(), data: { ...DATA, previous: { period: { start: '', end: '' }, totalCalls: 33, totalCost: 456_000, pricedAttempts: 33, unpricedAttempts: 0, avgLatencyMs: 3800 } },
      workingHour: { usdPerHour: 0.354, lookbackHours: 336 }, rangeUsedTokens: 1_740_000, govSavings: { tokensSaved: 3_180_000, costSaved: 2.34, partial: false },
    } as never)));
    expect(withPrev).toMatch(/Hourly cost .*\$0\.354 an hour while agents work · last 14 days/);
    expect(withPrev).toMatch(/Model calls .*99 ↑ 200% vs prior 24 h/);
    expect(withPrev).toMatch(/Typical response .*1\.9s ↓ 50% faster vs prior 24 h/);
    expect(withPrev).toMatch(/3\.18M fewer tokens · about 65% less · estimated/);
    // No prior window (older engine): the plain lines.
    const plain = text(view());
    expect(plain).toMatch(/Typical response .*1\.9s median time per call/);
    // Unpriced calls make spend a lower bound ("+").
    expect(text(view({ ...DATA, summary: { ...DATA.summary, unpricedAttempts: 3 } }))).toMatch(/\$0\.912\+/);
  });
});

describe('Performance overview, what it leaves out', () => {
  // With data that would fill them (several agents, hourly rows, models), so this can't pass on empty markup.
  it('has no More detail toggle, Calls per hour chart or By agent table, but does show its sections', () => {
    const html = renderToStaticMarkup(h(IndexView, {
      data: DATA, hourlyData: { hourly: Array.from({ length: 48 }, (_, i) => ({ hour: new Date(Date.UTC(2026, 9, 25, i)).toISOString(), calls: 4, costMicros: 19_000, errors: 0 })) },
      auditFailed: false, loadedAt: null, govSavings: null, govCounts: { blocks: 2, wouldBlocks: 57, byAgent: { 'lead-agent': { blocks: 2, wouldBlocks: 0 }, writer: { blocks: 0, wouldBlocks: 57 } }, byRule: {} },
      savingsDays: null, agentIds: ['lead-agent', 'writer'], rangeLabel: 'last 24 h', fleetId: 'f1', authKey: 'k',
      onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback: async () => 'done', feedbackLoading: null, feedbackError: null,
    } as never));
    expect(html).toContain('id="perf-performance"');
    expect(html).toContain('>Spend<');
    expect(html).not.toContain('More detail');
    expect(html).not.toContain('Calls per hour');
    expect(html).not.toContain('By agent');
  });
});

describe('Smaller context card', () => {
  it('shows the ratio over all time, nothing saved as —, and unknown as — never 0', () => {
    expect(smallerContextCard(90.84)).toEqual({ value: '90.8%', sub: 'less sent to models, on average · all time' });
    expect(smallerContextCard(0)).toEqual({ value: '—', sub: 'nothing saved yet' });
    expect(smallerContextCard(null)).toEqual({ value: '—', sub: 'not available yet' });
  });
});
