// Performance's overview, rendered to HTML: what needs you, Cost, a read-only
// Rules line, Reliability, then Recommendations, with the figures each card works out.
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { IndexView } = await import('@/app/(citadel)/performance/_components/IndexView');
const { inRange } = await import('@/lib/performance-overview');

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
  it('reads Cost, then Rules, then Reliability, then Recommendations', () => {
    const html = view();
    const order = ['id="perf-cost"', 'id="perf-rules"', 'id="perf-reliability"', 'id="recommendations"'].map((id) => html.indexOf(id));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('says nothing about what needs you until the recommendations load, and closes with the link to Home → Agents', () => {
    const text = view().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    // The figures aren't repeated above the cards; the open count arrives after the first render.
    expect(text).not.toMatch(/Needs you/);
    expect(text).not.toMatch(/spent ·/);
    expect(text).toContain('Per-agent numbers and scores are on Home → Agents');
  });

  it('puts spend, savings and less input sent under Cost (hourly cost is in Cost prediction), and one rules line under Rules', () => {
    const html = view();
    const cost = html.slice(html.indexOf('id="perf-cost"'), html.indexOf('id="perf-rules"'));
    for (const label of ['Spend', 'Saved by WhiteRoom', 'Less input sent']) expect(cost).toContain(`>${label}<`);
    expect(cost).not.toContain('>Hourly cost<');
    expect(cost).not.toContain('Average per hour');
    expect(cost).toContain('$0.912');
    // Calls are Reliability's card: not repeated under Spend.
    expect(cost).not.toContain('99 model calls');
    expect(cost).toContain('Spend by model');
    const control = html.slice(html.indexOf('id="perf-rules"'), html.indexOf('id="perf-reliability"'));
    expect(control).toMatch(/2<\/strong> blocked · <strong[^>]*>57<\/strong> would have acted/);
    expect(control).toContain('What your rules caught most');
    // Each rule is in Controls and each agent's activity on Home: no table here.
    expect(control).not.toContain('All rules and agents');
    expect(control).not.toContain('Suggestions in Controls');
    expect(control).toContain('href="/controls"');
    const perf = html.slice(html.indexOf('id="perf-reliability"'));
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
    // Calls in calls, spend in percent.
    expect(withPrev).toMatch(/Model calls .*99 \+66 vs prior 24 h/);
    expect(withPrev).toMatch(/Spend .*\$0\.912 ↑ 100% vs prior 24 h/);
    expect(withPrev).toMatch(/Typical response .*1\.9s ↓ 50% faster vs prior 24 h/);
    // Every Cost figure follows the range: Saved says what its dollars are, Less input sent has the range's tokens.
    expect(withPrev).toMatch(/Saved by WhiteRoom \$2\.34 estimated, at your model prices/);
    // Input against input: output tokens (999,999 an hour here) aren't counted.
    expect(withPrev).toMatch(/Less input sent 65% 3\.18M fewer input tokens/);
    expect(withPrev).not.toMatch(/all time/);
    // No prior window (older engine): the plain lines.
    const plain = text(view());
    expect(plain).toMatch(/Typical response .*1\.9s median time per call/);
    expect(plain).toMatch(/Spend .*\$0\.912 last 24 h/);
    // Nothing spent before: no percent to show, so it says so.
    const fromNothing = text(view({ ...DATA, previous: { period: { start: '', end: '' }, totalCalls: 0, totalCost: 0, pricedAttempts: 0, unpricedAttempts: 0, avgLatencyMs: null } }));
    expect(fromNothing).toMatch(/Spend .*\$0\.912 nothing spent in the prior 24 h/);
    const quiet = { ...DATA, summary: { ...DATA.summary, totalCost: 0 } };
    const prior = (cost: number) => ({ period: { start: '', end: '' }, totalCalls: 0, totalCost: cost, pricedAttempts: 0, unpricedAttempts: 0, avgLatencyMs: null });
    // Nothing spent in either: it doesn't suggest this range had spend.
    expect(text(view({ ...quiet, previous: prior(0) }))).toMatch(/Spend .*\$0\.00 none in the prior 24 h either/);
    // Spent before, nothing now: the drop.
    expect(text(view({ ...quiet, previous: prior(500_000) }))).toMatch(/Spend .*\$0\.00 ↓ 100% vs prior 24 h/);
    // Unpriced calls make spend a lower bound ("+").
    expect(text(view({ ...DATA, summary: { ...DATA.summary, unpricedAttempts: 3 } }))).toMatch(/\$0\.912\+/);
  });

  it('counts calls from agents without a name when there are any, and sums Saved from the per-day figures billing uses', () => {
    const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text(view({ ...DATA, summary: { ...DATA.summary, unnamedCalls: 12 } }))).toMatch(/12 calls in the last 24 h came from agents without a name/);
    expect(text(view({ ...DATA, summary: { ...DATA.summary, unnamedCalls: 1 } }, 'Sat, Oct 24'))).toMatch(/1 call on Sat, Oct 24 came from/);
    expect(text(view())).not.toMatch(/without a name/);
    const saved = text(renderToStaticMarkup(h(IndexView, { ...props(), govSavings: { tokensSaved: 10, costSaved: 1, partial: false }, cacheSaved: { micros: 500_000, unpricedReadTokens: 0 } } as never)));
    expect(saved).toMatch(/Saved by WhiteRoom \$1\.50/);
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
    expect(html).toContain('id="perf-reliability"');
    expect(html).toContain('>Spend<');
    expect(html).not.toContain('More detail');
    expect(html).not.toContain('Calls per hour');
    expect(html).not.toContain('By agent');
  });
});

