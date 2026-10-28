// Performance overview wording (mockup parity): trends, savings, Control's
// figures and Agent health's checks grouped by check.
import { describe, expect, it } from 'vitest';
import type { FleetDiagnosis, GovernanceRule } from '@/lib/whiteroom/types';
import type { GovernanceCounts } from '@/lib/governance';
import {
  checkGroups, fewerTokens, lookbackText, healthCounts, healthHeadline, latencyTrend, modelShares, pctChange, perCallTrend, pricesFrom, priorLabel,
  inputByLocalDay, inputTokensOf, predictionNote, rangeHoldsWeek, WEEK_HOURS, weekHourlyFrom, rangeContextCard, ruleAgentRows, ruleModeCounts, rulesCaughtText, ruleTypeRows, savedCaption, tokenTotals, topCaught, trendText,
} from '@/lib/performance-overview';

const t = (blocks: number, wouldBlocks: number) => ({ blocks, wouldBlocks });
const COUNTS: GovernanceCounts = {
  blocks: 1, wouldBlocks: 120,
  byRule: { spend_cap: t(0, 59), loop_breaker: t(1, 0), model_allowlist: t(0, 60), tool_list: t(0, 0), call_rate: t(0, 0), keyword: t(0, 1) },
  byAgent: { 'code-reviewer': t(0, 60), 'lead-agent': t(1, 59), '': t(0, 1), quiet: t(0, 0) },
};
const rule = (id: string, ruleType: GovernanceRule['ruleType'], mode: GovernanceRule['mode'], params: object) => ({ id, ruleType, mode, params, appliesTo: 'all' }) as unknown as GovernanceRule;
const RULES = [
  rule('gr_lb', 'loop_breaker', 'enforce', { threshold: 100, scope: 'run' }),
  rule('gr_a', 'spend_cap', 'watch', { dailyCap: 190, scope: 'day', unit: 'dollars' }),
  rule('gr_b', 'spend_cap', 'watch', { dailyCap: 200, scope: 'day', unit: 'dollars' }),
  rule('gr_m', 'model_allowlist', 'watch', { allowedModels: ['claude-haiku-4-5'] }),
  rule('gr_off', 'call_rate', 'off', { maxCalls: 10 }),
];

describe('lookbacks', () => {
  it('says hours under a day and pluralises days', () => {
    expect(lookbackText(336)).toBe('last 14 days');
    expect(lookbackText(24)).toBe('last day');
    expect(lookbackText(6)).toBe('last 6 hours');
    expect(lookbackText(1)).toBe('last 1 hour');
    expect(lookbackText(null)).toBeNull();
  });
});

describe('trends', () => {
  it('compares with the window just before, and says nothing without one', () => {
    expect(priorLabel('last 7 days')).toBe('prior 7 days');
    expect(pctChange(479, 165)).toBe(190);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(5, undefined)).toBeNull();
    expect(trendText(190, 'prior 7 days')).toBe('↑ 190% vs prior 7 days');
    expect(trendText(-12, 'prior 7 days')).toBe('↓ 12% vs prior 7 days');
    expect(trendText(0, 'prior 7 days')).toBe('no change vs prior 7 days');
    expect(trendText(null, 'prior 7 days')).toBeNull();
  });
  it('calls a quicker response faster and a slower one slower', () => {
    expect(latencyTrend(2100, 3280, 'prior 7 days')).toEqual({ text: '↓ 36% faster vs prior 7 days', tone: 'ok' });
    expect(latencyTrend(3000, 2000, 'prior 7 days')).toEqual({ text: '↑ 50% slower vs prior 7 days', tone: 'warn' });
    expect(latencyTrend(null, 2000, 'prior 7 days')).toBeNull();
    expect(latencyTrend(2000, null, 'prior 7 days')).toBeNull();
  });
  it('compares spend per call, not total spend', () => {
    expect(perCallTrend({ calls: 100, cost: 790 }, { totalCalls: 100, totalCost: 1000 }, 'prior 7 days')).toBe('spend per call ↓21% vs prior 7 days');
    expect(perCallTrend({ calls: 100, cost: 790 }, undefined, 'prior 7 days')).toBeNull();
  });
});

