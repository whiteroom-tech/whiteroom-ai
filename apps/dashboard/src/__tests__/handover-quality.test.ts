import { describe, it, expect } from 'vitest';
import { qualityRows } from '@/lib/handover-quality';

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
