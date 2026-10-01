// Pure helpers for Runs (README › Screens › 2a / 2b). A run is one agent's
// shift; the engine's list_runs / get_run_events serve them.

import type { RunEvent, RunSummary } from '@/lib/whiteroom/types';
import type { IconName, TagTone } from '@whiteroom/ui';
import { activityRow, clock } from '@/lib/home';

export type RunsRange = 'today' | '7d' | '30d';
export const RUNS_RANGES: RunsRange[] = ['today', '7d', '30d'];

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole UTC days, the same days "Model calls today" counts: today, or the last 7 / 30 including today. */
export function runsDays(range: RunsRange, now: number = Date.now()): { fromDay: string; toDay: string } {
  const back = range === 'today' ? 0 : range === '7d' ? 6 : 29;
  return { fromDay: utcDay(now - back * 86_400_000), toDay: utcDay(now) };
}

/** "45 s", "23 min", "1 h 05 min". */
export function fmtLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export type StandOutTone = 'rule' | 'failed' | 'coverage' | 'clean';

/**
 * The run table's "What stood out", from what the run's record shows.
 * Unusual-behaviour flags arrive with P2; until then a rule block or failed
 * calls lead, and otherwise coverage: "Nothing unusual" only when every call
 * could be read, never a clean answer for something that wasn't measured.
 */
export function standOut(run: Pick<RunSummary, 'calls' | 'failedCalls' | 'blockedCalls' | 'coverage'>): { tone: StandOutTone; text: string } {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (run.blockedCalls > 0) return { tone: 'rule', text: `A rule blocked ${plural(run.blockedCalls, 'call')}` };
  if (run.failedCalls > 0) return { tone: 'failed', text: `${plural(run.failedCalls, 'call')} failed` };
  const { calls, checked } = run.coverage;
  if (calls > 0 && checked === 0) return { tone: 'coverage', text: 'Not assessed: none of its calls could be read' };
  if (checked < calls) return { tone: 'coverage', text: `Partly checked: ${checked} of ${calls} calls could be read` };
  return { tone: 'clean', text: 'Nothing unusual' };
}

/** "Sep 30, 1:52 pm" in the viewer's time zone, always with the date. */
export function fmtStarted(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toLowerCase();
  return `${date}, ${time}`;
}

/** The viewer's time zone abbreviation, e.g. "PDT", for the footer. */
export function zoneName(now: number = Date.now()): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(now)).find((p) => p.type === 'timeZoneName');
  return part?.value ?? 'local time';
}

/** "6 in the last 7 days" / "2 today". */
export function runsCount(total: number, range: RunsRange): string {
  const span = range === 'today' ? 'today' : range === '7d' ? 'in the last 7 days' : 'in the last 30 days';
  return `${total} ${span}`;
}

/** Where Run detail's "← Runs" returns to (README › Runs › Leaving and returning). */
export const RUNS_LIST_URL_KEY = 'wr_runs_list_url';

/** /runs/<runId>, with the list URL to return to. */
export function runHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

// ── Run detail (screen 2b) ─────────────────────────────────────────────────


export interface TimelineRow {
  id: string;
  time: string;
  icon: IconName;
  iconColor: string;
  text: string;
  tag?: { label: string; tone: TagTone };
}

const CALL_OUTCOME: Record<string, { label: string; tone: TagTone } | undefined> = {
  upstream_error: { label: 'Failed', tone: 'warn' },
  stream_interrupted: { label: 'Interrupted', tone: 'warn' },
  governance_blocked: { label: 'Blocked', tone: 'muted' },
  client_cancelled: { label: 'Cancelled', tone: 'muted' },
  unknown: { label: 'Status unknown', tone: 'muted' },
};

/**
 * One row of What happened. Calls say what the agent called and which tools
 * it used; events reuse the activity feed's plain-language copy, so the same
 * event reads the same everywhere.
 */
export function timelineRow(e: RunEvent): TimelineRow {
  if (e.kind === 'call') {
    // "persist_lead ×3, notify": one entry per tool, with how many times.
    const counts = new Map<string, number>();
    for (const t of e.tools ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    const named = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t));
    const tools = named.length ? ` · used ${named.slice(0, 4).join(', ')}${named.length > 4 ? ` +${named.length - 4} more` : ''}` : '';
    return {
      id: e.id, time: clock(e.at), icon: 'dash', iconColor: 'var(--tx2)',
      text: `Model call${e.model ? ` · ${e.model}` : ''}${tools}`,
      tag: CALL_OUTCOME[e.type],
    };
  }
  const row = activityRow({ ...(e.detail ?? {}), id: e.id, type: e.type, timestamp: e.at } as Parameters<typeof activityRow>[0]);
  const handover = /handover|watch_start|watch_end|rest/.test(e.type);
  const rule = e.type.startsWith('governance');
  return {
    id: e.id, time: row.time, text: row.text, tag: row.tag,
    icon: handover ? 'swap' : rule ? 'lock' : 'info',
    iconColor: handover ? 'var(--ho)' : rule ? 'var(--tx)' : 'var(--tx2)',
  };
}

/** "Sep 30 · started 1:52 pm EDT · 23 min · shift 8". */
export function runMeta(run: { startedAt: string; endedAt: string; shift: number }, now: number = Date.now()): string {
  const start = new Date(run.startedAt);
  const date = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toLowerCase();
  const length = fmtLength((Date.parse(run.endedAt) - start.getTime()) / 1000);
  return `${date} · started ${time} ${zoneName(now)} · ${length} · shift ${run.shift}`;
}