describe('savings and spend', () => {
  it('says how many fewer tokens and about what share', () => {
    expect(fewerTokens(3_180_000, 1_740_000)).toBe('3.18M fewer tokens · about 65% less');
    expect(fewerTokens(0, 10)).toBeNull();
    // The dollars' caption says what they are; the tokens are Smaller context's card.
    expect(savedCaption(3_180_000, 0)).toBe('estimated, at your model prices');
    expect(savedCaption(3_180_000, 5)).toBe('estimated, at your model prices · includes cache reads');
    expect(savedCaption(0, 5)).toBe('from cache reads · estimated');
    expect(savedCaption(0, 0)).toBe('nothing saved in this range');
    // Smaller context for the range: the same share as the with-vs-without chart.
    expect(rangeContextCard(3_180_000, 1_740_000)).toEqual({ value: '65%', sub: 'less input sent to models · 3.18M fewer input tokens · ≈1.3 kWh saved' });
    // Input is plain plus cached input; output isn't counted.
    expect(inputTokensOf({ inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2 })).toBe(17);
    expect([...inputByLocalDay([{ hour: new Date(2026, 9, 26, 23).toISOString(), inputTokens: 4 }, { hour: new Date(2026, 9, 27, 1).toISOString(), inputTokens: 6, cacheReadTokens: 1 }])]).toEqual([['2026-10-26', 4], ['2026-10-27', 7]]);
    expect(rangeContextCard(0, 10)).toEqual({ value: '—', sub: 'nothing saved in this range' });
    expect(rangeContextCard(5, null)).toEqual({ value: '—', sub: 'not available yet' });
    expect(tokenTotals([{ day: 'a', used: 10, saved: 30 }, { day: 'b', used: 5, saved: 0 }])).toEqual({ used: 15, without: 45, saved: 30 });
  });
  it('dates the price list and splits spend by model, biggest first', () => {
    expect(pricesFrom('2026-10-19')).toBe('Prices from Oct 19.');
    expect(pricesFrom('v3')).toBe('Prices: v3.');
    const m = (model: string, costMicros: number) => ({ provider: 'anthropic', model, calls: 1, inputTokens: 1, outputTokens: 1, costMicros });
    expect(modelShares([m('a', 13), m('b', 87)]).map((s) => [s.model.model, s.share])).toEqual([['b', 0.87], ['a', 0.13]]);
    expect(modelShares([m('a', 0)])).toEqual([]);
  });
});

describe('Control', () => {
  it('sums up what rules caught', () => {
    expect(rulesCaughtText(120, 0)).toBe('rules caught 120 times, none blocked');
    expect(rulesCaughtText(3, 1)).toBe('rules caught 3 times, 1 blocked');
    expect(rulesCaughtText(0, 0)).toBe('rules caught nothing');
    expect(ruleModeCounts(RULES)).toBe('5 rules: 1 Enforce · 3 Watch · 1 Off');
    expect(ruleModeCounts([...RULES, { ...RULES[0], id: 'gr_alert', mode: 'enforce', response: 'notify' }])).toBe('6 rules: 1 Enforce · 1 Alert only · 3 Watch · 1 Off');
  });
  it('names the top rules by id, with each one’s value when a type has several, and a removed one plainly', () => {
    const acts = (blocked: number, wouldAct: number) => ({ blocked, wouldAct, paused: 0, stopped: 0, toldYou: 0 });
    const rows = topCaught(COUNTS, { gr_m: acts(0, 60), gr_a: acts(0, 59), gr_gone: acts(0, 1), gr_b: acts(0, 0) }, RULES);
    expect(rows.map((r) => [r.label, r.wouldBlock, r.mode, r.ruleId])).toEqual([
      ['Model allowlist', 60, 'watch', 'gr_m'],
      ['Spend cap · $190', 59, 'watch', 'gr_a'],
      ['A rule since removed', 1, null, null],
    ]);
  });
  it('falls back to rule types on an engine without per-rule counts', () => {
    const rows = topCaught(COUNTS, undefined, RULES);
    expect(rows.map((r) => [r.label, r.blocked + r.wouldBlock, r.mode, r.ruleId])).toEqual([
      ['Model allowlist', 60, 'watch', 'gr_m'],
      ['Spend caps (2 rules)', 59, 'watch', null],
      ['Keywords', 1, null, null],
    ]);
  });
  it('lists every rule type and agent, the quiet types on one row', () => {
    const types = ruleTypeRows(COUNTS);
    expect(types.active.map((r) => r.label)).toEqual(['Model allowlist', 'Spend cap', 'Loop breaker', 'Keywords']);
    expect(types.quiet).toEqual(['Tool list', 'Call rate']);
    expect(ruleAgentRows(COUNTS).map((r) => r.agent)).toEqual(['code-reviewer', 'lead-agent', '']);
  });
});

