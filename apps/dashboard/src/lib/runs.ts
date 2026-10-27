// Pure helpers for Runs (README › Screens › 2a / 2b). A run is one agent's
// shift; the engine's list_runs / get_run_events serve them.

import type { AuditEntry, CallRuleAction, GovernanceRuleType, RunEvent, RunEventsResult, RunFlag, RunHeader, RunRuleAction, RunSummary } from '@/lib/whiteroom/types';
import type { Sheet } from '@/lib/xlsx';
import type { TagTone } from '@whiteroom/ui';
import { activityRow, clock, usd } from '@/lib/home';
import { REASON_LABELS, RULE_LABELS } from '@/lib/governance';
import { MODE_LABEL, NOTIFY } from '@/lib/vocab';
import { counted, fmtTime, DAY_MS, plural } from '@/lib/format';

export type RunsPreset = 'today' | '7d' | '30d';
export type RunsRange = RunsPreset | 'custom';
export const RUNS_RANGES: RunsRange[] = ['today', '7d', '30d', 'custom'];
/** The engine reads at most this many days per request (run-id.ts MAX_RUN_DAYS). */
export const MAX_SPAN_DAYS = 92;

/** What Runs shows: one picked day, else a custom from–to, else a preset range. */
export type RunsView = { range: RunsRange; day: string | null; from?: string | null; to?: string | null };

/** IANA zone names the engine accepts: "UTC", "GMT", "America/New_York", "America/Argentina/Salta". Matches run-id.ts in the engine. */
export const TIME_ZONE_NAME = /^[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+){0,2}$/;

/**
 * The viewer's IANA time zone, which Runs' days are in. Browsers report IANA
 * names; if one ever didn't fit, days here stay local while the engine would
 * read UTC, so that (unseen) case falls back to UTC rather than a 400.
 */
export function viewerTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && TIME_ZONE_NAME.test(tz) ? tz : 'UTC';
}

/** A ?day= that's a real date and not after today, else null. */
export function validDay(v: string | null, now: number = Date.now()): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) && addDays(v, 0) === v && v <= localDay(now) ? v : null;
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
export function runsDays(range: RunsPreset, now: number = Date.now()): { fromDay: string; toDay: string } {
  const back = range === 'today' ? 0 : range === '7d' ? 6 : 29;
  const today = localDay(now);
  return { fromDay: addDays(today, -back), toDay: today };
}

