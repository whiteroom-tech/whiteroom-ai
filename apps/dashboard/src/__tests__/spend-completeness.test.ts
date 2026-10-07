import { describe, it, expect } from 'vitest';
import { spendGap, spendGapText } from '@/lib/spend-completeness';

describe('spend gap', () => {
  it('is complete when every call was priced', () => {
    expect(spendGapText([{ unpricedAttempts: 0, missingSpendBoundMicros: 0, unboundedAttempts: 0 }])).toBe('');
  });
  it('states an upper bound when every missing call could be bounded', () => {
    expect(spendGap([{ unpricedAttempts: 2, missingSpendBoundMicros: 2_400_000, unboundedAttempts: 0 }, { unpricedAttempts: 1, missingSpendBoundMicros: 700_000, unboundedAttempts: 0 }]))
      .toEqual({ kind: 'bounded', micros: 3_100_000 });
    expect(spendGapText([{ unpricedAttempts: 2, missingSpendBoundMicros: 3_100_000, unboundedAttempts: 0 }])).toMatch(/^Incomplete: may be up to \$3\.10 more$/);
  });
  it('says unknown when any call can’t be bounded, or the engine predates bounds', () => {
    expect(spendGap([{ unpricedAttempts: 1, missingSpendBoundMicros: 500, unboundedAttempts: 1 }]).kind).toBe('unknown');
    expect(spendGap([{ unpricedAttempts: 1 }]).kind).toBe('unknown');
  });

  it("never shows a bound of $0 as an upper bound", () => {
    expect(spendGapText([{ unpricedAttempts: 1, missingSpendBoundMicros: 0, unboundedAttempts: 0 }])).toBe('Incomplete: some calls couldn’t be priced');
  });
});
