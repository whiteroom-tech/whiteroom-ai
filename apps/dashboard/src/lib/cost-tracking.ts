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

type TasksLeftReason = 'budget_missing' | 'task_type_missing' | 'partial_coverage' | 'available' | undefined;

/**
 * Picks the dollar or token tasks-left figure. An engine that reports the
 * independent fields sets `dollarRemainingTasksReason`/`tokenRemainingTasksReason`
 * on every response, even when the value itself is null, so an undefined
 * reason on the kind asked for means an older engine: fall back to the one
 * combined `remainingTasks`/`remainingTasksReason`, picked by `costUnavailable`
 * the way the card used to show a single figure. On a legacy response, the
 * *other* kind has nothing to show at all (that engine never computed it).
 */
export function resolveTasksLeft(
  f: Pick<PerformanceCostForecastResult, 'remainingTasks' | 'remainingTasksReason' | 'costUnavailable' | 'dollarRemainingTasks' | 'dollarRemainingTasksReason' | 'tokenRemainingTasks' | 'tokenRemainingTasksReason'>,
  kind: 'dollar' | 'token',
): { value: number | null; reason: TasksLeftReason } {
  if (kind === 'dollar' && f.dollarRemainingTasksReason !== undefined) {
    return { value: f.dollarRemainingTasks ?? null, reason: f.dollarRemainingTasksReason };
  }
  if (kind === 'token' && f.tokenRemainingTasksReason !== undefined) {
    return { value: f.tokenRemainingTasks ?? null, reason: f.tokenRemainingTasksReason };
  }
  const legacyIsThisKind = kind === 'dollar' ? !f.costUnavailable : f.costUnavailable;
  return legacyIsThisKind
    ? { value: f.remainingTasks, reason: f.remainingTasksReason }
    : { value: null, reason: undefined };
}

/**
 * Why there's no tasks-remaining figure (audit M11): a saved budget is
 * never asked for again. The dollar and token sides are tracked
 * independently (one being unavailable shouldn't borrow the other's
 * wording), so `kind` picks which noun the budget_missing case names.
 * An undefined reason (nothing computed for this kind at all, e.g. a
 * legacy engine that never reported it) gets its own neutral wording —
 * it must never read as "set a budget" when one may already be set.
 */
export function remainingTasksNoteFor(reason: TasksLeftReason, kind: 'dollar' | 'token'): string {
  switch (reason) {
    case 'task_type_missing': return 'give an agent a task type to estimate tasks left';
    case 'partial_coverage': return 'some of today’s calls have no price on file, so tasks left can’t be estimated';
    case 'budget_missing': return kind === 'token' ? 'set a daily token budget to see tasks left' : 'set a daily budget to see tasks left';
    default: return 'tasks left isn’t available right now';
  }
}

/** Tasks-left figure color: red at or below zero, amber running low, green otherwise. */
export function tasksLeftColor(value: number | null): string {
  if (value == null) return 'var(--tx3)';
  if (value <= 0) return 'var(--bad)';
  if (value < 5) return 'var(--warn)';
  return 'var(--ok)';
}
