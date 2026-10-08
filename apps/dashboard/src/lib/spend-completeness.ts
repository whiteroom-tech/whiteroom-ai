import { fmtCost } from './format';

type Hour = { unpricedAttempts?: number; missingSpendBoundMicros?: number; unboundedAttempts?: number };

/**
 * What a spend total leaves out (compression spec §7.3, §14.3): nothing; at
 * most a known amount; or an unknown amount. Older engines don't send the
 * bound, so any unpriced attempt there reads as unknown.
 */
export function spendGap(hours: Hour[]): { kind: 'complete' } | { kind: 'bounded'; micros: number } | { kind: 'unknown' } {
  let unpriced = 0, bound = 0, unbounded = 0, reported = false;
  for (const h of hours) {
    unpriced += h.unpricedAttempts ?? 0;
    bound += h.missingSpendBoundMicros ?? 0;
    unbounded += h.unboundedAttempts ?? 0;
    if (h.missingSpendBoundMicros !== undefined) reported = true;
  }
  if (!unpriced && !bound) return { kind: 'complete' };
  if (!reported || unbounded > 0) return { kind: 'unknown' };
  return { kind: 'bounded', micros: bound };
}

/** Said when some calls couldn't be priced and the gap can't be bounded. */
export const UNPRICED_TEXT = 'Incomplete: some calls couldn’t be priced';

/** The Spend card's line about a gap: "" when nothing is missing. A bound of $0 says nothing, so it isn't shown as one. */
export function gapText(gap: ReturnType<typeof spendGap>): string {
  if (gap.kind === 'complete') return '';
  return gap.kind === 'bounded' && gap.micros > 0
    ? `Incomplete: may be up to ${fmtCost(gap.micros)} more`
    : UNPRICED_TEXT;
}

/**
 * What both Spend cards show about completeness. Hourly data is fetched for
 * twice the range (the first half feeds trends), so `shown` is the selected
 * range the summary totals cover: the gap is measured over the same calls as
 * the Spend figure. Without hourly rows, the summary's unpriced count still
 * marks the figure.
 */
export function spendSummary<T extends Hour>(hourly: T[], unpricedAttempts: number | undefined): { shown: T[]; gapLine: string; partial: boolean } {
  const mid = Math.floor(hourly.length / 2);
  const shown = mid > 0 ? hourly.slice(mid) : hourly;
  const gap = spendGap(shown);
  return { shown, gapLine: gapText(gap) || (unpricedAttempts ? UNPRICED_TEXT : ''), partial: !!unpricedAttempts || gap.kind !== 'complete' };
}
