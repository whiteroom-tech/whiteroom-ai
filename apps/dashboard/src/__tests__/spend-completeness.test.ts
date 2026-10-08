import { describe, it, expect } from 'vitest';
import { DROPPED_TEXT, UNPRICED_TEXT, gapText, spendGap, spendSummary } from '@/lib/spend-completeness';

const spendGapText = (hours: Parameters<typeof spendGap>[0]) => gapText(spendGap(hours));

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

  it('says calls were dropped when any hour dropped some, whatever else is missing', () => {
    expect(spendGap([{ unpricedAttempts: 0, missingSpendBoundMicros: 0, unboundedAttempts: 0, droppedAttempts: 3 }]).kind).toBe('dropped');
    expect(spendGap([{ unpricedAttempts: 2, missingSpendBoundMicros: 900, unboundedAttempts: 0 }, { droppedAttempts: 1 }]).kind).toBe('dropped');
    expect(spendGapText([{ droppedAttempts: 1 }])).toBe(DROPPED_TEXT);
  });

  it('treats no dropped calls, or an engine that doesn’t report them, as before', () => {
    expect(spendGapText([{ unpricedAttempts: 0, missingSpendBoundMicros: 0, unboundedAttempts: 0, droppedAttempts: 0 }])).toBe('');
    expect(spendGapText([{ unpricedAttempts: 0, missingSpendBoundMicros: 0, unboundedAttempts: 0 }])).toBe('');
  });
});

describe('spend summary for the Spend cards', () => {
  const h = (unpriced: number) => ({ unpricedAttempts: unpriced, missingSpendBoundMicros: 0, unboundedAttempts: 0 });
  it('measures the gap over the selected half only', () => {
    const r = spendSummary([h(3), h(3), h(0), h(0)], 0);
    expect(r.shown).toHaveLength(2);
    expect(r).toMatchObject({ gapLine: '', partial: false });
  });
  it('marks the figure partial from the selected half', () => {
    expect(spendSummary([h(0), h(0), h(0), h(2)], 0)).toMatchObject({ partial: true, gapLine: UNPRICED_TEXT });
  });
  it('marks the figure partial when the selected half dropped calls', () => {
    expect(spendSummary([h(0), { ...h(0), droppedAttempts: 2 }], 0)).toMatchObject({ partial: true, gapLine: DROPPED_TEXT });
    expect(spendSummary([{ ...h(0), droppedAttempts: 2 }, h(0)], 0)).toMatchObject({ partial: false, gapLine: '' });
  });
  it('falls back to the summary count when there are no hourly rows', () => {
    expect(spendSummary([], 4)).toMatchObject({ shown: [], gapLine: UNPRICED_TEXT, partial: true });
    expect(spendSummary([], 0)).toMatchObject({ gapLine: '', partial: false });
  });
});
