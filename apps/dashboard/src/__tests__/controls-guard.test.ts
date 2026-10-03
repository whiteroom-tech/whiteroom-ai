import { describe, expect, it } from 'vitest';
import { longestWatchHours, stopBlockedReason, stopCheck, stopPhrase, watchSummary } from '@/lib/controls-guard';
import { agentMenu } from '@/components/home/AgentActions';
import type { GovernanceHistoryEntry } from '@/lib/whiteroom/types';

const h = (time: string, description: string, ruleId = 'r1'): GovernanceHistoryEntry => ({ id: time, ruleId, ruleType: 'spend_cap', description, by: 'dashboard', time });
const NOW = Date.parse('2026-10-03T12:00:00Z');

describe('how long a rule has watched', () => {
  it('counts an unbroken stretch in Watch, up to now while still watching', () => {
    const hist = [h('2026-10-01T12:00:00Z', 'Added new Spend cap rule'), h('2026-10-02T00:00:00Z', 'Off → Watch')];
    expect(longestWatchHours('r1', hist, 'watch', NOW)).toBe(36);
  });

  it('keeps the longest finished stretch after it moved to Enforce', () => {
    const hist = [h('2026-10-01T00:00:00Z', 'Off → Watch'), h('2026-10-02T06:00:00Z', 'Watch → Enforce')];
    expect(longestWatchHours('r1', hist, 'enforce', NOW)).toBe(30);
  });

  it('counts from creation for a rule created in Watch, and ignores other rules and non-mode changes', () => {
    const hist = [h('2026-10-03T00:00:00Z', 'Added new Spend cap rule'), h('2026-10-03T01:00:00Z', 'Then → Pause'), h('2026-09-01T00:00:00Z', 'Off → Watch', 'r2')];
    expect(longestWatchHours('r1', hist, 'watch', NOW)).toBe(12);
    expect(longestWatchHours('r1', [], 'watch', NOW)).toBe(0);
  });
});

describe('the Stop guard', () => {
  it('blocks Stop until a day in Watch, and says how long it has run', () => {
    const recent = [h('2026-10-03T07:30:00Z', 'Off → Watch')];
    expect(stopBlockedReason('r1', recent, 'watch', NOW)).toMatch(/24 hours.*4 hours\.$/);
    expect(stopBlockedReason('r1', [h('2026-10-03T11:30:00Z', 'Off → Watch')], 'watch', NOW)).toMatch(/less than an hour/);
    expect(stopBlockedReason('r1', [h('2026-10-01T00:00:00Z', 'Off → Watch')], 'watch', NOW)).toBeNull();
  });

  it('asks for the agent names it covers, or "stop all agents"', () => {
    expect(stopPhrase(['lead-agent', 'scout'])).toBe('lead-agent, scout');
    expect(stopPhrase('all')).toBe('stop all agents');
  });
});

describe('Watching summary', () => {
  const rule = { response: 'pause' as const };

  it('names each agent with its count from the engine, busiest first', () => {
    expect(watchSummary(rule, { byAgent: { scout: 1, 'lead-agent': 15 }, unversioned: false }))
      .toBe('Watching: would have paused lead-agent 15 times, scout once since its last change.');
  });

  it('claims no response when older, unversioned events are counted', () => {
    expect(watchSummary(rule, { byAgent: { 'lead-agent': 2 }, unversioned: true })).toBe('Watching: would have acted on lead-agent 2 times since its last change.');
  });

  it('is null when the rule has not fired', () => {
    expect(watchSummary(rule, { byAgent: {}, unversioned: false })).toBeNull();
  });
});

describe('which rule changes need the Stop guard', () => {
  const watched = [h('2026-10-01T00:00:00Z', 'Off → Watch')];
  const fresh = [h('2026-10-03T11:00:00Z', 'Off → Watch')];
  const rule = (mode: string, response: 'block' | 'stop') => ({ id: 'r1', mode, response });

  it('asks to confirm Stop + Enforce whichever is set last, once watched long enough', () => {
    const enforced = [...watched, h('2026-10-02T06:00:00Z', 'Watch → Enforce')];
    expect(stopCheck(rule('enforce', 'block'), { response: 'stop' }, enforced, NOW)).toEqual({ kind: 'confirm' });
    expect(stopCheck(rule('watch', 'stop'), { mode: 'enforce' }, watched, NOW)).toEqual({ kind: 'confirm' });
  });

  it('blocks it before a day in Watch', () => {
    expect(stopCheck(rule('watch', 'stop'), { mode: 'enforce' }, fresh, NOW).kind).toBe('blocked');
  });

  it('lets everything else through: Stop while watching, other responses, leaving Stop + Enforce', () => {
    expect(stopCheck(rule('watch', 'block'), { response: 'stop' }, fresh, NOW)).toEqual({ kind: 'ok' });
    expect(stopCheck(rule('enforce', 'block'), { mode: 'watch' }, fresh, NOW)).toEqual({ kind: 'ok' });
    expect(stopCheck(rule('enforce', 'stop'), { mode: 'watch' }, fresh, NOW)).toEqual({ kind: 'ok' });
  });

  it('reads the engine\'s exact history wording', () => {
    expect(longestWatchHours('r1', [h('2026-10-02T12:00:00Z', 'Off → Watch')], 'watch', NOW)).toBe(24);
    expect(longestWatchHours('r1', [h('2026-10-02T12:00:00Z', 'Off -> Watch')], 'watch', NOW)).toBe(0);
  });
});

describe('Home agent menu', () => {
  it('offers Resume for a held agent, else Pause and Stop', () => {
    expect(agentMenu({ hold: { state: 'paused', by: 'dashboard', reason: null, at: '' } }).map((i) => i.act)).toEqual(['resume']);
    expect(agentMenu({ hold: null }).map((i) => i.act)).toEqual(['pause', 'stop']);
  });
});
