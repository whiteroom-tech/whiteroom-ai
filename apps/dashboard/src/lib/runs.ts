// Pure helpers for Runs (README › Screens › 2a / 2b). A run is one agent's
// shift; the engine's list_runs / get_run_events serve them.

import type { AuditEntry, RunEvent, RunEventsResult, RunSummary } from '@/lib/whiteroom/types';
import type { Sheet } from '@/lib/xlsx';
import type { IconName, TagTone } from '@whiteroom/ui';
import { activityRow, clock } from '@/lib/home';

export type RunsRange = 'today' | '7d' | '30d';
export const RUNS_RANGES: RunsRange[] = ['today', '7d', '30d'];

/**
 * The viewer's IANA time zone, which Runs' days are in. Anything that isn't a
 * plain IANA name (the engine accepts only those) falls back to UTC.
 */
export function viewerTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+){1,2})$/.test(tz) ? tz : 'UTC';
}

/** "2026-09-30" for the viewer's local day holding `ms`. */
export function localDay(ms: number = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The calendar day `n` days after `day` (negative for before). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n, 12).getTime());
}

/** The viewer's local days: today, or the last 7 / 30 including today. */
export function runsDays(range: RunsRange, now: number = Date.now()): { fromDay: string; toDay: string } {
  const back = range === 'today' ? 0 : range === '7d' ? 6 : 29;
  const today = localDay(now);
  return { fromDay: addDays(today, -back), toDay: today };
}

/** The days a Runs view covers: one picked day, else the range. */
export function runsWindow(view: { range: RunsRange; day: string | null }, now: number = Date.now()): { fromDay: string; toDay: string } {
  return view.day ? { fromDay: view.day, toDay: view.day } : runsDays(view.range, now);
}

/** "Tue, Sep 30"; with `relative`, "Today · Wed, Oct 1" and "Yesterday · …" for the two latest days. */
export function dayLabel(day: string, now: number = Date.now(), relative = true): string {
  const [y, m, d] = day.split('-').map(Number);
  const text = new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (!relative) return text;
  const today = localDay(now);
  if (day === today) return `Today · ${text}`;
  if (day === addDays(today, -1)) return `Yesterday · ${text}`;
  return text;
}

/** The day strip: every day of the last `n` ending today, oldest first, zero where no runs started. */
export function stripDays(counts: { day: string; runs: number }[], n = 30, now: number = Date.now()): { day: string; runs: number }[] {
  const byDay = new Map(counts.map((c) => [c.day, c.runs]));
  const today = localDay(now);
  return Array.from({ length: n }, (_, i) => { const day = addDays(today, i - n + 1); return { day, runs: byDay.get(day) ?? 0 }; });
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

/** "Sep 30" and "1:52 pm" in the viewer's time zone (ICU's narrow spaces normalised). */
function dateAndTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toLowerCase(),
  };
}

/** "Sep 30, 1:52 pm" in the viewer's time zone, always with the date. */
export function fmtStarted(iso: string): string {
  const { date, time } = dateAndTime(iso);
  return `${date}, ${time}`;
}

/** The viewer's time zone abbreviation, e.g. "PDT", for the footer. */
export function zoneName(now: number = Date.now()): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(now)).find((p) => p.type === 'timeZoneName');
  return part?.value ?? 'local time';
}

/** "6 in the last 7 days" / "2 today" / "8 on Tue, Sep 30". */
export function runsCount(total: number, view: { range: RunsRange; day: string | null }, now: number = Date.now()): string {
  if (view.day) return view.day === localDay(now) ? `${total} today` : `${total} on ${dayLabel(view.day, now, false)}`;
  const span = view.range === 'today' ? 'today' : view.range === '7d' ? 'in the last 7 days' : 'in the last 30 days';
  return `${total} ${span}`;
}

/** Where Run detail's "← Runs" returns to (README › Runs › Leaving and returning). */
export const RUNS_LIST_URL_KEY = 'wr_runs_list_url';