/** The days a Runs view covers. A custom range without both ends shows the last 30 days. */
export function runsWindow(view: RunsView, now: number = Date.now()): { fromDay: string; toDay: string } {
  if (view.day) return { fromDay: view.day, toDay: view.day };
  if (view.range === 'custom') return view.from && view.to ? { fromDay: view.from, toDay: view.to } : runsDays('30d', now);
  return runsDays(view.range, now);
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/**
 * A custom range the engine will take: ends in order, not after today, not
 * before `oldest` (what the plan keeps), and at most MAX_SPAN_DAYS long. When
 * it's too long, the end the person just moved (`moved`) wins.
 */
export function clampSpan(from: string, to: string, opts: { today: string; oldest?: string | null; moved?: 'from' | 'to' }): { from: string; to: string } {
  let f = from <= to ? from : to;
  let t = from <= to ? to : from;
  if (t > opts.today) t = opts.today;
  if (opts.oldest && f < opts.oldest) f = opts.oldest;
  if (f > t) f = t;
  if (daysBetween(f, t) + 1 > MAX_SPAN_DAYS) {
    if (opts.moved === 'from') t = addDays(f, MAX_SPAN_DAYS - 1);
    else f = addDays(t, 1 - MAX_SPAN_DAYS);
  }
  return { from: f, to: t };
}

/** The first day the plan still keeps, or null when the plan isn't known. */
export function oldestKept(retentionDays: number | null | undefined, now: number = Date.now()): string | null {
  return retentionDays && retentionDays > 0 ? addDays(localDay(now), 1 - retentionDays) : null;
}

/**
 * Where the day strip should end so the shown days are on it: unchanged when
 * their last day is already on the strip, else that last day.
 */
export function stripEndFor(span: { fromDay: string; toDay: string }, end: string, n: number): string {
  const start = addDays(end, 1 - n);
  return span.toDay >= start && span.toDay <= end ? end : span.toDay;
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

/** The day strip: the `n` days ending on `end` (default today), oldest first, zero where no runs started. */
export function stripDays<C extends { day: string; runs: number }>(counts: C[], n = 30, end: string = localDay()): (C | { day: string; runs: number })[] {
  const byDay = new Map(counts.map((c) => [c.day, c]));
  return Array.from({ length: n }, (_, i) => { const day = addDays(end, i - n + 1); return byDay.get(day) ?? { day, runs: 0 }; });
}

/** "45 s", "23 min", "1 h 05 min". */
export function fmtLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export type StandOutTone = 'flag' | 'blocked' | 'rule' | 'failed' | 'coverage' | 'clean';

/** True when an engine without flags (P2.1) answered a `flagged` request with every run. */
export function ignoresFlagged(runs: Pick<RunSummary, 'flags'>[]): boolean {
  return runs.length > 0 && runs.every((r) => r.flags === undefined);
}

/** The hour (0–23) a run started, in the viewer's time zone. */
export function localHour(iso: string): number {
  return new Date(iso).getHours();
}

/** True when the engine ignored the hour filter (before it took `hour`): a run from another hour came back. */
export function ignoresHour(runs: Pick<RunSummary, 'startedAt'>[], hour: number): boolean {
  return runs.some((r) => localHour(r.startedAt) !== hour);
}

/** "9 am", "12 pm": an hour of the day, plainly. */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'am' : 'pm'}`;
}

/** Runs › Show: every run, flagged ones, or ones where a rule acted or would have. */
export type RunsShow = 'all' | 'flagged' | 'rules';

/** True when the engine doesn't count rule actions per run (before E1a), so it ignored the Rule activity filter. */
export function ignoresRuleActivity(runs: Pick<RunSummary, 'wouldActCalls'>[]): boolean {
  return runs.length > 0 && runs.every((r) => r.wouldActCalls === undefined);
}

/** One flag in words: "Repeating the same call: fetch_page ×6", "4 failed calls in a row". */
export function flagText(f: RunFlag): string {
  return f.signal === 'repeating_call' ? `Repeating the same call: ${f.tool} ×${f.calls}` : `${f.calls} failed calls in a row`;
}

/**
 * The run table's "What stood out", from what the run's record shows. A flag
 * leads, then a block, a Record-only "would have blocked", or failed calls.
 * Otherwise coverage: "—" (nothing stood out) only when every call could be
 * read, never a clean answer for something that wasn't measured.
 */
export function standOut(run: Pick<RunSummary, 'calls' | 'failedCalls' | 'blockedCalls' | 'coverage' | 'flags'> & Partial<Pick<RunSummary, 'wouldActCalls'>>): { tone: StandOutTone; text: string } {
  const [first, ...more] = run.flags ?? [];
  if (first) return { tone: 'flag', text: more.length ? `${flagText(first)} · ${counted(more.length, 'more flag')}` : flagText(first) };
  const would = run.wouldActCalls ?? 0;
  if (run.blockedCalls > 0) return { tone: 'blocked', text: `Blocked ${counted(run.blockedCalls, 'call')}${would ? ` · would have blocked ${would} more` : ''}` };
  if (would > 0) return { tone: 'rule', text: `Would have blocked ${counted(would, 'call')}` };
  if (run.failedCalls > 0) return { tone: 'failed', text: `${counted(run.failedCalls, 'call')} failed` };
  const { calls, checked } = run.coverage;
  if (calls > 0 && checked === 0) return { tone: 'coverage', text: 'Not assessed: none of its calls could be read' };
  if (checked < calls) return { tone: 'coverage', text: `Partly checked: ${checked} of ${calls} calls could be read` };
  return { tone: 'clean', text: '—' };
}

/** "0:24", "12:05", "1:02:09": a run's length as a clock, for the Runs table. */
export function fmtClockLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "lead-agent #12": how a run is named in lists and exports. */
export function runName(r: { agentId: string; shift: number }): string {
  return `${r.agentId} #${r.shift}`;
}

/** "Sep 30" and "1:52 pm" in the viewer's time zone (ICU's narrow spaces normalised). */
function dateAndTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    time: fmtTime(d),
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

