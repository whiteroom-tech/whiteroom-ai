import type { HandoverQuality } from './whiteroom/client';

export type QualityRow = { label: string; detail: string; value: string; state: 'measured' | 'partly' | 'none' };

// Rounded down, so anything lost never reads as a clean 100%; a small share isn't shown as 0%.
const pct = (x: number) => (x > 0 && x < 0.01 ? '<1%' : `${(Math.floor(x * 1000) / 10).toFixed(1)}%`);

/**
 * The rows Agent detail shows (compression spec §7.2, §14.2). A share is
 * never shown as healthy when too little of the shifts' text was checked, and
 * nothing unmeasured is shown as a number.
 */
export function qualityRows(q: HandoverQuality): QualityRow[] {
  const partly = q.shareChecked !== null && q.shareChecked < q.coverageMin;
  const kept: QualityRow = q.valuesKeptShare === null
    ? { label: 'Values kept', detail: 'Not measured yet. Shows after a handover with values to check.', value: '—', state: 'none' }
    : {
      label: 'Values kept',
      detail: partly
        ? `Partly checked: ${pct(q.shareChecked!)} of the shifts’ text. Not enough to call this healthy.`
        : `${q.valuesKept.toLocaleString('en-US')} of ${q.valuesChecked.toLocaleString('en-US')} values WhiteRoom checked`,
      value: pct(q.valuesKeptShare),
      state: partly ? 'partly' : 'measured',
    };
  return [
    kept,
    { label: 'Kept with the right label', detail: 'Not measured yet.', value: '—', state: 'none' },
    { label: 'Goal carried over', detail: 'Not measured yet.', value: '—', state: 'none' },
  ];
}
