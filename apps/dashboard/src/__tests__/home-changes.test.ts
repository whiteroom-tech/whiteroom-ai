import { describe, expect, it } from 'vitest';
import { changeRow, dayLabel, lastActiveDay, latestChanges, ruleOutcomes } from '@/lib/home-changes';
import type { AuditEntry } from '@/lib/whiteroom/types';

const NOW = Date.parse('2026-10-27T15:00:00');
const at = (s: string) => new Date(s).toISOString();
const actors = [{ action: 'add_rule', agentId: null, ruleId: 'gr_1', userId: 'u1', by: 'R Haque', at: at('2026-10-27T10:30:00') }];
const rule = (id: string, message: string, ts: string, by = 'user:u1'): AuditEntry => ({ id, type: 'governance_rule_changed', timestamp: at(ts), ruleId: 'gr_1', ruleType: 'loop_breaker', message, by });

describe('Latest changes', () => {
  it('words rule changes with who made them and links to the rule', () => {
    expect(changeRow(rule('1', 'Loop breaker: Added new Loop breaker rule', '2026-10-27T10:30:00'), actors, NOW)).toEqual({ key: '1', time: '10:30 am', text: 'Loop breaker rule added by R Haque', href: '/controls?rule=gr_1' });
    expect(changeRow(rule('2', 'Loop breaker: Removed Loop breaker rule', '2026-10-25T09:00:00', 'api'), actors, NOW)!.text).toBe('Loop breaker rule removed through the API');
    expect(changeRow(rule('3', 'Loop breaker: Watch → Enforce', '2026-10-25T09:00:00'), actors, NOW)!.text).toBe('Loop breaker: Record only → Block by R Haque');
  });

  it('words agent changes and links to the agent', () => {
    const e = (type: string, x: Partial<AuditEntry> = {}): AuditEntry => ({ id: type, type, timestamp: at('2026-10-25T09:00:00'), agentId: 'keyword-test', ...x });
    expect(changeRow(e('deregister'), [], NOW)).toMatchObject({ time: 'Oct 25', text: 'keyword-test left the fleet', href: '/agents/keyword-test' });
    expect(changeRow(e('register'), [], NOW)!.text).toBe('keyword-test joined the fleet');
    expect(changeRow(e('agent_paused', { by: 'rule:gr_1' }), [], NOW)!.text).toBe('keyword-test paused by a rule');
    expect(changeRow(e('agent_resumed', { by: 'user:u1' }), actors, NOW)!.text).toBe('keyword-test resumed by R Haque');
    expect(changeRow(e('agent_stopped', { by: 'user:u9' }), actors, NOW)!.text).toBe('keyword-test stopped by a teammate');
    expect(changeRow(e('agent_stopped', { by: 'dashboard' }), [], NOW)!.text).toBe('keyword-test stopped from the dashboard');
    expect(changeRow(e('task_complete'), [], NOW)).toBeNull();
    expect(changeRow(e('rest_start'), [], NOW)).toBeNull();
  });

  it('links a rule change with no rule id to Controls', () => {
    const r = changeRow({ id: 'x', type: 'governance_rule_changed', timestamp: at('2026-10-27T09:00:00'), ruleType: 'spend_cap', message: 'Spend cap: Settings updated' }, [], NOW)!;
    expect(r).toMatchObject({ text: 'Spend cap: Settings updated', href: '/controls' });
  });

  it('keeps the newest four, once each', () => {
    const many = [1, 2, 3, 4, 5].map((d) => rule(`r${d}`, 'Loop breaker: Settings updated', `2026-10-2${d}T09:00:00`));
    const rows = latestChanges([...many, many[4]], actors, 4, NOW);
    expect(rows.map((r) => r.key)).toEqual(['r5', 'r4', 'r3', 'r2']);
  });
});

describe('quiet day', () => {
  it('finds the last day before today with runs', () => {
    expect(lastActiveDay({ fleetId: 'f', days: [{ day: '2026-10-20', runs: 3 }, { day: '2026-10-24', runs: 47 }, { day: '2026-10-27', runs: 2 }] }, '2026-10-27')).toEqual({ day: '2026-10-24', runs: 47 });
    expect(lastActiveDay({ fleetId: 'f', days: [] }, '2026-10-27')).toBeNull();
    expect(lastActiveDay(null, '2026-10-27')).toBeNull();
    expect(dayLabel('2026-10-24')).toBe('Sat, Oct 24');
  });

  it('says rule outcomes in the outcome words', () => {
    expect(ruleOutcomes({ blocks: 2, wouldBlocks: 60, paused: 0, stopped: 0, toldYou: 0 })).toBe('2 blocked · 60 would have blocked');
    expect(ruleOutcomes({ blocks: 0, wouldBlocks: 0, paused: 0, stopped: 0, toldYou: 0 })).toBe('');
  });
});

describe('needs-attention order', () => {
  it('puts held and silent agents first, then agents with rule activity, then the usual order', async () => {
    const { shownAgents } = await import('@/lib/home-agents');
    const a = (agentId: string, x: Record<string, unknown> = {}) => ({ agentId, status: 'idle', ...x });
    const agents = [a('alpha'), a('beta'), a('gamma', { hold: { state: 'paused', by: 'x', reason: null, at: '' } }), a('delta')];
    const weeks = { delta: { rules: { blocks: 0, wouldBlocks: 3, paused: 0, stopped: 0, toldYou: 0 } } };
    expect(shownAgents(agents, weeks, '', 'attention').map((x) => x.agentId)).toEqual(['gamma', 'delta', 'alpha', 'beta']);
  });
});
