import { describe, it, expect } from 'vitest';
import { countsFromRuleActions, responseOptions, ruleActionsByAgent, tallyTotal, tallyWords,
  convertSpendCap,
  computeSuggestions,
  governanceCounts,
  occurrences,
  recentBlocksByAgent,
} from '../lib/governance';
import { eventModel, technicalLine } from '../lib/activity';
import type { AuditEntry, FleetHourlyResult, PerformanceIndexResult } from '../lib/whiteroom/types';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function ev(type: string, extra: Partial<AuditEntry> = {}): AuditEntry {
  return { id: `e_${Math.random()}`, timestamp: ago(1), type, ...extra };
}

describe('governanceCounts', () => {
  const entries = [
    ev('governance_block', { agentId: 'a1', ruleType: 'spend_cap', occurrences: 3 }),
    ev('governance_block', { agentId: 'a2', ruleType: 'model_allowlist' }),
    ev('governance_would_block', { agentId: 'a1', ruleType: 'loop_breaker', occurrences: 2 }),
    ev('governance_rule_changed', { ruleType: 'spend_cap' }),
    ev('task_complete', { agentId: 'a1' }),
    ev('governance_block', { agentId: 'a1', ruleType: 'spend_cap', timestamp: ago(600) }),
  ];

  it('sums occurrences by kind, agent and rule; ignores other events', () => {
    const c = governanceCounts(entries);
    expect(c.blocks).toBe(5);
    expect(c.wouldBlocks).toBe(2);
    expect(c.byAgent.a1).toEqual({ blocks: 4, wouldBlocks: 2 });
    expect(c.byRule.spend_cap.blocks).toBe(4);
    expect(c.byRule.loop_breaker.wouldBlocks).toBe(2);
  });

  it('respects the time window', () => {
    expect(governanceCounts(entries, NOW - 60 * 60_000).blocks).toBe(4);
  });

  it('treats a missing or bad occurrences as one call', () => {
    expect(occurrences(ev('governance_block'))).toBe(1);
    expect(occurrences(ev('governance_block', { occurrences: -2 }))).toBe(1);
  });
});

describe('recentBlocksByAgent', () => {
  it('keeps the newest block per agent inside the window', () => {
    const recent = recentBlocksByAgent([
      ev('governance_block', { agentId: 'a1', timestamp: ago(10), reason: 'loop_detected' }),
      ev('governance_block', { agentId: 'a1', timestamp: ago(2), reason: 'budget_exceeded' }),
      ev('governance_block', { agentId: 'a2', timestamp: ago(40) }),
      ev('governance_would_block', { agentId: 'a3', timestamp: ago(1) }),
    ], NOW);
    expect(Object.keys(recent)).toEqual(['a1']);
    expect(recent.a1.reason).toBe('budget_exceeded');
  });
});

describe('computeSuggestions', () => {
  const index = (models: Array<[string | null, number]>) => ({
    summary: { models: models.map(([model, calls]) => ({ provider: 'anthropic', model, calls, inputTokens: 1, outputTokens: 1, costMicros: 0 })) },
  }) as unknown as PerformanceIndexResult;
  const hourly = (input: number, cacheRead: number) => ({
    hourly: [{ inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: 0 }],
  }) as unknown as FleetHourlyResult;

  it('suggests an allowlist of the models actually used (1-3)', () => {
    expect(computeSuggestions(index([['claude-haiku-4-5', 40], ['claude-haiku-4-5', 2]]), hourly(0, 0)).onlyModels).toEqual(['claude-haiku-4-5']);
    expect(computeSuggestions(index([['a', 1], ['b', 1], ['c', 1], ['d', 1]]), hourly(0, 0)).onlyModels).toBeNull();
    expect(computeSuggestions(index([[null, 5], ['x', 0]]), hourly(0, 0)).onlyModels).toBeNull();
  });

  it('flags missing caching only when there is input and no cache activity', () => {
    expect(computeSuggestions(index([]), hourly(1000, 0)).noCaching).toBe(true);
    expect(computeSuggestions(index([]), hourly(1000, 5)).noCaching).toBe(false);
    expect(computeSuggestions(index([]), hourly(0, 0)).noCaching).toBe(false);
  });
});

