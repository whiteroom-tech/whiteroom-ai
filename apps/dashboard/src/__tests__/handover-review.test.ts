import { describe, it, expect } from 'vitest';
import { reviewSpendLine } from '@/lib/handover-review';
import type { HandoverReviewStatus } from '@/lib/whiteroom/client';

const s = (o: Partial<HandoverReviewStatus>): HandoverReviewStatus => ({
  review_mode: 'realtime', month: '2026-10', cap_usd: 20, spent_usd: 3.5, reserved_usd: 0.25, reviews: 12,
  verdicts: { retained: 0, dropped: 0, contradicted: 0, unverified: 0 }, over_limit_from_earlier: false, ...o,
});

describe('review spend line', () => {
  it('counts running reviews as used', () => {
    expect(reviewSpendLine(s({}))).toEqual({ text: '$3.75 of $20.00 this month · 12 handovers reviewed', warn: false });
    expect(reviewSpendLine(s({ reviews: 1 })).text).toMatch(/1 handover reviewed$/);
  });
  it('says when the limit is reached, and when earlier reviews run over a lowered one', () => {
    expect(reviewSpendLine(s({ spent_usd: 19.9 }))).toMatchObject({ warn: true, text: expect.stringMatching(/^Monthly limit reached/) });
    expect(reviewSpendLine(s({ cap_usd: 2, over_limit_from_earlier: true }))).toMatchObject({ warn: true, text: expect.stringMatching(/earlier limit/) });
  });
});
