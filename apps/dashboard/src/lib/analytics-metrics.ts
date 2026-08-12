// Pure analytics math shared by the fleet dashboard and its tests, so the
// tests guard the real implementation instead of a hand-mirrored copy that
// can silently drift out of sync with the dashboard.

const DAY_MS = 86400000;

/** Blended $/token cost of the tokens WhiteRoom saved (mirrors the engine's pricing). */
export function estimateCost(tokensSaved: number): number {
  return tokensSaved * 0.8 * 0.0000008 + tokensSaved * 0.2 * 0.000004;
}

/**
 * UTC date cutoff (YYYY-MM-DD) for an analytics range. An entry is in range
 * when its own YYYY-MM-DD is >= the returned cutoff — lexical comparison is
 * safe for ISO date strings.
 */
export function getCutoff(range: string, nowMs: number): string {
  const todayKey = new Date(nowMs).toISOString().slice(0, 10);
  if (range === 'today') return todayKey;
  if (range === '7d') return new Date(nowMs - 6 * DAY_MS).toISOString().slice(0, 10);
  if (range === '30d') return new Date(nowMs - 29 * DAY_MS).toISOString().slice(0, 10);
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