describe('activity feed governance rows', () => {
  it('renders blocks distinctly with rule, reason and count', () => {
    const m = eventModel(ev('governance_block', { agentId: 'research-agent', ruleType: 'spend_cap', reason: 'budget_exceeded', occurrences: 3 }), NOW);
    expect(m.code).toBe('BLK');
    expect(m.tone).toBe('block');
    expect(m.accent).toBe('var(--bad)');
    expect(m.who).toBe('Research-agent');
    expect(m.said).toBe('was blocked by the spend cap (budget exceeded) ×3');
    expect(technicalLine(m)).toContain('reason budget_exceeded');
  });

  it('marks would-blocks as Watch only', () => {
    const m = eventModel(ev('governance_would_block', { agentId: 'a1', ruleType: 'model_allowlist', reason: 'model_not_allowed', model: 'gpt-4o' }), NOW);
    expect(m.code).toBe('W/B');
    expect(m.said).toBe('would have been blocked by the model allowlist (model not allowed) (Watch only)');
    expect(technicalLine(m)).toContain('model gpt-4o');
  });

  it('shows rule changes as coming from Controls', () => {
    const m = eventModel(ev('governance_rule_changed', { ruleType: 'loop_breaker', message: 'Loop breaker: Off → Watch' }), NOW);
    expect(m.who).toBe('Controls');
    expect(m.said).toBe('Loop breaker: Off → Watch');
  });

  it('degrades gracefully on a malformed governance entry', () => {
    const m = eventModel(ev('governance_block', { ruleType: 42 as unknown as undefined }), NOW);
    expect(m.said).toBe('was blocked by the governance rule');
  });
});

describe('convertSpendCap', () => {
  it('converts at $0.003 per 1K tokens, matching the engine', () => {
    expect(convertSpendCap(50000, 'dollars')).toBe(0.15);
    expect(convertSpendCap(5, 'tokens')).toBe(1666667);
  });

  it('never rounds a small cap down to zero', () => {
    expect(convertSpendCap(1000, 'dollars')).toBe(0.01);
    expect(convertSpendCap(0.000001, 'tokens')).toBe(1);
  });
});

describe('governanceCounts agent keys', () => {
  it('keeps decisions without an agent apart from a real agent called "unknown"', () => {
    const c = governanceCounts([
      { id: '1', type: 'governance_block', timestamp: '2026-10-01T10:00:00Z' },
      { id: '2', type: 'governance_block', timestamp: '2026-10-01T10:01:00Z', agentId: 'unknown' },
    ] as AuditEntry[]);
    expect(c.byAgent['']).toEqual({ blocks: 1, wouldBlocks: 0 });
    expect(c.byAgent.unknown).toEqual({ blocks: 1, wouldBlocks: 0 });
  });
});

describe('rule responses and rule actions (P2.3/P2.4)', () => {
  it('offers Pause and Stop only on Gov v1 fleets, but keeps a rule’s current one', () => {
    expect(responseOptions(false, 'block').map((o) => o.value)).toEqual(['notify', 'block']);
    expect(responseOptions(false, 'stop').map((o) => o.value)).toEqual(['notify', 'block', 'stop']);
    expect(responseOptions(true, 'block').map((o) => o.label)).toEqual(['Just tell me', 'Block the call', 'Pause the agent', 'Stop the agent']);
  });

  it('words every action, worst first, and totals them', () => {
    const t = { blocks: 3, wouldBlocks: 2, paused: 1, stopped: 0, toldYou: 4 };
    expect(tallyWords(t).map((w) => w.text)).toEqual(['1 paused', '3 blocked', '4 told you', '2 would act (Watch only)']);
    expect(tallyTotal(t)).toBe(10);
    expect(tallyWords({ blocks: 0, wouldBlocks: 0 })).toEqual([]);
  });

  it('takes durable counts from rule_actions, keeping the audit log’s per-rule split', () => {
    const byRule = { spend_cap: { blocks: 1, wouldBlocks: 0 }, loop_breaker: { blocks: 0, wouldBlocks: 0 }, model_allowlist: { blocks: 0, wouldBlocks: 0 }, tool_list: { blocks: 0, wouldBlocks: 0 } };
    const c = countsFromRuleActions({
      fleetId: 'f',
      totals: { blocked: 5, paused: 1, stopped: 0, toldYou: 2, wouldAct: 3 },
      byAgent: { a: { blocked: 5, paused: 1, stopped: 0, toldYou: 2, wouldAct: 3 } },
    }, byRule);
    expect(c).toMatchObject({ blocks: 5, wouldBlocks: 3, paused: 1, toldYou: 2, byRule, byAgent: { a: { blocks: 5, paused: 1 } } });
  });
  it('merges agents that differ only in case, keeping every kind of action', () => {
    const merged = ruleActionsByAgent({ 'Lead-Agent': { blocks: 1, wouldBlocks: 0, paused: 1 }, 'lead-agent': { blocks: 2, wouldBlocks: 1, stopped: 1, toldYou: 3 } });
    expect(merged['lead-agent']).toEqual({ blocks: 3, wouldBlocks: 1, paused: 1, stopped: 1, toldYou: 3 });
  });
});
