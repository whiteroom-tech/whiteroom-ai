// Captions for Performance's Cost tracking card (dashboard audit M10, M11).

import type { PerformanceCostForecastResult } from './whiteroom/types';

/** What the burn rate averages: hours with calls, over the engine's lookback. */
export function burnCaption(f: Pick<PerformanceCostForecastResult, 'burnLookbackHours'>): string {
  return f.burnLookbackHours ? `per working hour, last ${Math.round(f.burnLookbackHours / 24)} days` : 'spending per hour';
}

/** Why there's no tasks-remaining figure (audit M11): a saved budget is never asked for again. */
export function remainingTasksNote(f: Pick<PerformanceCostForecastResult, 'costUnavailable' | 'remainingTasksReason'>): string {
  switch (f.remainingTasksReason) {
    case 'task_type_missing': return 'give an agent a task type to estimate tasks left';
    case 'partial_coverage': return 'some of today’s calls have no price on file, so tasks left can’t be estimated';
    default: return f.costUnavailable ? 'set a daily token budget to see tasks left' : 'set a daily budget to see tasks left';
  }
}
