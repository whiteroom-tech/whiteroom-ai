// Pure helpers for Home (redesign screen 1a/1b): agent status and progress
// lines, plain-language activity rows, live-feed rows and today's window.
// No React, so the wording rules can be unit-tested directly.

import type { AgentState, TagTone } from '@whiteroom/ui';
import type { AgentHold, AgentInfo, AuditEntry, FleetHourlyDataPoint, FleetReport } from '@/lib/whiteroom/types';
import { deriveDisplayStatus } from '@/lib/fleet-helpers';
import { fmtTime, fmtWhen } from '@/lib/format';
import { classifyAction, eventModel, prettyToolName, shortArg } from '@/lib/activity';

// ── Agents ───────────────────────────────────────────────────────────────

const STATE_OF: Record<string, AgentState> = {
  working: 'working',
  resting: 'resting',
  idle: 'idle',
  handover_out: 'handover',
  stale: 'stale',
  disconnected: 'disconnected',
};

export function agentState(a: Pick<AgentInfo, 'status' | 'minutesRemaining' | 'hold'> & { stale?: boolean; disconnected?: boolean }): AgentState {
  if (a.hold) return a.hold.state;
  return STATE_OF[deriveDisplayStatus(a.status, a.stale, a.minutesRemaining, a.disconnected)] ?? 'idle';
}

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/** "Shift 8 · 62 tasks · 9.4 min worked"; "Rest after shift 5 · 31 tasks" while resting. */
export function progressLine(a: AgentInfo, state: AgentState = agentState(a)): string {
  const shift = a.watchNumber || 1;
  const tasks = a.tasksCompleted || 0;
  const taskWord = `${tasks} task${tasks === 1 ? '' : 's'}`;
  if (state === 'resting') return `Rest after shift ${shift} · ${taskWord}`;
  if (state === 'idle') return `Shift ${shift} · ${taskWord} · waiting for work`;
  if (state === 'paused' || state === 'stopped') return `Shift ${shift} · ${taskWord} · waiting to be resumed`;
  return `Shift ${shift} · ${taskWord} · ${oneDecimal(a.minutesWorked || 0)} min worked`;
}

// Needs-you items come first once P2 ships; until then working agents lead.
const RANK: Record<AgentState, number> = {
  paused: 0, stopped: 0, stale: 1, disconnected: 1,
  working: 2, handover: 2, pausing: 2, stopping: 2, resuming: 2,
  resting: 3, idle: 4,
};

export function sortAgents<T extends AgentInfo>(agents: T[]): T[] {
  return [...agents].sort((x, y) => RANK[agentState(x)] - RANK[agentState(y)] || x.agentId.localeCompare(y.agentId));
}

/** Counts for the strip's "1 resting · 1 idle" sub-caption, most important first. */
export function stateSummary(agents: AgentInfo[]): string {
  const order: [AgentState, string][] = [['stale', 'not reporting'], ['disconnected', 'disconnected'], ['handover', 'handing over'], ['resting', 'resting'], ['idle', 'idle']];
  const counts = new Map<AgentState, number>();
  agents.forEach((a) => { const s = agentState(a); counts.set(s, (counts.get(s) ?? 0) + 1); });
  return order.filter(([s]) => counts.get(s)).map(([s, word]) => `${counts.get(s)} ${word}`).join(' · ');
}

// ── Agent details between fan-outs ───────────────────────────────────────

const REPORT_BUCKETS = ['working', 'resting', 'idle', 'handover_out'] as const;

/** Every agent id in the report, with the status bucket it's in. */
export function reportStatuses(report: Pick<FleetReport, 'status'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of REPORT_BUCKETS) for (const id of report.status[s] ?? []) out.set(id, s);
  return out;
}

/**
 * The agents to show from the report plus the last fetched details. Every
 * agent in the report appears with the report's fresh status, even one that
 * joined since the last fetch (shown with what the report knows).
 */
export function overlayStatuses(report: Pick<FleetReport, 'status'>, cached: AgentInfo[]): AgentInfo[] {
  const byId = new Map(cached.map((d) => [d.agentId, d]));
  return [...reportStatuses(report)].map(([id, status]) => ({ ...(byId.get(id) ?? { agentId: id }), agentId: id, status }));
}

/**
 * Combine one fan-out's lookups (null where a lookup failed) with the last
 * good details. A failed agent keeps its previous detail under the report's
 * fresh status, or just the status if it has none yet. `complete` is false
 * when any lookup failed, so the caller retries sooner (afterFanOut) instead of
 * waiting out the throttle.
 */