describe('Agent health', () => {
  const report = (agentId: string, open: boolean): FleetDiagnosis['reports'][number] => ({
    schema: 'diagnosis.v1', agentId, window: { from: '', to: '', days: 7, calls: 100, watches: 5 },
    findings: open ? [{ detector: 'review_tool_loops', status: 'open' } as never] : [{ detector: 'review_tool_loops', status: 'snoozed' } as never],
    clear: [{ detector: 'review_tool_errors', note: null }],
    notMeasured: [{ detector: 'review_spend_outliers', code: 'short_history', reason: 'Needs 14 days of history; has 7' }],
  });
  const d = { reports: [report('a', true), report('b', false)] } as FleetDiagnosis;
  it('groups the checks by check, across agents', () => {
    expect(checkGroups(d)).toEqual([
      { title: 'Repeating the same call', status: '1 problem · 1 set aside', tone: 'problem', problemAgents: ['a'] },
      { title: 'Unusually expensive days', status: 'starts in about 7 days · 2 agents', tone: 'neutral', problemAgents: [] },
      { title: 'A tool keeps failing', status: '2 passed', tone: 'ok', problemAgents: [] },
    ]);
  });
  it('is green only when every agent checked passed', () => {
    const r = (agentId: string, o: Partial<FleetDiagnosis['reports'][number]>) => ({ schema: 'diagnosis.v1', agentId, window: { from: '', to: '', days: 7, calls: 1, watches: 1 }, findings: [], clear: [], notMeasured: [], ...o }) as FleetDiagnosis['reports'][number];
    const tones = checkGroups({ reports: [
      r('a', { clear: [{ detector: 'review_tool_errors', note: null }], findings: [{ detector: 'review_tool_loops', status: 'dismissed' } as never], notMeasured: [{ detector: 'review_spend_outliers', code: 'x', reason: 'Not yet' }] }),
      r('b', { clear: [{ detector: 'review_tool_errors', note: null }, { detector: 'review_spend_outliers', note: null }] }),
    ] } as FleetDiagnosis).map((g) => [g.title, g.tone]);
    expect(tones).toEqual([['Repeating the same call', 'neutral'], ['Unusually expensive days', 'neutral'], ['A tool keeps failing', 'ok']]);
  });
  it('heads the card with what ran and what still needs data', () => {
    expect(healthHeadline({ fine: 17, needsData: 22, openFindings: 0 })).toEqual({ title: 'No issues in 17 checks', sub: '22 more checks need more data before they can run', tone: 'ok' });
    expect(healthHeadline({ fine: 1, needsData: 1, openFindings: 1 })).toEqual({ title: '1 problem in 2 checks', sub: '1 more check needs more data before it can run', tone: 'warn' });
    expect(healthHeadline({ fine: 0, needsData: 3, openFindings: 0 }).title).toBe('No checks could run yet');
    expect(healthCounts({ fine: 17, needsData: 22, openFindings: 0 })).toBe('17 passed · 22 need more data');
    expect(healthCounts({ fine: 1, needsData: 1, openFindings: 2 })).toBe('2 problems · 1 passed · 1 needs more data');
  });
});

describe('Cost prediction folded note', () => {
  it('leads with the fleet hourly cost, says when it is unknown, and keeps the budgets note', () => {
    expect(predictionNote({ usdPerHour: 0.3544, lookbackHours: 336 }, '1 agent with a budget')).toBe('$0.354 an hour while agents work, last 14 days · 1 agent with a budget');
    expect(predictionNote({ usdPerHour: 0.5, lookbackHours: 336, unpriced: true }, undefined)).toBe('hourly cost: recent calls have no price on file yet');
    expect(predictionNote(null, 'pick an agent to see what a budget allows')).toBe('hourly cost couldn’t load · pick an agent to see what a budget allows');
    // No spend while working: nothing to say about the fleet; not passed at all: just the budgets note.
    expect(predictionNote({ usdPerHour: 0, lookbackHours: 336 }, 'x')).toBe('x');
    expect(predictionNote(undefined, undefined)).toBeUndefined();
    // No lookback known: no window after the figure.
    expect(predictionNote({ usdPerHour: 0.3544, lookbackHours: null }, undefined)).toBe('$0.354 an hour while agents work');
  });
});

describe('By day week read', () => {
  it('uses the range read when it holds the 7 days, else its own, and never one with an error', () => {
    const weekStart = new Date(2026, 9, 21);
    const range = { from: new Date(2026, 8, 28), to: null };
    expect(rangeHoldsWeek(range, weekStart)).toBe(true);
    expect(rangeHoldsWeek({ from: new Date(2026, 9, 27), to: null }, weekStart)).toBe(false);
    // A custom range ending in the past doesn't hold the latest days.
    expect(rangeHoldsWeek({ from: new Date(2026, 8, 28), to: new Date(2026, 9, 25) }, weekStart)).toBe(false);
    const ok: { hourly: never[]; error?: string } = { hourly: [] }, bad: { hourly: never[]; error?: string } = { hourly: [], error: 'down' };
    expect(weekHourlyFrom(true, ok, bad)).toBe(ok);
    expect(weekHourlyFrom(false, ok, bad)).toBeNull();
    expect(weekHourlyFrom(false, bad, ok)).toBe(ok);
    expect(weekHourlyFrom(false, ok, null)).toBeNull();
    expect(weekHourlyFrom(true, bad, ok)).toBeNull();
    expect(WEEK_HOURS).toBeGreaterThanOrEqual(168 + 24);
  });
});
