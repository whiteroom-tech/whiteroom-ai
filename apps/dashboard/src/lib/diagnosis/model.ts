/**
 * Agent Diagnosis view logic (spec Rev 4.4 §6.2, §6.7), kept pure so every
 * state is testable without rendering.
 */
import type { FleetDiagnosis } from '@/lib/whiteroom/types';
import { isDiagnosisDetector, notMeasuredShort, STATUS_LABEL, TITLES } from './copy';
import { fmtCount, plural, timeAgo } from '@/lib/format';

/** Refetch on window focus at most this often (§6.7). */
export const FOCUS_REFETCH_MS = 5 * 60_000;

export function shouldRefetchOnFocus(lastFetchedAt: number | null, now: number, hidden: boolean): boolean {
  if (hidden) return false;
  return lastFetchedAt == null || now - lastFetchedAt >= FOCUS_REFETCH_MS;
}

/**
 * Which Diagnosis response may land. Only the newest request's response
 * applies; a read never starts while a check is running (the check's result is
 * newer), but one asked for meanwhile runs when the check finishes, since the
 * check began before whatever prompted it; and a fleet change drops
 * everything in flight.
 */
export function createRequestGate() {
  let latest = 0;
  let checking = 0;
  let readWaiting = false;
  return {
    /** A read's id, or null while a check is running. */
    startRead(): number | null {
      if (checking) {
        readWaiting = true;
        return null;
      }
      return ++latest;
    },
    startCheck(): number {
      checking = ++latest;
      readWaiting = false;
      return checking;
    },
    isCurrent: (req: number) => req === latest,
    /**
     * Ends a check; true when a read should run now: one was asked for during
     * the check, or the check failed (a read in flight when it started was
     * dropped, so what's shown may be stale).
     */
    finish(req: number, succeeded: boolean): boolean {
      if (checking !== req) return false;
      checking = 0;
      const replay = readWaiting || !succeeded;
      readWaiting = false;
      return replay;
    },
    /** The fleet changed: nothing in flight may land. */
    reset() {
      latest++;
      checking = 0;
      readWaiting = false;
    },
  };
}

export type RunState = 'idle' | 'checking' | 'error';

export interface StatusLine {
  text: string;
  action: { label: string } | null;
  busy: boolean;
  error: boolean;
}

/** The Recommendations card header line (§6.2.2). null while the first read is loading. */
export function statusLine(d: FleetDiagnosis | null, run: RunState, now: number, justRan: boolean): StatusLine | null {
  if (run === 'checking') {
    const n = d?.readyAgents ?? 0;
    return { text: `Checking ${n} ${plural(n, 'agent')}…`, action: null, busy: true, error: false };
  }
  if (run === 'error') {
    return { text: 'Couldn’t finish the check. Your agents aren’t affected.', action: { label: 'Try again' }, busy: false, error: true };
  }
  if (!d) return null;
  if (d.readyAgents === 0) {
    const b = d.busiest;
    return {
      text: b
        ? `WhiteRoom starts checking an agent once it makes ${d.minCalls} calls in a week. ${b.agentId} is at ${b.calls7d} of ${d.minCalls}.`
        : `WhiteRoom starts checking an agent once it makes ${d.minCalls} calls in a week.`,
      action: null, busy: false, error: false,
    };
  }
  if (d.truncated) {
    const checked = d.reports.length;
    return { text: `Checked ${checked} of ${checked + d.skipped.length} agents.`, action: { label: 'Check the rest' }, busy: false, error: false };
  }
  const agents = `${d.readyAgents} ${plural(d.readyAgents, 'agent')}`;
  if (!d.checkedAt) {
    return { text: `First check runs within the hour · ${agents} ready`, action: { label: 'Check now' }, busy: false, error: false };
  }
  const open = openFindingCount(d);
  const found = justRan ? ` · ${open} ${plural(open, 'finding')}` : '';
  return { text: `Checked ${timeAgo(d.checkedAt, now)} · ${agents}${found}`, action: { label: 'Check now' }, busy: false, error: false };
}

export function openFindingCount(d: FleetDiagnosis): number {
  return d.reports.reduce((n, r) => n + r.findings.filter((f) => f.status === 'open').length, 0);
}

/** Agents with an open finding, in report order. */
export function agentsWithOpenFindings(d: FleetDiagnosis | null): string[] {
  return d ? d.reports.filter((r) => r.findings.some((f) => f.status === 'open')).map((r) => r.agentId) : [];
}

