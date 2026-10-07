import type { HandoverReviewStatus } from '@/lib/whiteroom/client';

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The month's review spend in one line, for Settings and the Performance card.
 * Reserved spend (reviews still running) counts as used: it may all be billed.
 */
export function reviewSpendLine(s: HandoverReviewStatus): { text: string; warn: boolean } {
  const used = s.spent_usd + s.reserved_usd;
  const reviewed = `${s.reviews} ${s.reviews === 1 ? 'handover' : 'handovers'} reviewed`;
  if (s.cap_usd == null) return { text: `${usd(used)} this month · ${reviewed}`, warn: false };
  if (s.over_limit_from_earlier) {
    return { text: `Reviews started under your earlier limit are finishing (${usd(used)} of ${usd(s.cap_usd)}). New ones start once this month’s spend is under the limit.`, warn: true };
  }
  // Close enough that another review won't fit.
  if (used >= s.cap_usd * 0.98) return { text: `Monthly limit reached: ${usd(used)} of ${usd(s.cap_usd)}. Reviews start again next month, or when you raise the limit.`, warn: true };
  return { text: `${usd(used)} of ${usd(s.cap_usd)} this month · ${reviewed}`, warn: false };
}
