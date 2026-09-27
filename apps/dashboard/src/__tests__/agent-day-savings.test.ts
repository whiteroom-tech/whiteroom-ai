// Audit F15: the Run History summary and its per-agent rows disagreed for the
// same scope because the task multiplier was applied per day for one and
// across the whole range for the other.

import { describe, it, expect } from 'vitest';
import { agentDaySavings, auditSavingsEvent, type SavingsEvent } from '@/lib/analytics-metrics';

function ev(day: string, agent: string, kind: 'task' | 'handover' | 'offload', saved = 0): SavingsEvent {
  return {
    day,
    agent,
    isTask: kind === 'task',
    isHandover: kind === 'handover',
    handoverSaved: kind === 'handover' ? saved : 0,
    offloadSaved: kind === 'offload' ? saved : 0,
  };
}

describe('agentDaySavings', () => {
  it('makes day totals and agent rows add up to the same number', () => {
    // The audit's shape: a busy day and a quiet day for one agent.
    const events = [
      ev('d1', 'a', 'handover', 1000), ...Array.from({ length: 9 }, () => ev('d1', 'a', 'task')),
      ev('d2', 'a', 'handover', 1000), ev('d2', 'a', 'task'),
    ];
    const { byDay, byAgent } = agentDaySavings(events);
    expect(byDay.get('d1')).toBe(5000);
    expect(byDay.get('d2')).toBe(1000);
    expect(byAgent.get('a')).toBe(6000);
  });

  it('keeps each agent\'s multiplier to its own work', () => {
    const events = [
      ev('d1', 'busy', 'handover', 100), ...Array.from({ length: 5 }, () => ev('d1', 'busy', 'task')),
      ev('d1', 'idle', 'handover', 100),
    ];
    const { byDay, byAgent } = agentDaySavings(events);
    expect(byAgent.get('busy')).toBe(300);
    expect(byAgent.get('idle')).toBe(100);
    expect(byDay.get('d1')).toBe(400);
  });

  it('counts unattributed savings in the day total only', () => {
    const { byDay, byAgent } = agentDaySavings([ev('d1', '', 'offload', 50), ev('d1', 'a', 'offload', 20)]);
    expect(byDay.get('d1')).toBe(70);
    expect([...byAgent.values()].reduce((s, v) => s + v, 0)).toBe(20);
  });
});

// Performance's Est. Savings used to apply one task multiplier across the
// whole range, so it read higher than Run History for the same audit entries.
// Both pages now map entries through auditSavingsEvent into agentDaySavings.
describe('auditSavingsEvent', () => {
  it('maps handovers, tasks and offloads', () => {
    expect(auditSavingsEvent({ type: 'self_handover', agentId: 'x', from: 'Lead', contextTokens: 1300, handoverDocTokens: 300 }, 'd1'))
      .toEqual({ day: 'd1', agent: 'lead', isTask: false, isHandover: true, handoverSaved: 1000, offloadSaved: 0 });
    expect(auditSavingsEvent({ type: 'task_complete', agentId: 'Lead' }, 'd1'))
      .toMatchObject({ agent: 'lead', isTask: true, handoverSaved: 0 });
    expect(auditSavingsEvent({ type: 'context_offload', agentId: 'a', contextTokens: 500, returnedTokens: 120 }, 'd1'))
      .toMatchObject({ offloadSaved: 380 });
  });

  it('defaults the handover doc to 300 tokens', () => {
    expect(auditSavingsEvent({ type: 'handover', agentId: 'a', contextTokens: 1000 }, 'd1').handoverSaved).toBe(700);
  });

  it('does not inflate a quiet day with a busy day\'s multiplier', () => {
    const entries = [
      { type: 'handover', agentId: 'a', contextTokens: 1300, handoverDocTokens: 300, day: 'd1' },
      ...Array.from({ length: 9 }, () => ({ type: 'task_complete', agentId: 'a', day: 'd1' })),
      { type: 'handover', agentId: 'a', contextTokens: 1300, handoverDocTokens: 300, day: 'd2' },
      { type: 'task_complete', agentId: 'a', day: 'd2' },
    ];
    const { byDay } = agentDaySavings(entries.map(({ day, ...e }) => auditSavingsEvent(e, day)));
    const total = [...byDay.values()].reduce((s, v) => s + v, 0);
    // Per agent-day: d1 = 1000 × ceil(9/2) = 5000, d2 = 1000 × 1 = 1000.
    // The old range-wide multiplier gave 2000 × ceil(10/3) = 8000.
    expect(total).toBe(6000);
  });
});
