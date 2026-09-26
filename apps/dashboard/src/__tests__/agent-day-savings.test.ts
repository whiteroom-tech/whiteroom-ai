// Audit F15: the Run History summary and its per-agent rows disagreed for the
// same scope because the task multiplier was applied per day for one and
// across the whole range for the other.

import { describe, it, expect } from 'vitest';
import { agentDaySavings, type SavingsEvent } from '@/lib/analytics-metrics';

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
