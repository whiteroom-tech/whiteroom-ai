import { describe, it, expect } from 'vitest';
import {
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
