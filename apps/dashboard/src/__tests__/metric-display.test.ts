import { describe, expect, it } from 'vitest';
import { agentsIncluded, fmtDollars, monthShareLine } from '../lib/metric-display';

describe('agents against the plan (M16, soft limit)', () => {
  it('shows unreachable usage as Unavailable, never 0', () => {
    expect(agentsIncluded('starter', null)).toEqual({ value: 'Unavailable', over: false });
    expect(agentsIncluded('pro', null)).toEqual({ value: 'Unavailable', over: false });
  });

  it('counts against the included agents, and only notes going over', () => {
    expect(agentsIncluded('starter', 2)).toEqual({ value: '2 of 3 included', over: false });
    expect(agentsIncluded('starter', 3)).toEqual({ value: '3 of 3 included', over: false });
    expect(agentsIncluded('pro', 9)).toEqual({ value: '9 of 7 included', over: true });
  });

  it('has no included count on Enterprise or an ended free period', () => {
    expect(agentsIncluded('enterprise', 40)).toBeNull();
    expect(agentsIncluded('expired', 2)).toBeNull();
  });
});

describe('this month\'s share', () => {
  it('shows the saving and the plan\'s share of it', () => {
    expect(monthShareLine('starter', 12_345)).toBe('This month: $123.45 saved · your share $24.69');
    expect(monthShareLine('pro', 12_345)).toBe('This month: $123.45 saved · your share $12.34');
    expect(monthShareLine('pro', 0)).toBe('This month: $0.00 saved · your share $0.00');
  });

  it('shows a dash while loading or unreadable, never $0', () => {
    expect(monthShareLine('starter', null)).toBe('This month: — saved · your share —');
  });

  it('is absent on plans without a share', () => {
    expect(monthShareLine('enterprise', 100)).toBeNull();
    expect(monthShareLine('expired', 100)).toBeNull();
  });

  it('formats cents as dollars', () => {
    expect(fmtDollars(5)).toBe('$0.05');
    expect(fmtDollars(100_000)).toBe('$1000.00');
  });
});