/** Agent health › Health check starts open only with an open finding and a short list (three agents or fewer). */
export function checksOpenByDefault(d: FleetDiagnosis | null): boolean {
  return !!d && openFindingCount(d) > 0 && d.reports.length <= 3;
}

/**
 * Agent health › Health check's one line: counts only, so a problem is named
 * once, in the list beside its fix ("1 problem · 2 passed · 3 waiting for more
 * data", or "3 checks passed · 3 waiting for more data"). Null until there's
 * a stored check to summarise.
 */
export interface DiagnosisSummary {
  tone: 'warn' | 'ok';
  text: string;
  /** Checks with a clear result, and ones still waiting for data, across agents. */
  fine: number;
  needsData: number;
  openFindings: number;
}

export function diagnosisSummary(d: FleetDiagnosis | null): DiagnosisSummary | null {
  if (!d || !d.checkedAt || d.reports.length === 0) return null;
  const fine = d.reports.reduce((n, r) => n + r.clear.length, 0);
  const needsData = d.reports.reduce((n, r) => n + r.notMeasured.length, 0);
  const openFindings = openFindingCount(d);
  const checks = (n: number) => `${n} ${plural(n, 'check')}`;
  if (openFindings > 0) {
    const parts = [
      `${openFindings} ${plural(openFindings, 'problem')}`,
      fine > 0 ? `${fine} passed` : '',
      needsData > 0 ? `${needsData} waiting for more data` : '',
    ].filter(Boolean);
    return { tone: 'warn', text: parts.join(' · '), fine, needsData, openFindings };
  }
  // Quiet: what passed, then what's still waiting for data.
  const counts = [
    fine > 0 ? `${checks(fine)} passed` : 'No problems found',
    needsData > 0 ? `${fine > 0 ? needsData : checks(needsData)} waiting for more data` : '',
  ].filter(Boolean).join(' · ');
  return { tone: 'ok', text: counts, fine, needsData, openFindings };
}

export interface CheckRow {
  /** `set-aside`: a finding that isn't open (snoozed, dismissed, marked fixed…), so the check is still accounted for. */
  tone: 'problem' | 'fine' | 'waiting' | 'set-aside';
  title: string;
  /** Waiting checks: what they still need ("starts in about 7 days"); set-aside ones: their status (setAsideLabel). */
  note?: string;
}

/** A check's title; a detector this dashboard doesn't know yet gets a readable one from its id ("review_new_thing" → "New thing"). */
export function checkTitle(detector: string): string {
  if (isDiagnosisDetector(detector)) return TITLES[detector];
  return humanizeDetector(detector) || 'A check';
}