export function mergeFanOut(
  statuses: Map<string, string>,
  results: (AgentInfo | null)[],
  previous: AgentInfo[],
): { details: AgentInfo[]; complete: boolean } {
  const prev = new Map(previous.map((d) => [d.agentId, d]));
  const ids = [...statuses.keys()];
  const details = ids.map((id, i) => {
    const got = results[i];
    if (got) return { ...got, agentId: id };
    return { ...(prev.get(id) ?? { agentId: id }), agentId: id, status: statuses.get(id) ?? 'idle' };
  });
  return { details, complete: results.every(Boolean) };
}

// Without agentDetails in the report, details come from one checkWatch per
// agent. Doing that every 10s tick is an N+1 storm, so a complete fan-out
// waits a minute; a partial one retries sooner, backing off so one agent whose
// lookup keeps failing can't bring the storm back.
export const FANOUT_INTERVAL_MS = 60_000;
const FANOUT_RETRY_MS = 10_000;

export interface FanOutClock {
  /** Earliest time the next fan-out may run. */
  nextAt: number;
  /** Partial fan-outs in a row since the last complete one. */
  failures: number;
}

export const FANOUT_START: FanOutClock = { nextAt: 0, failures: 0 };

/**
 * Whether this poll should fan out. A new agent (one the cached details don't
 * cover) is fetched at once, but only after a complete fan-out: if lookups
 * are already failing, it waits for the backoff like the rest.
 */
export function fanOutDue(clock: FanOutClock, now: number, unknownAgents: boolean): boolean {
  return now >= clock.nextAt || (unknownAgents && clock.failures === 0);
}

/** The clock after a fan-out: a minute when complete, else 10s, 20s, 40s, then a minute. */
export function afterFanOut(clock: FanOutClock, now: number, complete: boolean): FanOutClock {
  if (complete) return { nextAt: now + FANOUT_INTERVAL_MS, failures: 0 };
  const failures = clock.failures + 1;
  return { nextAt: now + Math.min(FANOUT_INTERVAL_MS, FANOUT_RETRY_MS * 2 ** (failures - 1)), failures };
}

/** Whether the report has agents the cached details don't cover yet. */
export function hasUnknownAgents(report: Pick<FleetReport, 'status'>, cached: AgentInfo[]): boolean {
  const known = new Set(cached.map((d) => d.agentId));
  return [...reportStatuses(report).keys()].some((id) => !known.has(id));
}

// ── Activity ─────────────────────────────────────────────────────────────

export interface ActivityRow {
  key: string;
  time: string;
  text: string;
  tag?: { label: string; tone: TagTone };
}

const TAGS: Record<string, { label: string; tone: TagTone }> = {
  handover_out: { label: 'Handover', tone: 'ho' },
  handover_in: { label: 'Handover', tone: 'ho' },
  handover: { label: 'Handover', tone: 'ho' },
  self_handover: { label: 'Handover', tone: 'ho' },
  agent_paused: { label: 'Paused', tone: 'warn' },
  governance_block: { label: 'Blocked', tone: 'muted' },
  governance_would_block: { label: 'Watch only', tone: 'muted' },
  unclean_stop: { label: 'Gap', tone: 'warn' },
  possible_gap: { label: 'Gap', tone: 'warn' },
};

/** Who an event is about. Handovers can carry only fromAgent / toAgent. */
export function eventAgent(e: AuditEntry): string {
  return String(e.agentId ?? e.fromAgent ?? e.toAgent ?? '').trim();
}

/** "2:15 pm" in the viewer's time zone, from an ISO string or epoch ms. */
export function clock(ts: unknown): string {
  return fmtTime(typeof ts === 'number' ? ts : String(ts ?? ''));
}

/** Epoch ms of an ISO string or epoch-ms timestamp; NaN when unreadable. */
function epochMs(ts: unknown): number {
  return typeof ts === 'number' ? ts : Date.parse(String(ts ?? ''));
}

/**
 * One fleet event in plain words. Agent ids stay exactly as stored (the
 * shared feed capitalises them; the redesign's copy rules don't).
 */
export function activityRow(e: AuditEntry, now: number = Date.now()): ActivityRow {
  const m = eventModel(e, now);
  // Fleet-level events (WhiteRoom itself) name no agent.
  const subject = m.type === 'governance_rule_changed' ? 'Controls:' : m.who === 'WhiteRoom' ? 'WhiteRoom' : eventAgent(e) || 'An agent';
  return { key: m.key, time: clock(e.timestamp), text: `${subject} ${m.said}`, tag: TAGS[m.type] };
}

/** Epoch ms of an event; 0 for an unreadable timestamp, so it sorts last instead of breaking the sort. */
function eventTime(e: AuditEntry): number {
  const t = epochMs(e.timestamp);
  return Number.isNaN(t) ? 0 : t;
}