/** The range a view covers, in words: "last 7 days", "today", "Oct 1 – Oct 20". */
export function spanLabel(view: RunsView, now: number = Date.now()): string {
  if (view.day) return dayLabel(view.day, now, false);
  if (view.range === 'custom') {
    const { fromDay, toDay } = runsWindow(view, now);
    const md = (d: string) => dayLabel(d, now, false).replace(/^\w+, /, '');
    return fromDay === toDay ? dayLabel(fromDay, now, false) : `${md(fromDay)} – ${md(toDay)}`;
  }
  return view.range === 'today' ? 'today' : view.range === '7d' ? 'last 7 days' : 'last 30 days';
}

/**
 * The run table's title: "Showing 12 of 60 runs · last 7 days", or for a
 * picked day "Sat, Oct 24 · 47 runs" (with the hour first when one is picked).
 */
export function runsTitle(o: { shown: number; total: number; view: RunsView; show: RunsShow; hour: number | null }, now: number = Date.now()): string {
  const noun = o.show === 'flagged' ? 'flagged runs' : o.show === 'rules' ? 'runs with rule activity' : 'runs';
  const one = o.show === 'flagged' ? 'flagged run' : o.show === 'rules' ? 'run with rule activity' : 'run';
  const count = o.shown < o.total ? `Showing ${o.shown} of ${o.total} ${noun}` : `${o.total} ${o.total === 1 ? one : noun}`;
  if (o.view.day) return `${o.hour !== null ? `${hourLabel(o.hour)} · ` : ''}${spanLabel(o.view, now)} · ${count}`;
  return `${count} · ${spanLabel(o.view, now)}`;
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

/** A timeline row's mark: ▶ run started, ◇ model call, ✓ finished, ✕ blocked or failed, • another event. */
export type TimelineGlyph = 'start' | 'call' | 'done' | 'bad' | 'event';
export const GLYPH: Record<TimelineGlyph, string> = { start: '▶', call: '◇', done: '✓', bad: '✕', event: '•' };

export interface TimelineRow {
  id: string;
  time: string;
  /** Same minute as the row above: shown quieter. */
  sameTime: boolean;
  glyph: TimelineGlyph;
  text: string;
  tag?: { label: string; tone: TagTone };
  /** A call a rule acted on, or would have: the row is shaded, with what the rule did and its mode. */
  rule?: { text: string; mode: 'watch' | 'enforce' };
}

const CALL_OUTCOME: Record<string, { label: string; tone: TagTone } | undefined> = {
  upstream_error: { label: 'Failed', tone: 'warn' },
  stream_interrupted: { label: 'Interrupted', tone: 'warn' },
  governance_blocked: { label: 'Blocked', tone: 'block' },
  client_cancelled: { label: 'Cancelled', tone: 'muted' },
  unknown: { label: 'Status unknown', tone: 'muted' },
};

/** Why a rule acted, said plainly: "model not on the allowlist". Falls back to the engine's short reason. */
const REASON_TEXT: Record<string, string> = {
  model_not_allowed: 'model not on the allowlist',
  tool_not_allowed: 'tool on the blocked list',
  budget_exceeded: 'over the spend cap',
  loop_detected: 'the same call repeated',
  rate_exceeded: 'too many calls',
  keyword_found: 'a keyword was found',
};
export function reasonText(reason: string | null | undefined): string | null {
  return reason ? REASON_TEXT[reason] ?? REASON_LABELS[reason] ?? null : null;
}

/**
 * What a call row says about tools (audit M18): the tools the model asked to
 * call, never the tools it was merely offered. Asking isn't proof a tool ran,
 * so the word is "asked for". A streamed call's reply isn't read: unknown,
 * so nothing is claimed. Older engines only send offered tools: nothing.
 */
export function callToolsText(e: Pick<RunEvent, 'requestedTools'>): string {
  const requested = e.requestedTools;
  if (!requested?.length) return '';
  // "persist_lead ×3, notify": one entry per tool, with how many times.
  const counts = new Map<string, number>();
  for (const t of requested) counts.set(t, (counts.get(t) ?? 0) + 1);
  const named = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t));
  return ` · asked for ${named.slice(0, 4).join(', ')}${named.length > 4 ? ` +${named.length - 4} more` : ''}`;
}

