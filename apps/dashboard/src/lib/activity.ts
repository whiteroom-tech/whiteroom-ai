// Plain-English vocabulary, tool-call classification and paging for the fleet
// activity feed. Pure functions only — no React, no DOM — so the rendering
// rules can be unit-tested directly.
//
// Everything here is defensive about its input: audit entries come off the wire
// and a single malformed one must degrade to a readable row, never throw and
// blank the whole feed.
//
// Ported from whiteroom-ai-whiteroom's apps/dashboard/lib/activity.ts. That
// version keys colors off @whiteroom/ui's CSS-variable design tokens
// (--success, --border, etc.), which this app doesn't define — TONE_VAR/
// TONE_BG below use this app's existing navy/hex palette (see feedAccent()'s
// old color choices in fleet/page.tsx) instead.

import type { AuditEntry, ToolDetail } from '@/lib/whiteroom/types';

export type { AuditEntry, ToolDetail };

export type Tone = 'task' | 'handover' | 'start' | 'rest' | 'idle';

/** Accent per tone, matching this dashboard's existing hex palette. */
export const TONE_VAR: Record<Tone, string> = {
  task: '#22c55e',
  handover: '#a855f7',
  start: '#38bdf8',
  rest: '#0ea5e9',
  idle: '#475569',
};

export const TONE_BG: Record<Tone, string> = {
  task: '#052e16',
  handover: '#2e1065',
  start: '#0c4a6e',
  rest: '#0c4a6e',
  idle: '#1e293b',
};

interface EventCopy {
  icon: string;
  tone: Tone;
  /** Three-letter manifest code. */
  code: string;
  say: (e: AuditEntry) => string;
}

