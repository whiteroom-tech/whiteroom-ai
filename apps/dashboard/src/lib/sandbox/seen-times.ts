// Time left from what the page saw (the engine sends no stage or task timing):
// when each step (a live test, a practice task) was seen to finish. Shared by
// the check in progress and practice tasks. Pure, so the page and tests share it.

/** Each finished step's time in ms: from the one before (the first from the start); null when not seen. */
export function seenDurations(seen: (number | null)[], startedAt: number | null): (number | null)[] {
  return seen.map((at, i) => {
    const from = i === 0 ? startedAt : seen[i - 1];
    return at !== null && from !== null && from !== undefined && at > from ? at - from : null;
  });
}

/**
 * Time left in ms: the average of the steps seen finishing, times the steps
 * still to go, less what the step now running has had. Null until one step's
 * time is known, or once all are done.
 */
export function leftMs(seen: (number | null)[], startedAt: number | null, total: number, now: number): number | null {
  const known = seenDurations(seen, startedAt).filter((x): x is number => x !== null);
  const last = seen[seen.length - 1];
  if (!known.length || last == null || seen.length >= total) return null;
  return Math.max(0, (known.reduce((a, b) => a + b, 0) / known.length) * (total - seen.length) - (now - last));
}
