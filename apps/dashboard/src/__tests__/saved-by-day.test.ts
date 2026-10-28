// "Saved by WhiteRoom" on Performance adds up as the bill does: smaller
// context plus the caching WhiteRoom added, day by day.
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cacheSavedTotal, savedByDay } from '@/lib/analytics-metrics';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

describe('savedByDay', () => {
  it('adds each day\'s cache savings to its smaller-context savings, once', () => {
    expect(savedByDay(
      [{ day: '2026-10-26', usdMicros: 100 }, { day: '2026-10-27', usdMicros: 50 }],
      [{ day: '2026-10-27', usdMicros: 5 }, { day: '2026-10-28', usdMicros: 7 }],
    )).toEqual({ '2026-10-26': 100, '2026-10-27': 55, '2026-10-28': 7 }); // a cache-only day counts too
  });
  it('is smaller context alone on an engine without the cache split', () => {
    expect(savedByDay([{ day: '2026-10-26', usdMicros: 100 }])).toEqual({ '2026-10-26': 100 });
  });
});

describe('cacheSavedTotal', () => {
  it('sums the days, or is null when the engine doesn\'t split them', () => {
    expect(cacheSavedTotal([{ usdMicros: 3, unpricedReadTokens: 0 }, { usdMicros: 4, unpricedReadTokens: 9 }])).toEqual({ micros: 7, unpricedReadTokens: 9 });
    expect(cacheSavedTotal([])).toEqual({ micros: 0, unpricedReadTokens: 0 });
    expect(cacheSavedTotal(undefined)).toBeNull();
  });
});

describe('Performance › Saved by WhiteRoom', async () => {
  const { IndexView } = await import('@/app/(citadel)/performance/_components/IndexView');
  const data = {
    fleetId: 'f1', period: { start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' },
    summary: { totalCalls: 1, totalCost: 0, avgLatencyMs: null, errorRate: 0, models: [], cache: { freshInputTokens: 0, readTokens: 0, writeTokens: 0, readSavedMicros: 900_000, writePremiumMicros: 0, unpricedReadTokens: 0 } },
    recommendations: [], priceInfo: { version: '1', ageDays: 1, stale: false, expired: false },
  };
  const saved = (cacheSaved: object | null) => renderToStaticMarkup(h(IndexView, {
    data, hourlyData: { hourly: [] }, auditFailed: false, govSavings: { tokensSaved: 10, costSaved: 1, partial: false }, govCounts: null,
    savingsDays: null, agentIds: null, rangeLabel: 'last 24 h', fleetId: 'f1', authKey: 'k', cacheSaved,
    onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback: async () => 'done', feedbackLoading: null, feedbackError: null,
  } as never)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('adds the per-day cache figures (what billing sums), not the range\'s own', () => {
    expect(saved({ micros: 500_000, unpricedReadTokens: 0 })).toMatch(/Saved by WhiteRoom \$1\.50/);
  });
  it('falls back to the range\'s cache figure on an engine without the split', () => {
    expect(saved(null)).toMatch(/Saved by WhiteRoom \$1\.90/);
  });
});