/** What a rule did to a call, past tense: "would have been blocked", "blocked", "paused the agent". */
const CALL_OUTCOME_TEXT: Record<CallRuleAction['outcome'], string> = {
  would_block: 'would have been blocked', blocked: 'blocked', paused: 'paused the agent', stopped: 'stopped the agent', notified: NOTIFY.done,
};

/** A call's rule note: "would have been blocked: model not on the allowlist". */
function callRule(e: RunEvent): TimelineRow['rule'] {
  const [a, ...more] = e.ruleActions ?? [];
  if (!a) return undefined;
  const why = reasonText(a.reason) ?? (a.ruleName ?? RULE_LABELS[a.ruleType as GovernanceRuleType] ?? 'a rule').toLowerCase();
  return { text: `${CALL_OUTCOME_TEXT[a.outcome] ?? 'blocked'}: ${why}${more.length ? ` (+${more.length} more)` : ''}`, mode: a.mode === 'enforce' ? 'enforce' : 'watch' };
}

const START_EVENT = /^(watch_start|run_started)$/;
const DONE_EVENT = /(watch_end|run_ended|run_finished|task_complete)$/;

/**
 * One row of What happened. Calls say what the agent called and which tools
 * it asked for; the model shows only when it changes from the call before
 * (`prevModel`; the summary line names the run's models). Events reuse the
 * activity feed's plain-language copy, so the same event reads the same everywhere.
 */
export function timelineRow(e: RunEvent, prevModel: string | null = null): TimelineRow {
  if (e.kind === 'call') {
    const tools = callToolsText(e);
    const outcome = CALL_OUTCOME[e.type];
    const bad = e.type === 'governance_blocked' || e.type === 'upstream_error' || e.type === 'stream_interrupted';
    const rule = callRule(e);
    return {
      id: e.id, time: clock(e.at), sameTime: false, glyph: bad ? 'bad' : 'call',
      text: `Model call${e.model && e.model !== prevModel ? ` · ${e.model}` : ''}${tools}`,
      // The rule note already says it was blocked; the tag would repeat it.
      tag: rule && e.type === 'governance_blocked' ? undefined : outcome,
      rule,
    };
  }
  const isRule = e.type.startsWith('governance');
  // A rule event's "×N" also counts repeats folded in from before it, which can
  // be the previous run's; the Rule activity card above counts this run exactly.
  const detail = isRule ? { ...(e.detail ?? {}), occurrences: undefined } : e.detail;
  const row = activityRow({ ...(detail ?? {}), id: e.id, type: e.type, timestamp: e.at } as Parameters<typeof activityRow>[0]);
  const glyph: TimelineGlyph = START_EVENT.test(e.type) ? 'start' : DONE_EVENT.test(e.type) ? 'done' : /block|refus|stop/.test(e.type) ? 'bad' : 'event';
  return { id: e.id, time: row.time, sameTime: false, text: glyph === 'start' ? 'Run started' : row.text, tag: row.tag, glyph };
}

/**
 * A page of What happened, oldest first: a call shows its model only when it
 * changed (`firstModel`, the run's first, is in the summary line), and a time
 * repeated from the row above is quieter.
 */
export function timelineRows(events: RunEvent[], firstModel: string | null = null): TimelineRow[] {
  let model = firstModel;
  let prevTime = '';
  return events.map((e) => {
    const row = timelineRow(e, model);
    if (e.kind === 'call' && e.model) model = e.model;
    row.sameTime = row.time === prevTime;
    prevTime = row.time;
    return row;
  });
}

/** Run totals as the runs list has them: Run detail's fallback on engines without them in get_run_events. */
export type RunTotals = Pick<RunSummary, 'calls' | 'failedCalls' | 'blockedCalls' | 'spendMicros' | 'unpricedAttempts'> & Partial<Pick<RunSummary, 'wouldActCalls'>>;

