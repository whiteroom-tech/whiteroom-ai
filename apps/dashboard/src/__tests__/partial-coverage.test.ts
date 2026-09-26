import { describe, it, expect } from 'vitest';
import { localDayFromTs, partialCoverageSince } from '../lib/analytics-metrics';

// Audit F14: range totals must admit when the engine has trimmed history
// the range asks for, instead of presenting a partial sum as the whole range.
const NOW = new Date(2026, 8, 26, 12).getTime();
const threeDaysAgo = new Date(2026, 8, 23, 12).toISOString();

describe('partialCoverageSince', () => {
  it('flags a range that reaches before the retained history', () => {
    const since = partialCoverageSince('7d', { retainedSince: threeDaysAgo, historyTruncated: true }, NOW);
    expect(since).toBe(localDayFromTs(threeDaysAgo));
    expect(partialCoverageSince('recent', { retainedSince: threeDaysAgo, historyTruncated: true }, NOW)).not.toBeNull();
  });

  it('stays quiet when the range is fully covered', () => {
    expect(partialCoverageSince('today', { retainedSince: threeDaysAgo, historyTruncated: true }, NOW)).toBeNull();
  });

  it('stays quiet when nothing was trimmed or the engine does not say', () => {
    expect(partialCoverageSince('30d', { retainedSince: threeDaysAgo, historyTruncated: false }, NOW)).toBeNull();
    expect(partialCoverageSince('30d', {}, NOW)).toBeNull();
  });
});