describe('Less input sent card', () => {
  const text = (p: Record<string, unknown>) => renderToStaticMarkup(h(IndexView, { ...props(), ...p } as never)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  it('follows the picked range, input against input, and so do the with-vs-without totals', () => {
    // The 7 calendar days hold more than the picked range: the card and the totals show the range.
    const t = text({
      savingsDays: [{ day: '2026-10-26', used: 0, saved: 9_000_000 }, { day: '2026-10-27', used: 0, saved: 0 }],
      hourlyData: rangeHours(1_000_000), govSavings: { tokensSaved: 3_000_000, costSaved: 1, partial: false },
    });
    expect(t).toMatch(/Less input sent 75% 3M fewer input tokens/);
    expect(t).toMatch(/See how it adds up 4M without · 1M with/);
  });
  it('draws By day from the week\'s input per day, and keeps it when the picked range has no calls', () => {
    const week = [{ day: '2026-10-26', used: 0, saved: 3_000_000 }, { day: '2026-10-27', used: 0, saved: 0 }];
    const weekHourly = { hourly: [{ hour: new Date(2026, 9, 26, 12).toISOString(), calls: 1, costMicros: 0, errorCount: 0, inputTokens: 1_000_000, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }] };
    // Closed, its row says the days are inside; nothing else renders until it opens.
    const quiet = text({ savingsDays: week, weekHourly, hourlyData: rangeHours(0), govSavings: { tokensSaved: 0, costSaved: 0, partial: false } });
    expect(quiet).toMatch(/See how it adds up by day/);
    // No range read: the totals are the 7 days' input.
    const fallback = text({ savingsDays: week, weekHourly, hourlyData: null });
    expect(fallback).toMatch(/See how it adds up 4M without · 1M with · by day/);
    // Without the week's input by hour, By day isn't drawn (it can't say input per day).
    expect(text({ savingsDays: week, hourlyData: rangeHours(1_000_000), govSavings: { tokensSaved: 3_000_000, costSaved: 1, partial: false } })).not.toMatch(/By day/);
  });
  it('says it is unknown, never 0, when the tokens used are unknown, and why when the savings failed to load', () => {
    expect(text({ savingsDays: null, hourlyData: null, govSavings: { tokensSaved: 5, costSaved: 0, partial: false } })).toMatch(/Less input sent — not available yet/);
    expect(text({ auditFailed: true })).toMatch(/Less input sent — couldn’t load, retrying on the next refresh/);
  });
});

describe('Input tokens empty state', () => {
  it('reads the range naturally', () => {
    expect(inRange('today')).toBe('today');
    expect(inRange('last 7 days')).toBe('in the last 7 days');
    expect(inRange('last 30 days')).toBe('in the last 30 days');
    expect(inRange('Oct 1 – Oct 10')).toBe('between Oct 1 – Oct 10');
    expect(inRange('Sat, Oct 24')).toBe('on Sat, Oct 24');
  });
  it('says it in the panel when the range had no calls', async () => {
    const { TokensCompare } = await import('@/components/performance/SavingsPanels');
    const html = renderToStaticMarkup(h(TokensCompare, { days: null, range: { used: 0, saved: 0, label: 'today' }, defaultOpen: true }));
    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain('No model calls today.');
  });
});

describe('Rules line', () => {
  // The Rules section only: Recommendations below has its own loading line.
  const rules = (p: Record<string, unknown>) => {
    const html = renderToStaticMarkup(h(IndexView, { ...props(), ...p } as never));
    return html.slice(html.indexOf('id="perf-rules"'), html.indexOf('id="perf-reliability"')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  };
  it('says the counts couldn’t load after a failed read, and is loading before the first', () => {
    expect(rules({ govCounts: null, auditFailed: true })).toMatch(/Rule activity couldn’t load, retrying on the next refresh/);
    expect(rules({ govCounts: null, auditFailed: true })).not.toMatch(/Loading…/);
    expect(rules({ govCounts: null, auditFailed: false })).toMatch(/Rules What your rules caught\. .*Loading…/);
  });
  it('says nothing was caught on the folded row when no rule acted', () => {
    expect(rules({ govCounts: { blocks: 0, wouldBlocks: 0, byAgent: {}, byRule: {} } })).toMatch(/What your rules caught most nothing caught in this range/);
  });
});

