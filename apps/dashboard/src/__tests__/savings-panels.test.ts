import { describe, expect, it } from 'vitest';
import { agentDaySavings, agentTotals, auditSavingsEvent, dailySavings, localDayFromTs } from '@/lib/analytics-metrics';
import { axisLabel, axisTop } from '@/components/performance/SavingsPanels';

// Performance's Savings chart and By agent table, moved from Run History,
// must keep Run History's numbers: same attribution, same per-agent-day math.

const now = new Date(2026, 9, 1, 15, 0).getTime(); // Oct 1, local
const at = (day: number, hour = 10) => new Date(2026, 9, day, hour, 0).toISOString();

const entries = [
  { type: 'task_complete', timestamp: at(1), agentId: 'Lead-Agent', tokensUsed: 1000 },
  { type: 'task_complete', timestamp: at(1, 11), agentId: 'writer', tokensUsed: 3000 },
  { type: 'self_handover', timestamp: at(1, 12), agentId: 'lead-agent', contextTokens: 50_000, handoverDocTokens: 2_000 },
  { type: 'task_complete', timestamp: new Date(2026, 8, 28, 9).toISOString(), agentId: 'lead-agent', tokensUsed: 500 },
  { type: 'task_complete', timestamp: new Date(2026, 8, 20, 9).toISOString(), agentId: 'ancient', tokensUsed: 7 },
];

describe('dailySavings', () => {
  it('returns every day of the window, oldest first, with zeros for quiet days', () => {
    const days = dailySavings(entries, 7, now);
    expect(days.map((d) => d.day)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
    expect(days.find((d) => d.day === '2026-09-28')!.used).toBe(500);
    expect(days.find((d) => d.day === '2026-09-26')).toEqual({ day: '2026-09-26', used: 0, saved: 0 });
    // Older than the window: not counted anywhere.
    expect(days.reduce((s, d) => s + d.used, 0)).toBe(1000 + 3000 + 500);
  });

  it('computes saved with the same per-agent-day math as Run History', () => {
    const inWindow = entries.filter((e) => localDayFromTs(e.timestamp) >= '2026-09-25');
    const expected = agentDaySavings(inWindow.map((e) => auditSavingsEvent(e, localDayFromTs(e.timestamp)))).byDay.get('2026-10-01');
    expect(dailySavings(entries, 7, now).at(-1)!.saved).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });
});

describe('agentTotals', () => {
  it('sums tokens per agent (case-folded) in the window, most tokens first', () => {
    const rows = agentTotals(entries, new Date(2026, 9, 1, 0, 0).getTime());
    expect(rows.map((r) => [r.agent, r.used])).toEqual([['writer', 3000], ['lead-agent', 1000]]);
  });

  it('credits a handover’s saving to the agent that handed over', () => {
    const lead = agentTotals(entries, new Date(2026, 9, 1, 0, 0).getTime()).find((r) => r.agent === 'lead-agent')!;
    expect(lead.saved).toBeGreaterThan(0);
  });
});

describe('Savings axis', () => {
  it('rounds up to a tidy top the tallest bar mostly fills', () => {
    expect(axisTop(104_600)).toBe(150_000);
    expect(axisTop(82_000)).toBe(100_000);
    expect(axisTop(2_100)).toBe(2_500);
    expect(axisTop(0)).toBe(1);
  });
  it('labels without a trailing .0', () => {
    expect([axisLabel(150_000), axisLabel(75_000), axisLabel(0), axisLabel(1_500_000)]).toEqual(['150K', '75K', '0', '1.50M']);
  });
});
