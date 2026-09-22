// Pure analytics math shared by the fleet dashboard and its tests, so the
// tests guard the real implementation instead of a hand-mirrored copy that
// can silently drift out of sync with the dashboard.

/** Blended $/token cost of the tokens WhiteRoom saved (mirrors the engine's pricing). */
export function estimateCost(tokensSaved: number): number {
  return tokensSaved * 0.8 * 0.0000008 + tokensSaved * 0.2 * 0.000004;
}

/** YYYY-MM-DD in the browser's local timezone. */
function localDay(d: Date): string {
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
  const days = range === 'today' ? 0 : range === '7d' ? 6 : range === '30d' ? 29 : null;
  if (days === null) return '1970-01-01';
  const cutoff = new Date(nowMs);
  // Calendar days, not 24-hour durations: DST changes the length of a day.
  cutoff.setDate(cutoff.getDate() - days);
  return localDay(cutoff);
}

/** Tokens saved by a handover: compressed context minus the handover doc (default 300). */
export function handoverSaved(e: { contextTokens?: number; handoverDocTokens?: number }): number {
  const ctx = e.contextTokens ?? 0;
  const doc = e.handoverDocTokens ?? 300;
  return Math.max(0, ctx - doc);
}

/** Composite grouping key: day + agent + watch number. */
export function watchKey(day: string, agentId: string, watchNumber: number): string {
  return `${day}:${agentId}:${watchNumber}`;
}
