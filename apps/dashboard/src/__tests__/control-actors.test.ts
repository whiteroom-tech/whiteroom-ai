import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: () => ({ query: vi.fn() }) }));

import { historyWho, holdWho, type ControlActor } from '@/lib/control-actors';
import { controlTarget } from '@/lib/control-actions';

const at = '2026-10-02T20:00:00.000Z';
const row = (o: Partial<ControlActor>): ControlActor => ({ action: 'pause_agent', agentId: 'lead-agent', ruleId: null, userId: 'u1', by: 'R Haque', at, ...o });

describe('who held an agent', () => {
  const hold = { state: 'paused' as const, by: 'dashboard', reason: null, at: '2026-10-02T20:00:20.000Z' };

  it('names the person whose pause matches the hold', () => {
    expect(holdWho(hold, 'lead-agent', [row({})])).toBe('by R Haque');
  });

  it('says a rule did it when a rule set the hold', () => {
    expect(holdWho({ ...hold, by: 'rule:r1' }, 'lead-agent', [row({})])).toBe('by a rule');
  });

  it('falls back when the row is for another agent, another action, or too far apart', () => {
    expect(holdWho(hold, 'lead-agent', [row({ agentId: 'other' })])).toBe('from the dashboard');
    expect(holdWho(hold, 'lead-agent', [row({ action: 'stop_agent' })])).toBe('from the dashboard');
    expect(holdWho(hold, 'lead-agent', [row({ at: '2026-10-02T19:50:00.000Z' })])).toBe('from the dashboard');
    expect(holdWho(hold, 'lead-agent', [])).toBe('from the dashboard');
  });
});

describe('who acted, when the engine names the account', () => {
  it('names the account from any of its rows, whatever the time or target', () => {
    const hold = { state: 'stopped' as const, by: 'user:u1', reason: null, at: '2026-09-20T10:00:00.000Z' };
    expect(holdWho(hold, 'lead-agent', [row({ agentId: 'other', action: 'governance_update_rule' })])).toBe('by R Haque');
    expect(historyWho({ ruleId: 'r9', time: '2026-09-01T00:00:00.000Z', by: 'user:u1' }, [row({})])).toBe('R Haque');
  });

  it('never shows the raw id when the account has no row in the window', () => {
    const hold = { state: 'paused' as const, by: 'user:u2', reason: null, at };
    expect(holdWho(hold, 'lead-agent', [row({})])).toBe('by a teammate');
    expect(historyWho({ ruleId: 'r1', time: at, by: 'user:u2' }, [])).toBe('a teammate');
  });
});

describe('who changed a rule', () => {
  const entry = { ruleId: 'r1', time: '2026-10-02T20:01:00.000Z', by: 'dashboard' };

  it('names the person for the same rule within two minutes', () => {
    expect(historyWho(entry, [row({ action: 'governance_update_rule', agentId: null, ruleId: 'r1' })])).toBe('R Haque');
  });

  it('keeps the engine\'s own "by" when it already names someone, or no row matches', () => {
    expect(historyWho({ ...entry, by: 'agent' }, [row({ ruleId: 'r1' })])).toBe('agent');
    expect(historyWho(entry, [row({ ruleId: 'r2' })])).toBe('dashboard');
  });
});

describe('what a control request acted on', () => {
  it('reads the agent and rule from the request', () => {
    expect(controlTarget('{"action":"pause_agent","agent_id":"lead-agent"}', '{}')).toEqual({ agentId: 'lead-agent', ruleId: null });
    expect(controlTarget('{"action":"governance_update_rule","rule_id":"r1"}', '{}')).toEqual({ agentId: null, ruleId: 'r1' });
  });

  it('takes a new rule\'s id from the engine\'s reply, and survives bad JSON', () => {
    expect(controlTarget('{"action":"governance_create_rule"}', '{"rule":{"id":"r9"}}')).toEqual({ agentId: null, ruleId: 'r9' });
    expect(controlTarget('not json', 'nope')).toEqual({ agentId: null, ruleId: null });
  });
});
