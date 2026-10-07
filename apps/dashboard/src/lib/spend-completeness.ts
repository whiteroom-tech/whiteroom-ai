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

/** The Spend card's line about it: "" when nothing is missing. */
export function spendGapText(hours: Hour[]): string {
  const gap = spendGap(hours);
  if (gap.kind === 'complete') return '';
  return gap.kind === 'bounded'
    ? `Incomplete: may be up to ${fmtCost(gap.micros)} more`
    : 'Incomplete: some calls couldn’t be priced';
}
