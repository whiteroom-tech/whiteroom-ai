// Performance's range: the same menu and days as Runs (Today · 7 days ·
// 30 days · Custom, in the viewer's calendar days), read through the
// engine's explicit windows (performance_index / _fleet_hourly from–to).
import { WhiteRoomApiError, type ReadWindow } from '@/lib/whiteroom/client';
import { clampSpan, localDay, oldestKept, RUNS_RANGES, validDay, type RunsRange, type RunsView } from '@/lib/runs';
import { HOUR_MS } from '@/lib/format';

/** The longest window the engine reads at once (performance/window.ts MAX_WINDOW_DAYS). */
export const PERF_MAX_DAYS = 31;
/** How far back the engine keeps hourly totals (worker/aggregator.ts), whatever the plan keeps. */
export const PERF_HISTORY_DAYS = 90;
/** An older engine reads hours_back up to this (14 days). */
const LEGACY_MAX_HOURS = 336;

/** The ranges an older engine can't read: 30 days goes past its 14, and Custom can end in the past. */
export const NEEDS_WINDOWS: RunsRange[] = ['30d', 'custom'];

/** The first day Performance can show: what the plan keeps, at most the engine's 90 days. */
export function perfOldest(retentionDays: number | null | undefined, now: number = Date.now()): string {
  return oldestKept(Math.min(retentionDays && retentionDays > 0 ? retentionDays : PERF_HISTORY_DAYS, PERF_HISTORY_DAYS), now)!;
}

/**
 * The range a Performance link names: ?range=today|7d|30d|custom with
 * ?from=&to= days for Custom. An old ?hours=24 link is Today; other old
 * links and anything unknown are 7 days.
 */
export function perfViewFromParams(params: URLSearchParams, oldest: string, now: number = Date.now()): RunsView {
  const r = params.get('range');
  const range: RunsRange = (RUNS_RANGES as (string | null)[]).includes(r) ? r as RunsRange : params.get('hours') === '24' ? 'today' : '7d';
  if (range !== 'custom') return { range, day: null };
  const f = validDay(params.get('from'), now);
  const t = validDay(params.get('to'), now);
  const span = f && t ? clampSpan(f, t, { today: localDay(now), oldest, maxDays: PERF_MAX_DAYS }) : null;
  return { range, day: null, from: span?.from ?? null, to: span?.to ?? null };
}

/** What a Performance URL keeps: defaults (7 days) drop out, Custom keeps its days. The old ?hours goes. */
export function perfRangeParams(view: RunsView): Record<string, string | null> {
  const custom = view.range === 'custom' && view.from && view.to;
  return { range: view.range === '7d' ? null : view.range, from: custom ? view.from! : null, to: custom ? view.to! : null, hours: null };
}

/**
 * hours_back for engines that read only that (performance_fleet_hourly): the
 * hours from `from` to the end of this hour, or undefined past their 14 days.
 */
export function legacyHoursBack(w: ReadWindow, now: number = Date.now()): number | undefined {
  if (w.to) return undefined;
  const end = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
  const h = Math.ceil((end - w.from.getTime()) / HOUR_MS);
  return h >= 1 && h <= LEGACY_MAX_HOURS ? h : undefined;
}

/**
 * True when the engine is older than explicit windows: it refuses a start
 * past 14 days with its own reason, or answers a window ending in the past
 * as if it ended now.
 */
export function windowUnsupported(r: { error: unknown } | { period?: { end: string } }, to: Date | null): boolean {
  if ('error' in r) return r.error instanceof WhiteRoomApiError && r.error.status === 400 && /within the last 14 days/.test(r.error.reason ?? '');
  return to !== null && !!r.period && Date.parse(r.period.end) !== to.getTime();
}
