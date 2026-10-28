// Performance's overview, rendered to HTML: Cost, then a read-only Control
// summary, then Performance, with the figures each card works out.
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { IndexView } = await import('@/app/(citadel)/performance/_components/IndexView');
const { noCallsWhen } = await import('@/components/performance/SavingsPanels');

const DATA = {
  fleetId: 'f1',
  period: { start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' },
  summary: { totalCalls: 99, totalCost: 912_000, avgLatencyMs: 1900, errorRate: 0.02, blockedCount: 2, models: [{ model: 'claude-haiku-4-5', calls: 99, costMicros: 912_000, inputTokens: 1, outputTokens: 1 }] },
  recommendations: [],
  priceInfo: { version: '1', ageDays: 1, stale: false, expired: false },
};

const props = (data: object = DATA, rangeLabel = 'last 24 h') => ({
  data, hourlyData: { hourly: [] }, auditFailed: false, govSavings: null, govCounts: { blocks: 2, wouldBlocks: 57, byAgent: {}, byRule: { spend_cap: { blocks: 2, wouldBlocks: 57 } } },
  savingsDays: null, agentIds: null, rangeLabel, fleetId: 'f1', authKey: 'k',
  onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback: async () => 'done', feedbackLoading: null, feedbackError: null,
});
const view = (data: object = DATA, rangeLabel = 'last 24 h') => renderToStaticMarkup(h(IndexView, props(data, rangeLabel) as never));
/** 48 hourly rows (the range's 24 and the 24 before), the range's carrying `input` tokens in all: plain, cache read, cache write. */
const rangeHours = (input: number, start = Date.UTC(2026, 9, 25)) => ({ hourly: Array.from({ length: 48 }, (_, i) => {
  const each = i >= 24 ? input / 24 : 0;
  return { hour: new Date(start + i * 3_600_000).toISOString(), calls: 1, costMicros: 0, errorCount: 0, inputTokens: each / 2, outputTokens: 999_999, cacheReadTokens: each / 4, cacheWriteTokens: each / 4 };
}) });

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

  it('puts spend, savings and smaller context under Cost (hourly cost is in Cost prediction), and rule activity under Control', () => {
    const html = view();
    const cost = html.slice(html.indexOf('id="perf-cost"'), html.indexOf('id="perf-control"'));
    for (const label of ['Spend', 'Saved by WhiteRoom', 'Smaller context']) expect(cost).toContain(`>${label}<`);
    expect(cost).not.toContain('>Hourly cost<');
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

  it('works out the figures: the fleet hourly cost, trends against the prior window, and the typical response', () => {
    const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const withPrev = text(renderToStaticMarkup(h(IndexView, {
      ...props(), data: { ...DATA, previous: { period: { start: '', end: '' }, totalCalls: 33, totalCost: 456_000, pricedAttempts: 33, unpricedAttempts: 0, avgLatencyMs: 3800 } },
      workingHour: { usdPerHour: 0.354, lookbackHours: 336 }, hourlyData: rangeHours(1_740_000), govSavings: { tokensSaved: 3_180_000, costSaved: 2.34, partial: false },
    } as never)));
    // The fleet's hourly cost sits on Cost prediction's folded row; each agent's own is inside it.
    expect(withPrev).toMatch(/Cost prediction \$0\.354 an hour while agents work, last 14 days/);
    expect(withPrev).toMatch(/Model calls .*99 ↑ 200% vs prior 24 h/);
    expect(withPrev).toMatch(/Typical response .*1\.9s ↓ 50% faster vs prior 24 h/);
    // Every Cost figure follows the range: Saved says what its dollars are, Smaller context has the range's tokens.
    expect(withPrev).toMatch(/Saved by WhiteRoom \$2\.34 estimated, at your model prices/);
    // Input against input: output tokens (999,999 an hour here) aren't counted.
    expect(withPrev).toMatch(/Smaller context 65% less input sent to models · 3\.18M fewer input tokens · ≈1\.3 kWh saved/);
    expect(withPrev).not.toMatch(/all time/);
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
      auditFailed: false, govSavings: null, govCounts: { blocks: 2, wouldBlocks: 57, byAgent: { 'lead-agent': { blocks: 2, wouldBlocks: 0 }, writer: { blocks: 0, wouldBlocks: 57 } }, byRule: {} },
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
  const text = (p: Record<string, unknown>) => renderToStaticMarkup(h(IndexView, { ...props(), ...p } as never)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  it('follows the picked range, input against input, and so do the with-vs-without totals', () => {
    // The 7 calendar days hold more than the picked range: the card and the totals show the range.
    const t = text({
      savingsDays: [{ day: '2026-10-26', used: 0, saved: 9_000_000 }, { day: '2026-10-27', used: 0, saved: 0 }],
      hourlyData: rangeHours(1_000_000), govSavings: { tokensSaved: 3_000_000, costSaved: 1, partial: false },
    });
    expect(t).toMatch(/Smaller context 75% less input sent to models · 3M fewer input tokens/);
    expect(t).toMatch(/Input tokens: with WhiteRoom vs without .* last 24 h/);
    expect(t).toMatch(/3M fewer tokens · about 75% less/);
  });
  it('draws By day from the week\'s input per day, and keeps it when the picked range has no calls', () => {
    const week = [{ day: '2026-10-26', used: 0, saved: 3_000_000 }, { day: '2026-10-27', used: 0, saved: 0 }];
    const weekHourly = { hourly: [{ hour: new Date(2026, 9, 26, 12).toISOString(), calls: 1, costMicros: 0, errorCount: 0, inputTokens: 1_000_000, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }] };
    const quiet = text({ savingsDays: week, weekHourly, hourlyData: rangeHours(0), govSavings: { tokensSaved: 0, costSaved: 0, partial: false } });
    expect(quiet).toMatch(/No model calls in the last 24 h/);
    expect(quiet).toMatch(/By day last 7 days/);
    // No range read: the totals are the 7 days' input, labelled so.
    const fallback = text({ savingsDays: week, weekHourly, hourlyData: null });
    expect(fallback).toMatch(/Input tokens: with WhiteRoom vs without .* last 7 days/);
    expect(fallback).toMatch(/3M fewer tokens · about 75% less/);
    // Without the week's input by hour, By day isn't drawn (it can't say input per day).
    expect(text({ savingsDays: week, hourlyData: rangeHours(1_000_000), govSavings: { tokensSaved: 3_000_000, costSaved: 1, partial: false } })).not.toMatch(/By day/);
  });
  it('says it is unknown, never 0, when the tokens used are unknown, and why when the savings failed to load', () => {
    expect(text({ savingsDays: null, hourlyData: null, govSavings: { tokensSaved: 5, costSaved: 0, partial: false } })).toMatch(/Smaller context — not available yet/);
    expect(text({ auditFailed: true })).toMatch(/Smaller context — couldn’t load, retrying on the next refresh/);
  });
});

describe('Input tokens empty state', () => {
  it('reads the range naturally', () => {
    expect(noCallsWhen('today')).toBe('today');
    expect(noCallsWhen('last 7 days')).toBe('in the last 7 days');
    expect(noCallsWhen('Oct 1 – Oct 10')).toBe('from Oct 1 – Oct 10');
  });
});
