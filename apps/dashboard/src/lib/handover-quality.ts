import type { HandoverQuality, HandoverReviewCounts } from './whiteroom/client';

export type QualityRow = { label: string; detail: string; value: string; state: 'measured' | 'partly' | 'none'; /** One status word, shown only when it isn't the default (§14.2). */ status?: string };

// Rounded down, so anything lost never reads as a clean 100%; a small share isn't shown as 0%.
// The tiny epsilon keeps float error (0.145 × 1000 = 144.999…) from rounding a clean share down.
const pct = (x: number) => (x > 0 && x < 0.01 ? '<1%' : `${(Math.floor(x * 1000 + 1e-9) / 10).toFixed(1)}%`);

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
  // Shares the engine doesn't measure yet stay "not measured"; once it sends them, they show, with the same coverage rule.
  const share = (label: string, v: number | null): QualityRow => v === null
    ? { label, detail: 'Not measured yet.', value: '—', state: 'none' }
    : { label, detail: partly ? `Partly checked: ${pct(q.shareChecked!)} of the shifts’ text.` : 'Of the handovers WhiteRoom checked', value: pct(v), state: partly ? 'partly' : 'measured' };
  const rows: QualityRow[] = [
    kept,
    share('Kept with the right label', q.keptWithLabel),
    share('Goal carried over', q.goalCarriedOver),
  ];
  if (q.review) rows.push(reviewRow(q.review));
  return rows;
}

const n = (x: number) => x.toLocaleString('en-US');

/**
 * Review result (§8.6, §14.2): the share of confirmed items the reviewer
 * found kept, from the representative sample only. "Not enough data yet"
 * below the minimum; "Early estimate" until every category it rests on is
 * calibrated. Items the reviewer couldn't back with quotes don't count.
 */
export function reviewRow(r: HandoverReviewCounts): QualityRow {
  const { retained, dropped, contradicted, unverified, reviewed } = r.representative;
  const confirmed = retained + dropped + contradicted;
  if (!reviewed) {
    return {
      label: 'Review result', value: '—', state: 'none',
      detail: r.mode === 'realtime' ? 'Not measured yet. Shows after the first sampled handover is reviewed.' : 'Not measured yet. Turn on handover review in Settings to see it.',
    };
  }
  if (confirmed < r.minVerified) {
    return { label: 'Review result', value: '—', state: 'none', detail: `Not enough data yet: ${n(confirmed)} of ${n(r.minVerified)} items confirmed so far.` };
  }
  // A sample that lost too many reviews (or most of one shift size) may be lopsided: no result (§8.4).
  const { selected, bySize } = r.representative;
  const thin = (selected > 0 && reviewed / selected < r.coverageMin)
    || Object.values(bySize).some((b) => b.selected > 0 && b.reviewed / b.selected < r.sizeCoverageMin);
  if (thin) {
    return { label: 'Review result', value: '—', state: 'none', detail: `Not enough data yet: ${n(reviewed)} of ${n(selected)} sampled handovers were reviewed.` };
  }
  // The rate rests on every category: a missed drop makes it look better, so all three must be calibrated.
  const early = (['retained', 'dropped', 'contradicted'] as const).some((c) => !r.calibrated.includes(c));
  const parts = [`${n(retained)} of ${n(confirmed)} confirmed items kept, in ${n(reviewed)} sampled handover${reviewed === 1 ? '' : 's'}`];
  if (dropped) parts.push(`${n(dropped)} look missing (reviewer’s judgment)`);
  if (contradicted) parts.push(`${n(contradicted)} changed in meaning`);
  if (unverified) parts.push(`${n(unverified)} couldn’t confirm`);
  return { label: 'Review result', value: pct(retained / confirmed), state: 'measured', detail: parts.join(' · '), ...(early && { status: 'Early estimate' }) };
}

const SKIP_COPY: Record<string, string> = {
  no_key: 'provider key no longer available',
  auth_identity: 'this provider route has no key of yours',
  budget: 'monthly limit reached',
  capacity: 'WhiteRoom was busy',
  provider: 'this provider isn’t supported for reviews yet',
  no_source: 'nothing in the shift to compare against',
  no_prompt: 'reviews aren’t available on this WhiteRoom yet',
  failed: 'the review call didn’t complete',
};

/** The lines under the scores, never next to a rate: reviews outside the sample, and why some weren't reviewed. */
export function reviewFooter(r: HandoverReviewCounts | undefined): string[] {
  if (!r) return [];
  const lines: string[] = [];
  if (r.riskTriggered) lines.push(`${n(r.riskTriggered)} reviewed because something looked off`);
  for (const [why, count] of Object.entries(r.skipped).sort((a, b) => b[1] - a[1])) {
    if (count) lines.push(`Not reviewed: ${SKIP_COPY[why] ?? 'another reason'} (${n(count)})`);
  }
  return lines;
}