/** Capitalised agent name. Agents are identified by id in this app. */
export function agentName(id: unknown): string {
  const s = String(id ?? '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'An agent';
}

export const EVENT_COPY: Record<string, EventCopy> = {
  task_complete: { icon: '✅', tone: 'task', code: 'TSK', say: (e) => `finished "${e.taskName || 'a task'}"` },
  watch_start: { icon: '▶', tone: 'start', code: 'ON', say: () => 'started a shift' },
  watch_end: { icon: '⏹', tone: 'start', code: 'OFF', say: () => 'ended the shift' },
  handover_out: { icon: '🔄', tone: 'handover', code: 'H/O', say: (e) => `handed work over${e.toAgent ? ` to ${agentName(e.toAgent)}` : ''}` },
  handover_in: { icon: '🔄', tone: 'handover', code: 'H/I', say: (e) => `took over${e.fromAgent ? ` from ${agentName(e.fromAgent)}` : ''}` },
  handover: { icon: '🔄', tone: 'handover', code: 'H/O', say: (e) => `handed work over${e.toAgent ? ` to ${agentName(e.toAgent)}` : ''}` },
  self_handover: { icon: '🔄', tone: 'handover', code: 'H/O', say: () => 'handed context to itself (compressed)' },
  rest_start: { icon: '💤', tone: 'rest', code: 'RST', say: () => 'went on break' },
  rest_end: { icon: '☀', tone: 'rest', code: 'UP', say: () => 'came back from break' },
  alarm: { icon: '⏰', tone: 'rest', code: 'BEL', say: () => 'finished its break' },
  register: { icon: '➕', tone: 'idle', code: 'REG', say: () => 'joined the fleet' },
};

/** Unknown or absent types degrade to readable prose rather than throwing. */
export function humanizeType(type: unknown): string {
  const s = String(type ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.toLowerCase() : 'recorded an event';
}

export function relTime(timestamp: unknown, now: number = Date.now()): string {
  const ms = new Date(String(timestamp ?? '')).getTime();
  if (!Number.isFinite(ms)) return '';
  const diff = now - ms;
  if (diff < 45_000) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(diff / 3_600_000);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'} ago`;
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function clockTime(timestamp: unknown): string {
  const d = new Date(String(timestamp ?? ''));
  if (!Number.isFinite(d.getTime())) return '--:--';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function feedDayLabel(timestamp: unknown, now: number = Date.now()): string {
  const d = new Date(String(timestamp ?? ''));
  if (!Number.isFinite(d.getTime())) return '';
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'TODAY';
  if (d.toDateString() === yesterday.toDateString()) return 'YESTERDAY';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
}

// ── Tool calls → plain English ───────────────────────────
export interface ActionKind {
  icon: string;
  label: string;
  /** Present participle, for "Alpha is <ing> …" captions. */
  ing: string;
}

interface ActionRule extends ActionKind {
  test: RegExp;
}

// Order matters — first match wins, so the specific patterns run before the
// broad ones. `query_database` must read as "Looked up", not "Searched".
const ACTION_RULES: ActionRule[] = [
  { test: /voice|speak|tts|audio|transcri|dial|phone/i, icon: '🎙️', label: 'Spoke', ing: 'Speaking' },
  { test: /send|email|mail|message|slack|notify|post/i, icon: '📤', label: 'Sent', ing: 'Sending' },
  { test: /write|create|edit|update|save|draft|append/i, icon: '✏️', label: 'Wrote', ing: 'Writing' },
  { test: /sql|db|database|firestore|table|record|sheet/i, icon: '🗄️', label: 'Looked up', ing: 'Looking up' },
  { test: /search|google|web|browse|query|lookup|find/i, icon: '🔍', label: 'Searched', ing: 'Searching' },
  { test: /run|exec|bash|shell|script|code|compile|test/i, icon: '⚙️', label: 'Ran', ing: 'Running' },
  { test: /plan|think|reason|decide|analy|review/i, icon: '💭', label: 'Thought about', ing: 'Thinking about' },
  { test: /read|open|get|fetch|load|file|doc|view/i, icon: '📄', label: 'Read', ing: 'Reading' },
];

export const ACTION_FALLBACK: ActionKind = { icon: '🔧', label: 'Used', ing: 'Using' };

export function classifyAction(name: unknown): ActionKind {
  const n = String(name ?? '');
  for (const rule of ACTION_RULES) {
    if (rule.test.test(n)) return { icon: rule.icon, label: rule.label, ing: rule.ing };
  }
  return ACTION_FALLBACK;
}

export function prettyToolName(name: unknown): string {
  const s = String(name ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return s || 'a tool';
}

/** Pull something human out of a tool-argument blob, which is often JSON. */
export function shortArg(args: unknown): string {
  let s = String(args ?? '').trim();
  if (!s) return '';
  if (/^[[{]/.test(s)) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (parsed && typeof parsed === 'object') {
        const first = Object.values(parsed as Record<string, unknown>).find(
          (v): v is string => typeof v === 'string' && v.trim() !== '',
        );
        if (first) s = first;
      }
    } catch {
      // not JSON — fall through and use the raw string
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

// ── Row model ────────────────────────────────────────────
export interface EventModel {
  entry: AuditEntry;
  type: string;
  key: string;
  details: ToolDetail[];
  canExpand: boolean;
  who: string;
  said: string;
  icon: string;
  code: string;
  tone: Tone;
  accent: string;
  accentBg: string;
  rel: string;
  clock: string;
  watch: string;
}

/** Stable per-entry key. Falls back when taskId is absent (most non-task events). */
export function eventKey(e: AuditEntry): string {
  return String(e.taskId || e.id || `${String(e.type ?? 'e')}_${String(e.timestamp ?? '')}`);
}

export function eventModel(e: AuditEntry, now: number = Date.now()): EventModel {
  const type = String(e.type ?? '');
  const copy = EVENT_COPY[type];
  const tone: Tone = copy ? copy.tone : 'idle';
  const details = Array.isArray(e.details) ? e.details : [];
  return {
    entry: e,
    type,
    key: eventKey(e),
    details,
    canExpand: details.length > 0,
    who: agentName(e.agentId),
    said: copy ? copy.say(e) : humanizeType(type),
    icon: copy ? copy.icon : '•',
    code: copy ? copy.code : 'LOG',
    tone,
    accent: TONE_VAR[tone],
    accentBg: TONE_BG[tone],
    rel: relTime(e.timestamp, now),
    clock: clockTime(e.timestamp),
    watch: e.watchNumber != null ? `W${e.watchNumber}` : '',
  };
}

/** Sub-line beneath the headline: when it happened and how much it did. */
export function eventSubtitle(m: EventModel): string {
  const bits: string[] = [];
  if (m.rel) bits.push(m.rel);
  if (m.canExpand) bits.push(`${m.details.length} ${m.details.length === 1 ? 'action' : 'actions'}`);
  return bits.join(' · ');
}

/** The raw line shown only when the technical toggle is on. */
export function technicalLine(m: EventModel): string {
  const e = m.entry;
  const bits: string[] = [];
  if (m.type) bits.push(m.type);
  if (e.agentId) bits.push(String(e.agentId));
  if (e.watchNumber != null) bits.push(`watch #${e.watchNumber}`);
  if (Number.isFinite(Number(e.tokensUsed))) bits.push(`${Number(e.tokensUsed).toLocaleString()} tokens`);
  if (Number.isFinite(Number(e.minutesSpent))) bits.push(`${Number(e.minutesSpent)} min spent`);
  if (Number.isFinite(Number(e.remaining))) bits.push(`${Number(e.remaining)} min remaining`);
  if (e.taskId) bits.push(`id ${e.taskId}`);
  return bits.join(' · ');
}

// ── Paging ───────────────────────────────────────────────
export const PAGE_SIZE = 20;

export function pageCount(total: number, size: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

export function clampPage(page: number, total: number, size: number = PAGE_SIZE): number {
  return Math.min(Math.max(0, Math.floor(page) || 0), pageCount(total, size) - 1);
}

/** Newest first. Entries arriving out of order must not scramble the feed. */
export function sortNewestFirst(entries: AuditEntry[]): AuditEntry[] {
  return [...entries].sort((a, b) => {
    const ta = new Date(String(a?.timestamp ?? '')).getTime() || 0;
    const tb = new Date(String(b?.timestamp ?? '')).getTime() || 0;
    return tb - ta;
  });
}

export function pageSlice<T>(items: T[], page: number, size: number = PAGE_SIZE): T[] {
  const start = clampPage(page, items.length, size) * size;
  return items.slice(start, start + size);
}

export const FEED_VARIANTS = ['log', 'tape', 'manifest'] as const;
export type FeedVariant = (typeof FEED_VARIANTS)[number];

export function isFeedVariant(v: unknown): v is FeedVariant {
  return typeof v === 'string' && (FEED_VARIANTS as readonly string[]).includes(v);
}