/** The newest `n` events, newest first. An event from before today shows its date, not a time that reads as today's. */
export function latestActivity(entries: AuditEntry[], n = 4, now: number = Date.now()): ActivityRow[] {
  return [...entries]
    .sort((a, b) => eventTime(b) - eventTime(a))
    .slice(0, n)
    .map((e) => ({ ...activityRow(e, now), time: fmtWhen(eventTime(e) || '', now) }));
}

/** The last thing each agent did, for the Agents table's "Last event" column. */
export function lastEventByAgent(entries: AuditEntry[], now: number = Date.now()): Record<string, { time: string; text: string }> {
  const out: Record<string, { time: string; text: string; at: number }> = {};
  for (const e of entries) {
    const id = eventAgent(e);
    const at = epochMs(e.timestamp);
    if (!id || Number.isNaN(at) || (out[id] && out[id].at >= at)) continue;
    out[id] = { time: fmtWhen(at, now), text: eventModel(e).said, at };
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { time: v.time, text: v.text }]));
}

// ── Live feed ────────────────────────────────────────────────────────────

export type LiveKind = 'web' | 'tool' | 'file' | 'reply';
export type LiveFilter = 'all' | 'web' | 'tools' | 'replies';

/** One tool call, or one result handed back to the model, in an expanded row. */
export interface LiveStep {
  /** "Read", "Searched", ... for calls; "Returned" for results. */
  label: string;
  /** The tool, in words: "fetch page". Empty for results. */
  tool: string;
  /** The real argument or result text, untrimmed. */
  text: string;
  /** A result that came back as an error or a refusal (fetch error, robots.txt). */
  failed: boolean;
}

export interface LiveRow {
  key: string;
  time: string;
  agent: string;
  kind: LiveKind;
  /** One line; the full detail is in calls/results/reply. */
  summary: string;
  /** Tool calls the agent made in this step. */
  calls: LiveStep[];
  /** Results of its earlier calls that came in with this step: page text, errors. */
  results: LiveStep[];
  /** A reply's full text. */
  reply: string;
  tokens: number | null;
}

// Matched against whole words of the tool name (read_web_page → read, web,
// page), so save_lead or open_ticket aren't taken for files and
// pagerduty_alert isn't taken for the web.
const WEB_WORDS = new Set(['web', 'http', 'https', 'url', 'fetch', 'browse', 'browser', 'navigate', 'google', 'scrape', 'crawl', 'website', 'webpage']);
const FILE_WORDS = new Set(['file', 'files', 'fs', 'dir', 'directory', 'folder']);

