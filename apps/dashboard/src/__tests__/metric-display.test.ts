import { describe, expect, it } from 'vitest';
import { agentPlanStats, savingsFigure } from '../lib/metric-display';

describe('savings figure (M13)', () => {
  it('is unknown, not $0.00, when savings could not be read', () => {
    expect(savingsFigure(true, 0, false)).toBe('—');
    expect(savingsFigure(true, 5_000_000, true)).toBe('—');
  });

  it('marks a partly unpriced figure', () => {
    expect(savingsFigure(false, 0, false)).not.toBe('—');
    expect(savingsFigure(false, 1_000_000, true).endsWith('+')).toBe(true);
  });
});

describe('agent plan stats (M16)', () => {
  it('shows unreachable usage as Unavailable, never 0, on any plan', () => {
    expect(agentPlanStats('starter', null, null)).toEqual([{ label: 'Agents registered', value: 'Unavailable' }]);
    expect(agentPlanStats('pro', null, 4)).toEqual([
      { label: 'Agents registered', value: 'Unavailable' },
      { label: 'Billed for', value: '4 agents' },
    ]);
  });

  it("keeps Pro's live count, Stripe's confirmed quantity and the estimate apart", () => {
    const stats = agentPlanStats('pro', 5, 4);
    expect(stats.map((s) => s.label)).toEqual(['Agents registered', 'Billed for', 'Est. monthly']);
    expect(stats[0].value).toBe('5');
    expect(stats[1].value).toBe('4 agents');
    expect(stats[2].value).toMatch(/\/mo$/);
    expect(agentPlanStats('pro', 1, null).map((s) => s.label)).toEqual(['Agents registered', 'Est. monthly']);
  });
});