/** "lead-agent~8" → agent and shift; null when malformed (no "~", no number). */
export function parseRunId(runId: string): { agentId: string; shift: number } | null {
  const at = runId.lastIndexOf('~');
  if (at <= 0 || !/^\d{1,9}$/.test(runId.slice(at + 1))) return null;
  return { agentId: runId.slice(0, at), shift: Number(runId.slice(at + 1)) };
}

/**
 * Every run in a range for an export, page by page, up to `maxPages`.
 * `truncated` when there were more; `unsupported` when the engine has no
 * list_runs. Errors propagate.
 */
export async function collectRuns(
  fetchPage: (cursor: string | null) => Promise<{ runs: RunSummary[]; cursor: string | null } | { unsupported: true }>,
  maxPages: number,
): Promise<{ runs: RunSummary[]; truncated: boolean } | { unsupported: true }> {
  const runs: RunSummary[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    if ('unsupported' in page) return page;
    runs.push(...page.runs);
    cursor = page.cursor;
    if (!cursor) return { runs, truncated: false };
  }
  return { runs, truncated: true };
}

/** /runs/<runId>. */
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

/**
 * "Sep 30 · started 1:52 pm EDT · 23 min · shift 8". The zone name is the
 * start time's, so a run from before a DST change keeps its own abbreviation.
 */
export function runMeta(run: { startedAt: string; endedAt: string; shift: number }): string {
  const { date, time } = dateAndTime(run.startedAt);
  const length = fmtLength((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000);
  return `${date} · started ${time} ${zoneName(Date.parse(run.startedAt))} · ${length} · shift ${run.shift}`;
}

export type RunKind = 'all' | 'events';
export type RunPageQuery = { cursor?: string | null; eventId?: string | null; kind: RunKind };

/**
 * One Run detail load. With a deep-linked event it asks for the page holding
 * it, falls back to Everything when the event is a call (not in Events only),
 * and returns that page as the cursor so later polls stay on it.
 */
export async function loadRunPage(
  get: (q: RunPageQuery) => Promise<RunEventsResult>,
  q: { target: string | null; kind: RunKind; cursor: string | null },
): Promise<{ res: RunEventsResult; kind: RunKind; cursor: string | null; highlight: string | null }> {
  if (!q.target) return { res: await get({ cursor: q.cursor, kind: q.kind }), kind: q.kind, cursor: q.cursor, highlight: null };
  let kind = q.kind;
  let res = await get({ eventId: q.target, kind });
  if (res.eventFound === false && kind === 'events') {
    kind = 'all';
    res = await get({ eventId: q.target, kind });
  }
  return { res, kind, cursor: res.page > 0 ? String(res.page) : null, highlight: res.eventFound ? q.target : null };
}

/** The old event feed's export: every event, and the finished tasks alone. */
export function eventFeedSheets(entries: AuditEntry[]): Sheet[] {
  const header = ['Time', 'Agent', 'Shift', 'Type', 'Task / Event', 'Tokens', 'Minutes', 'Remaining', 'Tool Calls'];
  const row = (e: AuditEntry) => [
    new Date(e.timestamp).toLocaleString('en-US', { hour12: false }), e.agentId || '', e.watchNumber, e.type || '',
    e.type === 'task_complete' ? e.taskName || '' : '', e.tokensUsed, e.minutesSpent, e.remaining,
    (Array.isArray(e.details) ? e.details : []).map((d) => (d.args ? `${d.name}(${d.args})` : d.name)).join('  |  '),
  ];
  return [
    { name: 'All Events', header, rows: entries.map(row) },
    { name: 'Tasks Only', header, rows: entries.filter((e) => e.type === 'task_complete').map(row) },
  ];
}

/** Runs export: spend is a lower bound when some calls had no price, so that count gets its own column. */
export const RUNS_EXPORT_HEADER = ['Run', 'Agent', 'Shift', 'Started (UTC)', 'Length (s)', 'Calls', 'Failed', 'Blocked', 'Spend (USD)', 'Unpriced calls', 'What stood out'];
export function runsExportRow(r: RunSummary): (string | number)[] {
  return [r.runId, r.agentId, r.shift, r.startedAt, r.lengthSeconds, r.calls, r.failedCalls, r.blockedCalls, Math.round(r.spendMicros) / 1e6, r.unpricedAttempts, standOut(r).text];
}