function words(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function kindOf(toolName: string): LiveKind {
  const w = words(toolName);
  if (w.some((x) => WEB_WORDS.has(x))) return 'web';
  if (w.some((x) => FILE_WORDS.has(x))) return 'file';
  return 'tool';
}

/** The slice of rows on `page`, with the page clamped to what exists. */
export function pageWindow<T>(rows: T[], page: number, size: number): { page: number; rows: T[]; from: number; to: number } {
  const last = Math.max(0, Math.ceil(rows.length / size) - 1);
  const p = Math.min(Math.max(0, page), last);
  const slice = rows.slice(p * size, p * size + size);
  return { page: p, rows: slice, from: slice.length ? p * size + 1 : 0, to: p * size + slice.length };
}

const FAILED_RESULT = /\[(?:fetch error|blocked|error)\b|^(?:error|failed)\b/i;

/** JSON arguments as "url: https://… · depth: 2"; anything else as it came. */
export function readableArgs(args: unknown): string {
  const s = String(args ?? '').trim();
  if (!/^\{/.test(s)) return s;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const parts = Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return parts.length ? parts.join('  ·  ') : '';
  } catch {
    return s;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Page text arrives HTML-escaped ("&amp;"); show the characters. Rendered as text, never as HTML. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function step(d: { name?: unknown; args?: unknown }): LiveStep {
  const result = /^tool_result$/i.test(String(d.name ?? ''));
  // Only results (page text) arrive escaped; a call's args are shown as sent.
  const text = result ? decodeEntities(String(d.args ?? '').trim()) : readableArgs(d.args);
  return {
    label: !result && kindOf(String(d.name ?? '')) === 'web' ? 'Opened' : classifyAction(d.name).label,
    tool: result ? '' : prettyToolName(d.name),
    text,
    failed: result && FAILED_RESULT.test(text),
  };
}

/**
 * One live-feed entry as a row. The engine stores replies as a task named
 * "reply: <text>" and tool work as details [{ name, args }]; earlier results
 * come first, then this step's calls; the first call decides the row's kind.
 */
export function liveRow(e: AuditEntry): LiveRow {
  const name = String(e.taskName ?? '');
  const details = Array.isArray(e.details) ? e.details : [];
  // null and '' would read as 0 through Number(); treat them as unknown.
  const rawTokens: unknown = e.tokensUsed;
  const tokens = rawTokens == null || rawTokens === '' || !Number.isFinite(Number(rawTokens)) ? null : Number(rawTokens);
  const base = { key: String(e.id ?? `${e.timestamp}-${name}`), time: clock(e.timestamp), agent: eventAgent(e), tokens, reply: '' };
  if (/^reply:/i.test(name) && details.length === 0) {
    const reply = decodeEntities(name.replace(/^reply:\s*/i, ''));
    return { ...base, kind: 'reply', summary: `“${reply}”`, calls: [], results: [], reply };
  }
  // The engine lists the results of the agent's earlier calls before the
  // calls it made this step; the summary is about the calls.
  const calls = details.filter((d) => !/^tool_result$/i.test(String(d?.name ?? '')));
  const results = details.filter((d) => /^tool_result$/i.test(String(d?.name ?? ''))).map(step);
  const first = calls[0];
  if (!first) return { ...base, kind: 'tool', summary: name || 'Model call', calls: [], results };
  const kind = kindOf(first.name);
  const arg = shortArg(first.args);
  const more = calls.length > 1 ? ` · +${calls.length - 1} more` : '';
  // Say what happened without repeating the tool's name: "Opened <url>",
  // "Read <path>", or "<tool>: <argument>" when the name is the only clue.
  const summary =
    kind === 'web' && arg ? `Opened ${arg.replace(/^url:\s*/i, '')}`
    : kind === 'file' && arg ? `${classifyAction(first.name).label} ${arg}`
    : `${prettyToolName(first.name)}${arg ? `: ${arg}` : ''}`;
  return { ...base, kind, summary: `${summary}${more}`, calls: calls.map(step), results };
}

/** Whether a row has more to show than its one line. */
export function liveExpandable(r: LiveRow): boolean {
  return r.calls.length > 0 || r.results.length > 0 || r.reply.length > 120;
}

/**
 * The live feed reloads on the header's Refresh, but only while revealed.
 * Every signal is marked handled, even while hidden, so revealing after a
 * hidden Refresh loads once (from reveal) rather than twice.
 */
export function onRefreshSignal(open: boolean, signal: number, handled: number): { load: boolean; handled: number } {
  return { load: open && signal !== handled, handled: signal };
}

export function matchesFilter(row: LiveRow, f: LiveFilter): boolean {
  if (f === 'all') return true;
  if (f === 'web') return row.kind === 'web';
  if (f === 'replies') return row.kind === 'reply';
  return row.kind === 'tool' || row.kind === 'file';
}

// ── Today (UTC) ──────────────────────────────────────────────────────────

function utcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Hours to ask for so the window reaches back to 00:00 UTC today. */
export function hoursSinceUtcMidnight(now: number = Date.now()): number {
  return Math.max(1, Math.ceil((now - utcMidnight(now)) / 3_600_000));
}

/** Calls and spend since 00:00 UTC, from hourly points; `partial` when some calls have no price on file. */
export function todayTotals(hourly: FleetHourlyDataPoint[], now: number = Date.now()): { calls: number; costUsd: number; partial: boolean } {
  const midnight = utcMidnight(now);
  return hourly
    .filter((h) => Date.parse(h.hour) >= midnight)
    .reduce<{ calls: number; costUsd: number; partial: boolean }>((t, h) => ({ calls: t.calls + (h.calls || 0), costUsd: t.costUsd + (h.costMicros || 0) / 1e6, partial: t.partial || (h.unpricedAttempts ?? 0) > 0 }), { calls: 0, costUsd: 0, partial: false });
}

// ── Money ────────────────────────────────────────────────────────────────

/** "$2.37"; "<$0.01" for a real but tiny amount; "$0.00" for none. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The engine reports savings as a string like "$1.7805"; null when there are none. */
export function parseUsd(s: unknown): number | null {
  const n = parseFloat(String(s ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Holds whose agent is no longer registered (removed while held), oldest first. */
export function removedHeld(holds: Record<string, AgentHold> | undefined, agents: { agentId: string }[]): [string, AgentHold][] {
  if (!holds) return [];
  const present = new Set(agents.map((a) => a.agentId));
  return Object.entries(holds).filter(([id]) => !present.has(id)).sort((a, b) => a[1].at.localeCompare(b[1].at));
}
