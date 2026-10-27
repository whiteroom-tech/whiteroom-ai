// fmtTokens' thresholds: exact below 1,000, one decimal of a thousand below
// 100K, whole thousands above, two decimals of a million below 10M, and never
// a trailing ".0" or a "1000K".
import { describe, expect, it } from 'vitest';
import { fmtTokens } from '@/lib/format';

describe('fmtTokens', () => {
  it('keeps counts under 1,000 exact', () => {
    expect([0, 7, 980, 999].map(fmtTokens)).toEqual(['0', '7', '980', '999']);
  });

  it('shows thousands with one decimal below 100K, whole above, never ".0"', () => {
    expect([1000, 1050, 4000, 4100, 12_340, 99_940, 99_950, 120_000, 999_499].map(fmtTokens))
      .toEqual(['1K', '1.1K', '4K', '4.1K', '12.3K', '99.9K', '100K', '120K', '999K']);
  });

  it('moves to millions before "1000K", with two decimals below 10M', () => {
    expect([999_500, 1_000_000, 1_500_000, 1_650_000, 4_030_000, 12_000_000, 12_540_000].map(fmtTokens))
      .toEqual(['1M', '1M', '1.5M', '1.65M', '4.03M', '12M', '12.5M']);
  });
});
