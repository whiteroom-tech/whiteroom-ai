import { describe, it, expect } from 'vitest';
import { qualityRows, reviewRow, reviewFooter } from '@/lib/handover-quality';
import type { HandoverReviewCounts } from '@/lib/whiteroom/client';

const base = { handovers: 3, scored: 3, valuesChecked: 200, valuesKept: 196, valuesKeptShare: 0.98, shareChecked: 0.96, coverageMin: 0.9, keptWithLabel: null, goalCarriedOver: null };

describe('handover quality rows', () => {
  it('rounds down without float error', () => {
    expect(qualityRows({ ...base, valuesKept: 29, valuesChecked: 200, valuesKeptShare: 0.145 })[0].value).toBe('14.5%');
  });

  it('shows values kept with its denominator', () => {
    expect(qualityRows(base)[0]).toEqual({ label: 'Values kept', detail: '196 of 200 values WhiteRoom checked', value: '98.0%', state: 'measured' });
  });
  it('never shows a partly checked share as healthy', () => {
    expect(qualityRows({ ...base, shareChecked: 0.84 })[0]).toMatchObject({ state: 'partly', detail: 'Partly checked: 84.0% of the shifts’ text. Not enough to call this healthy.' });
  });
  it('says not measured yet instead of showing a number', () => {
    const rows = qualityRows({ ...base, valuesChecked: 0, valuesKept: 0, valuesKeptShare: null, shareChecked: null });
    expect(rows.map((r) => r.value)).toEqual(['—', '—', '—']);
    expect(rows.every((r) => r.state === 'none')).toBe(true);
  });
  it('never rounds a lossy share up to 100%, or a small one down to 0%', () => {
    expect(qualityRows({ ...base, valuesKeptShare: 0.9996 })[0].value).toBe('99.9%');
    expect(qualityRows({ ...base, valuesKeptShare: 0.004 })[0].value).toBe('<1%');
  });
});

describe('label and goal rows', () => {
  it('show the engine\'s share once it sends one, and stay not measured until then', async () => {
    const { qualityRows } = await import('@/lib/handover-quality');
    expect(qualityRows(base).slice(1).map((r) => r.state)).toEqual(['none', 'none']);
    const rows = qualityRows({ ...base, keptWithLabel: 0.9, goalCarriedOver: 1 });
    expect(rows[1]).toMatchObject({ value: '90.0%', state: 'measured' });
    expect(rows[2]).toMatchObject({ value: '100.0%', state: 'measured' });
  });
});

describe('review result', () => {
  const r = (o: Partial<HandoverReviewCounts> = {}, rep: Partial<HandoverReviewCounts['representative']> = {}): HandoverReviewCounts => ({
    mode: 'realtime', riskTriggered: 0, skipped: {}, calibrated: [], minVerified: 20, coverageMin: 0.8, sizeCoverageMin: 0.7, ...o,
    representative: { selected: 7, reviewed: 6, retained: 27, dropped: 2, contradicted: 1, unverified: 4, bySize: { small: { selected: 4, reviewed: 3 }, large: { selected: 3, reviewed: 3 } }, ...rep },
  });

  it('is computed from confirmed items, and is an early estimate until calibrated', () => {
    expect(reviewRow(r())).toEqual({
      label: 'Review result', value: '90.0%', state: 'measured', status: 'Early estimate',
      detail: '27 of 30 confirmed items kept, in 6 sampled handovers · 2 look missing (reviewer’s judgment) · 1 changed in meaning · 4 couldn’t confirm',
    });
    expect(reviewRow(r({ calibrated: ['retained', 'dropped', 'contradicted'] })).status).toBeUndefined();
    expect(reviewRow(r({ calibrated: ['retained', 'dropped'] })).status).toBe('Early estimate');
    // No drops found, but drops aren't calibrated: missed ones would flatter the rate.
    expect(reviewRow(r({ calibrated: ['retained'] }, { dropped: 0, contradicted: 0, retained: 30 })).status).toBe('Early estimate');
  });

  it('says not enough data, or not measured, instead of a number', () => {
    expect(reviewRow(r({ minVerified: 0 }, { retained: 0, dropped: 0, contradicted: 0 })).value).toBe('—'); // never NaN%
    expect(reviewRow(r({}, { retained: 10, dropped: 0, contradicted: 0 }))).toMatchObject({ value: '—', detail: 'Not enough data yet: 10 of 20 items confirmed so far.' });
    expect(reviewRow(r({ mode: 'off' }, { reviewed: 0 })).detail).toMatch(/Turn on handover review in Settings/);
    // Too few of the sampled handovers reviewed, overall or for one shift size.
    expect(reviewRow(r({}, { selected: 10 })).detail).toBe('Not enough data yet: 6 of 10 sampled handovers were reviewed.');
    expect(reviewRow(r({}, { bySize: { small: { selected: 4, reviewed: 4 }, large: { selected: 3, reviewed: 1 } } })).value).toBe('—');
  });

  it('keeps reviews outside the sample and skips under the scores, in plain words', () => {
    expect(reviewFooter(r({ riskTriggered: 3, skipped: { capacity: 1, budget: 4, failed: 2 } }))).toEqual([
      '3 reviewed because something looked off',
      'Not reviewed: monthly limit reached (4)',
      'Not reviewed: the review call didn’t complete (2)',
      'Not reviewed: WhiteRoom was busy (1)',
    ]);
    expect(reviewFooter(undefined)).toEqual([]);
  });
});