/** The run's summary line, as parts: "Oct 24, 8:45 pm EDT", "24 s", the counts that are known, its models. */
export function runSummary(run: RunHeader, fallback?: RunTotals | null): {
  started: string; length: string; calls?: number; spend?: string; failed?: number; blocked?: number; wouldBlock?: number; models: string[];
} {
  const t = Date.parse(run.startedAt);
  const micros = run.spendMicros ?? fallback?.spendMicros;
  const unpriced = run.unpricedAttempts ?? fallback?.unpricedAttempts ?? 0;
  return {
    started: `${fmtStarted(run.startedAt)} ${zoneName(t)}`,
    length: fmtLength((Date.parse(run.endedAt) - t) / 1000),
    calls: run.calls ?? fallback?.calls,
    spend: micros === undefined ? undefined : `${usd(micros / 1e6)}${unpriced ? '+' : ''}`,
    failed: run.failedCalls ?? fallback?.failedCalls,
    blocked: run.blockedCalls ?? fallback?.blockedCalls,
    wouldBlock: run.wouldBlockCalls ?? fallback?.wouldActCalls,
    models: run.models ?? [],
  };
}

const RESPONSE_DONE: Record<string, string> = { pause: 'paused the agent', stop: 'stopped the agent', notify: NOTIFY.done };

/** A Rule activity row: "Model allowlist would have blocked |5| calls: model not on the allowlist" (count bold). */
export function ruleActivityRow(a: RunRuleAction): { lead: string; count: number | null; tail: string } {
  const name = RULE_LABELS[a.ruleType] ?? 'A rule';
  const why = reasonText(a.reason);
  const n = a.occurrences;
  const would = a.mode === 'enforce' ? '' : 'would have ';
  if (a.response === 'block') return { lead: `${name} ${a.mode === 'enforce' ? 'blocked' : 'would have blocked'}`, count: n, tail: `${plural(n, 'call')}${why ? `: ${why}` : ''}` };
  return { lead: `${name} ${would}${RESPONSE_DONE[a.response] ?? 'acted'}${n > 1 ? ` ×${n}` : ''}${why ? `: ${why}` : ''}`, count: null, tail: '' };
}

/** The Rule activity card's footer: what the modes meant for the calls. */
export function ruleActivityFooter(actions: RunRuleAction[]): string {
  const watch = actions.some((a) => a.mode !== 'enforce');
  const enforce = actions.some((a) => a.mode === 'enforce');
  if (watch && !enforce) return 'These rules are Record only, so the calls went through.';
  if (enforce && !watch) return 'These rules are set to Block, so they acted.';
  return 'Record only rules let their calls through; rules set to Block acted.';
}

/** The Rule activity header link: one rule opens itself in Controls, several open Controls. */
export function ruleActivityLink(actions: RunRuleAction[]): { href: string; text: string } {
  const ids = [...new Set(actions.map((a) => a.ruleId))];
  if (ids.length === 1) return { href: `/controls?rule=${encodeURIComponent(ids[0])}`, text: `Open ${RULE_LABELS[actions[0].ruleType] ?? 'the rule'} in Controls` };
  return { href: '/controls', text: 'Open Controls' };
}

/** Every event of a run, for Export this run: page after page, up to `maxPages`. */
export async function collectRunEvents(get: (cursor: string | null) => Promise<RunEventsResult>, maxPages = 100): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await get(page === 0 ? null : String(page));
    all.push(...res.events);
    if (res.page + 1 >= res.pages) break;
  }
  return all;
}

