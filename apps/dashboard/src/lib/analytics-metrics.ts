// Pure analytics math shared by the fleet dashboard and its tests, so the
// tests guard the real implementation instead of a hand-mirrored copy that
// can silently drift out of sync with the dashboard.

const DAY_MS = 86400000;

/** Blended $/token cost of the tokens WhiteRoom saved (mirrors the engine's pricing). */
export function estimateCost(tokensSaved: number): number {
  return tokensSaved * 0.8 * 0.0000008 + tokensSaved * 0.2 * 0.000004;
}

/** YYYY-MM-DD in the browser's local timezone. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local YYYY-MM-DD from an ISO timestamp string. */
export function localDayFromTs(ts: string): string {
  return localDay(new Date(ts));
}

/**
 * Local-date cutoff (YYYY-MM-DD) for an analytics range. An entry is in range
 * when its local YYYY-MM-DD is >= the returned cutoff.
 */
export function getCutoff(range: string, nowMs: number): string {
  if (range === 'today') return localDay(new Date(nowMs));
  if (range === '7d') return localDay(new Date(nowMs - 6 * DAY_MS));
  if (range === '30d') return localDay(new Date(nowMs - 29 * DAY_MS));
  return '1970-01-01';
}

/** Tokens saved by a handover: compressed context minus the handover doc (default 300). */
export function handoverSaved(e: { contextTokens?: number; handoverDocTokens?: number }): number {
  const ctx = e.contextTokens || 0;
  const doc = e.handoverDocTokens || 300;
  return Math.max(0, ctx - doc);
}

/** Composite grouping key: day + agent + watch number. */
export function watchKey(day: string, agentId: string, watchNumber: number): string {
  return `${day}:${agentId}:${watchNumber}`;
}
