// Captions for Performance's Cost tracking card (dashboard audit M10, M11).

import type { PerformanceCostForecastResult } from './whiteroom/types';

/** What the burn rate averages: hours with calls, over the engine's lookback. */
export function burnCaption(f: Pick<PerformanceCostForecastResult, 'burnLookbackHours'>): string {
  const h = f.burnLookbackHours;
  if (!h) return 'spending per hour';
  if (h < 24) return `per working hour, last ${h} ${h === 1 ? 'hour' : 'hours'}`;
  const d = Math.round(h / 24);
  return `per working hour, last ${d === 1 ? 'day' : `${d} days`}`;
}

/**
 * Why there's no tasks-remaining figure (audit M11): a saved budget is
 * never asked for again. The dollar and token sides are tracked
 * independently (one being unavailable shouldn't borrow the other's
 * wording), so `kind` picks which noun the budget_missing case names.
 */
export function remainingTasksNoteFor(
  reason: 'budget_missing' | 'task_type_missing' | 'partial_coverage' | 'available' | undefined,
  kind: 'dollar' | 'token',
): string {
  switch (reason) {
    case 'task_type_missing': return 'give an agent a task type to estimate tasks left';
    case 'partial_coverage': return 'some of today’s calls have no price on file, so tasks left can’t be estimated';
    default: return kind === 'token' ? 'set a daily token budget to see tasks left' : 'set a daily budget to see tasks left';
  }
}
