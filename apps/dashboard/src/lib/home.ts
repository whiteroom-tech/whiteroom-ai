// Pure helpers for Home (redesign screen 1a/1b): agent status and progress
// lines, plain-language activity rows, live-feed rows and today's window.
// No React, so the wording rules can be unit-tested directly.

import type { AgentState, TagTone } from '@whiteroom/ui';
import type { AgentInfo, AuditEntry, FleetHourlyDataPoint } from '@/lib/whiteroom/types';
import { deriveDisplayStatus } from '@/lib/fleet-helpers';
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

export function agentState(a: Pick<AgentInfo, 'status' | 'minutesRemaining'> & { stale?: boolean; disconnected?: boolean }): AgentState {
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
};

/** "2:15 pm" in the viewer's time zone, from an ISO string or epoch ms. */
export function clock(ts: unknown): string {
  const d = new Date(typeof ts === 'number' ? ts : String(ts ?? ''));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

/**
 * One fleet event in plain words. Agent ids stay exactly as stored (the
 * shared feed capitalises them; the redesign's copy rules don't).
 */
export function activityRow(e: AuditEntry, now: number = Date.now()): ActivityRow {
  const m = eventModel(e, now);
  const subject = m.type === 'governance_rule_changed' ? 'Controls:' : String(e.agentId ?? '').trim() || 'An agent';
  return { key: m.key, time: clock(e.timestamp), text: `${subject} ${m.said}`, tag: TAGS[m.type] };
}

/** The newest `n` events, newest first. */
export function latestActivity(entries: AuditEntry[], n = 4, now: number = Date.now()): ActivityRow[] {
  return [...entries]
    .sort((a, b) => Date.parse(String(b.timestamp)) - Date.parse(String(a.timestamp)))
    .slice(0, n)
    .map((e) => activityRow(e, now));
}

/** The last thing each agent did, for the Agents table's "Last event" column. */
export function lastEventByAgent(entries: AuditEntry[]): Record<string, { time: string; text: string }> {
  const out: Record<string, { time: string; text: string; at: number }> = {};
  for (const e of entries) {
    const id = String(e.agentId ?? '');
    const at = Date.parse(String(e.timestamp));
    if (!id || Number.isNaN(at) || (out[id] && out[id].at >= at)) continue;
    out[id] = { time: clock(e.timestamp), text: eventModel(e).said, at };
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { time: v.time, text: v.text }]));
}

// ── Live feed ────────────────────────────────────────────────────────────

export type LiveKind = 'web' | 'tool' | 'file' | 'reply';
export type LiveFilter = 'all' | 'web' | 'tools' | 'replies';

export interface LiveRow {
  key: string;
  time: string;
  agent: string;
  kind: LiveKind;
  summary: string;
  /** Raw detail in mono: the call with its real arguments. */
  detail: string;
}

const WEB = /web|http|url|fetch|browse|navigate|search_web|google|scrape|page/i;
const FILE = /file|read|write|save|open|path|dir|fs_/i;

function kindOf(toolName: string): LiveKind {
  if (WEB.test(toolName)) return 'web';
  if (FILE.test(toolName)) return 'file';
  return 'tool';
}

/**
 * One live-feed entry as a row. The engine stores replies as a task named
 * "reply: <text>" and tool work as details [{ name, args }]; the first call
 * decides the row's kind.
 */
export function liveRow(e: AuditEntry): LiveRow {
  const name = String(e.taskName ?? '');
  const details = Array.isArray(e.details) ? e.details : [];
  const base = { key: String(e.id ?? `${e.timestamp}-${name}`), time: clock(e.timestamp), agent: String(e.agentId ?? '') };
  if (/^reply:/i.test(name) && details.length === 0) {
    return { ...base, kind: 'reply', summary: `“${name.replace(/^reply:\s*/i, '')}”`, detail: '' };
  }
  const first = details[0];
  if (!first) return { ...base, kind: 'tool', summary: name || 'Model call', detail: '' };
  const kind = kindOf(first.name);
  const arg = shortArg(first.args);
  const more = details.length > 1 ? ` · +${details.length - 1} more` : '';
  const raw = String(first.args ?? '').replace(/\s+/g, ' ').trim();
  // Say what happened without repeating the tool's name: "Opened <url>",
  // "Read <path>", or "<tool>: <argument>" when the name is the only clue.
  const summary =
    kind === 'web' && arg ? `Opened ${arg}`
    : kind === 'file' && arg ? `${classifyAction(first.name).label} ${arg}`
    : `${prettyToolName(first.name)}${arg ? `: ${arg}` : ''}`;
  return {
    ...base,
    kind,
    summary: `${summary}${more}`,
    detail: `${first.name}(${raw.length > 300 ? `${raw.slice(0, 300)}…` : raw})`,
  };
}

export function matchesFilter(row: LiveRow, f: LiveFilter): boolean {
  if (f === 'all') return true;
  if (f === 'web') return row.kind === 'web';
  if (f === 'replies') return row.kind === 'reply';
  return row.kind === 'tool' || row.kind === 'file';
}

// ── Today (UTC) ──────────────────────────────────────────────────────────

/** Hours to ask for so the window reaches back to 00:00 UTC today. */
export function hoursSinceUtcMidnight(now: number = Date.now()): number {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.max(1, Math.ceil((now - midnight) / 3_600_000));
}

/** Calls and spend since 00:00 UTC, from hourly points. */
export function todayTotals(hourly: FleetHourlyDataPoint[], now: number = Date.now()): { calls: number; costUsd: number } {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return hourly
    .filter((h) => Date.parse(h.hour) >= midnight)
    .reduce((t, h) => ({ calls: t.calls + (h.calls || 0), costUsd: t.costUsd + (h.costMicros || 0) / 1e6 }), { calls: 0, costUsd: 0 });
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