/** A detector id as words: "review_cache_behavior" → "Cache behavior"; "" for an empty id. */
export function humanizeDetector(detector: string): string {
  const t = detector.replace(/^review_/, '').replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/** A non-open finding's status in the Health check list: "snoozed", "dismissed", "marked fixed", "stopped happening", or the engine's own word. */
export function setAsideLabel(status: string): string {
  if (status === 'snoozed') return 'snoozed';
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}

/**
 * Agent health › Health check, unfolded: one row per check per agent,
 * problems first, then passed, then waiting for data, then snoozed or dismissed.
 * Every check is listed, even from a detector this dashboard doesn't know yet
 * (by checkTitle), so the row's counts always match the list.
 */
export function checkRows(d: FleetDiagnosis): Array<{ agentId: string; rows: CheckRow[] }> {
  return d.reports.map((r) => ({
    agentId: r.agentId,
    rows: [
      ...r.findings.filter((f) => f.status === 'open').map((f): CheckRow => ({ tone: 'problem', title: checkTitle(f.detector) })),
      ...r.clear.map((c): CheckRow => ({ tone: 'fine', title: checkTitle(c.detector) })),
      ...r.notMeasured.map((n): CheckRow => ({ tone: 'waiting', title: checkTitle(n.detector), note: notMeasuredShort(n.code, n.reason) })),
      ...r.findings.filter((f) => f.status !== 'open').map((f): CheckRow => ({ tone: 'set-aside', title: checkTitle(f.detector), note: setAsideLabel(f.status) })),
    ],
  })).filter((a) => a.rows.length > 0);
}

// -- §6.2.5 Evidence headers ------------------------------------------------

type EvidenceCall = Record<string, unknown>;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
// The call's start, as in the calls table below the header.
const when = (c: EvidenceCall) => (typeof c.requestStart === 'string' ? c.requestStart : String(c.requestEnd ?? ''));

export type EvidenceHeader =
  | { kind: 'watches'; caption: string; watches: Array<{ watch: number; calls: number }> }
  | { kind: 'table'; caption: string; columns: string[]; rows: string[][]; note?: string }
  | null;

/**
 * A header above the evidence calls, from call metadata only (watch number,
 * called tools, short hashes, result counts, errored tool names).
 */
export function evidenceHeader(detector: string, calls: EvidenceCall[], measures: Record<string, unknown>): EvidenceHeader {
  const tool = String(measures.toolName ?? '');
  const time = (c: EvidenceCall) => {
    const d = new Date(when(c));
    return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  };
  const byTime = [...calls].sort((a, b) => when(b).localeCompare(when(a)));
  switch (detector) {
    case 'review_handover_churn': {
      const counts = new Map<number, number>();
      for (const c of calls) if (typeof c.watchNumber === 'number') counts.set(c.watchNumber, (counts.get(c.watchNumber) ?? 0) + 1);
      const watches = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([watch, n]) => ({ watch, calls: n }));
      return { kind: 'watches', caption: 'Calls in each run', watches };
    }
    case 'review_tool_loops': {
      const groups = new Map<string, { name: string; hash: string; watch: string; calls: number }>();
      for (const c of calls) {
        const hashes = Array.isArray(c.toolCallHashes) ? (c.toolCallHashes as Array<{ n: string; h: string }>) : [];
        // The looping tool only: other tools' calls in the same request would
        // crowd it out of the top five.
        for (const t of hashes.filter((x) => !tool || x.n === tool)) {
          const key = `${c.watchNumber}|${t.h}`;
          const g = groups.get(key) ?? { name: t.n, hash: t.h, watch: String(c.watchNumber ?? '—'), calls: 0 };
          g.calls++;
          groups.set(key, g);
        }
      }
      const rows = [...groups.values()].sort((a, b) => b.calls - a.calls).slice(0, 5).map((g) => [g.name, `same · ${g.hash}`, String(g.calls), g.watch]);
      return { kind: 'table', caption: 'Calls grouped by repeated call', columns: ['Tool', 'Arguments', 'Calls', 'Run'], rows,
        note: '"Same" means identical arguments. WhiteRoom stores a fingerprint, never the arguments themselves.' };
    }
    case 'review_tool_silence':
      return {
        kind: 'table', caption: `Offered ${tool} vs called, most recent calls`, columns: ['Time', 'Run', `Offered ${tool}`, 'Called'],
        rows: byTime.map((c) => [time(c), String(c.watchNumber ?? '—'), list(c.toolNames).includes(tool) ? 'yes' : 'no', list(c.requestedToolNames).join(', ') || '(none)']),
      };
    case 'review_tool_errors':
      return {
        kind: 'table', caption: 'Tool results and errors, newest first', columns: ['Time', 'Run', 'Tool results', 'Reported errors'],
        rows: byTime.map((c) => [time(c), String(c.watchNumber ?? '—'), String(c.toolResults ?? '—'), list(c.toolErrorNames).join(', ') || '—']),
        note: 'WhiteRoom records which tool reported an error, not the error text. The cause is in your agent’s logs.',
      };
    case 'review_spend_outliers': {
      const tokens = (c: EvidenceCall) => {
        const a = Array.isArray(c.attempts) ? (c.attempts[0] as Record<string, unknown> | undefined) : undefined;
        return Number(a?.inputTokens ?? 0) + Number(a?.outputTokens ?? 0);
      };
      return {
        kind: 'table', caption: 'Highest-token calls on the flagged days', columns: ['Time', 'Model', 'Tokens'],
        rows: [...calls].sort((a, b) => tokens(b) - tokens(a)).map((c) => [time(c), String(c.reportedModel ?? c.requestedModel ?? '—'), fmtCount(tokens(c))]),
      };
    }
    case 'review_provider_failures':
      return {
        kind: 'table', caption: 'Failed calls, newest first', columns: ['Time', 'Model', 'Result'],
        rows: byTime.map((c) => [time(c), String(c.reportedModel ?? c.requestedModel ?? '—'), String(c.terminal ?? '—').replace(/_/g, ' ')]),
      };
    default:
      return null;
  }
}