/** Export this run: the summary, then every call and event in order, times in the run's zone. */
export function runSheets(run: RunHeader, events: RunEvent[], fallback?: RunTotals | null): Sheet[] {
  const s = runSummary(run, fallback);
  const summary: (string | number)[][] = [['Run', runName(run)], ['Agent', run.agentId], ['Started', s.started], ['Length', s.length]];
  if (s.calls !== undefined) summary.push(['Model calls', s.calls]);
  if (s.spend !== undefined) summary.push(['Spend (USD)', s.spend]);
  if (s.failed !== undefined) summary.push(['Failed calls', s.failed]);
  if (s.blocked !== undefined) summary.push(['Blocked calls', s.blocked]);
  if (s.wouldBlock !== undefined) summary.push(['Would have blocked', s.wouldBlock]);
  if (s.models.length) summary.push(['Models', s.models.join(', ')]);
  const rows = events.map((e) => {
    const r = timelineRow(e);
    const d = new Date(e.at);
    return [`${localDay(d.getTime())} ${d.toLocaleTimeString('en-GB')}`, e.kind === 'call' ? 'Model call' : 'Event', r.text, e.model ?? '', r.tag?.label ?? '', r.rule ? `${r.rule.text} (${MODE_LABEL[r.rule.mode]})` : ''];
  });
  return [
    { name: 'Run', header: ['Field', 'Value'], rows: summary },
    { name: 'What happened', header: [`Time (${zoneName(Date.parse(run.startedAt))})`, 'Kind', 'What', 'Model', 'Outcome', 'Rule'], rows },
  ];
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
  const header = ['Time', 'Agent', 'Run number', 'Type', 'Task / Event', 'Tokens', 'Minutes', 'Remaining', 'Tool Calls'];
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

/**
 * Runs export: one row per run, times in the viewer's zone (named in the
 * header), a link that opens the run. Spend is a lower bound when some calls
 * had no price, so that count gets its own column.
 */
export function runsExportHeader(zone: string = zoneName()): string[] {
  return ['Run', 'Agent', 'Run number', `Started (${zone})`, 'Length (s)', 'Calls', 'Failed', 'Blocked', 'Would have blocked', 'Spend (USD)', 'Unpriced calls', 'What stood out', 'Link'];
}
export function runsExportRow(r: RunSummary, origin = ''): (string | number)[] {
  const d = new Date(r.startedAt);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const started = `${localDay(d.getTime())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return [runName(r), r.agentId, r.shift, started, r.lengthSeconds, r.calls, r.failedCalls, r.blockedCalls, r.wouldActCalls ?? '', Math.round(r.spendMicros) / 1e6, r.unpricedAttempts, standOut(r).tone === 'clean' ? '' : standOut(r).text, `${origin}${runHref(r.runId)}`];
}

/** Export dialog › Which days: yesterday, the last 7 days, or the last 30, as the viewer's days ('shown' is the page's own view, handled by the page). */
export type ExportSpan = 'shown' | 'yesterday' | '7d' | '30d';
export function exportDays(span: Exclude<ExportSpan, 'shown'>, now: number = Date.now()): { fromDay: string; toDay: string } {
  if (span === 'yesterday') { const y = addDays(localDay(now), -1); return { fromDay: y, toDay: y }; }
  return runsDays(span, now);
}

// ── Unusual behaviour (P2.5) ────────────────────────────────────────

/** The five signals (README › Screen 4). Only the first two are measured today; the rest need call data the engine doesn't record yet. */
export const UNUSUAL_SIGNALS = [
  { key: 'repeating_call', label: 'Repeating the same call', measured: true },
  { key: 'error_streak', label: 'Failed calls in a row', measured: true },
  { key: 'new_tool', label: 'A tool it hasn’t used before', measured: false },
  { key: 'token_burst', label: 'A burst of tokens', measured: false },
  { key: 'workaround', label: 'A workaround after a block', measured: false },
] as const;

/** Flagged runs that started on one of `days`, with that day's index: the one rule for "flagged this week". */
export function flaggedInWindow<R extends Pick<RunSummary, 'startedAt' | 'flags'>>(runs: R[], days: string[]): Array<{ run: R; day: number }> {
  return runs.flatMap((run) => {
    const day = days.indexOf(localDay(Date.parse(run.startedAt)));
    return run.flags?.length && day >= 0 ? [{ run, day }] : [];
  });
}

/**
 * Flagged runs over `days` (oldest first), per agent per day, busiest agent
 * first. Which kinds they were is agentSignals() in performance-insights.
 */
export function unusualSummary(runs: Pick<RunSummary, 'agentId' | 'startedAt' | 'flags'>[], days: string[]): {
  byAgent: { agentId: string; perDay: number[]; total: number }[];
} {
  const agents = new Map<string, number[]>();
  for (const { run: r, day } of flaggedInWindow(runs, days)) {
    const perDay = agents.get(r.agentId) ?? days.map(() => 0);
    perDay[day]++;
    agents.set(r.agentId, perDay);
  }
  const byAgent = [...agents].map(([agentId, perDay]) => ({ agentId, perDay, total: perDay.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.agentId.localeCompare(b.agentId));
  return { byAgent };
}
