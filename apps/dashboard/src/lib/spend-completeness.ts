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
