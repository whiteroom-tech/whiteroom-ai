/**
 * Agent Diagnosis view logic (spec Rev 4.4 §6.2, §6.7), kept pure so every
 * state is testable without rendering.
 */
import type { DiagnosisDetectorId, FleetDiagnosis } from '@/lib/whiteroom/types';
import { notMeasuredText, titleLower, TITLES } from './copy';

/** Refetch on window focus at most this often (§6.7). */
export const FOCUS_REFETCH_MS = 5 * 60_000;

export function shouldRefetchOnFocus(lastFetchedAt: number | null, now: number, hidden: boolean): boolean {
  if (hidden) return false;
  return lastFetchedAt == null || now - lastFetchedAt >= FOCUS_REFETCH_MS;
}

export function relativeTime(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
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
    return { text: `Checking ${n} ${n === 1 ? 'agent' : 'agents'}…`, action: null, busy: true, error: false };
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
  const agents = `${d.readyAgents} ${d.readyAgents === 1 ? 'agent' : 'agents'}`;
  if (!d.checkedAt) {
    return { text: `First check runs within the hour · ${agents} ready`, action: { label: 'Check now' }, busy: false, error: false };
  }
  const open = openFindingCount(d);
  const found = justRan ? ` · ${open} ${open === 1 ? 'finding' : 'findings'}` : '';
  return { text: `Checked ${relativeTime(d.checkedAt, now)} · ${agents}${found}`, action: { label: 'Check now' }, busy: false, error: false };
}

export function openFindingCount(d: FleetDiagnosis): number {
  return d.reports.reduce((n, r) => n + r.findings.filter((f) => f.status === 'open').length, 0);
}

/** The attention strip (§6.2.1): null when nothing is open. */
export function attentionStrip(d: FleetDiagnosis | null): { lead: string; names: string } | null {
  if (!d) return null;
  const agents = d.reports.filter((r) => r.findings.some((f) => f.status === 'open')).map((r) => r.agentId);
  if (agents.length === 0) return null;
  if (agents.length === 1) return { lead: `${agents[0]} needs attention`, names: '' };
  const shown = agents.slice(0, 3).join(', ');
  const more = agents.length > 3 ? ` +${agents.length - 3} more` : '';
  return { lead: `${agents.length} agents need attention:`, names: `${shown}${more}` };
}

export interface CheckedSummary {
  agents: number;
  nothingFound: string[];
  perAgent: Array<{ agentId: string; looksFine: string[]; needsData: Array<{ title: string; text: string }> }>;
  waiting: Array<{ agentId: string; text: string }>;
}

/** What we checked (§6.2.4). */
export function checkedSummary(d: FleetDiagnosis): CheckedSummary {
  const perAgent: CheckedSummary['perAgent'] = [];
  const nothingFound: string[] = [];
  for (const r of d.reports) {
    if (!r.findings.some((f) => f.status === 'open')) nothingFound.push(r.agentId);
    const looksFine = r.clear.map((c) => titleLower(c.detector));
    const needsData = r.notMeasured.map((n) => ({ title: titleLower(n.detector as DiagnosisDetectorId), text: notMeasuredText(n.code, n.reason) }));
    if (looksFine.length || needsData.length) perAgent.push({ agentId: r.agentId, looksFine, needsData });
  }
  return {
    agents: d.reports.length,
    nothingFound,
    perAgent,
    waiting: d.waiting.map((w) => ({ agentId: w.agentId, text: `${w.calls7d} of ${d.minCalls} calls. Checked automatically once it gets there.` })),
  };
}

export { TITLES };

// -- §6.2.5 Evidence headers ------------------------------------------------

type EvidenceCall = Record<string, unknown>;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const when = (c: EvidenceCall) => (typeof c.requestEnd === 'string' ? c.requestEnd : String(c.requestStart ?? ''));

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
  const time = (c: EvidenceCall) => new Date(when(c)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const byTime = [...calls].sort((a, b) => when(b).localeCompare(when(a)));
  switch (detector) {
    case 'review_handover_churn': {
      const counts = new Map<number, number>();
      for (const c of calls) if (typeof c.watchNumber === 'number') counts.set(c.watchNumber, (counts.get(c.watchNumber) ?? 0) + 1);
      const watches = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([watch, n]) => ({ watch, calls: n }));
      return { kind: 'watches', caption: 'Calls in each watch before it handed over', watches };
    }
    case 'review_tool_loops': {
      const groups = new Map<string, { name: string; hash: string; watch: string; calls: number }>();
      for (const c of calls) {
        const hashes = Array.isArray(c.toolCallHashes) ? (c.toolCallHashes as Array<{ n: string; h: string }>) : [];
        for (const t of hashes) {
          const key = `${c.watchNumber}|${t.h}`;
          const g = groups.get(key) ?? { name: t.n, hash: t.h, watch: String(c.watchNumber ?? '—'), calls: 0 };
          g.calls++;
          groups.set(key, g);
        }
      }
      const rows = [...groups.values()].sort((a, b) => b.calls - a.calls).slice(0, 5).map((g) => [g.name, `same · ${g.hash}`, String(g.calls), g.watch]);
      return { kind: 'table', caption: 'Calls grouped by repeated call', columns: ['Tool', 'Arguments', 'Calls', 'Watch'], rows,
        note: '"Same" means identical arguments. WhiteRoom stores a fingerprint, never the arguments themselves.' };
    }
    case 'review_tool_silence':
      return {
        kind: 'table', caption: `Offered ${tool} vs called, most recent calls`, columns: ['Time', 'Watch', `Offered ${tool}`, 'Called'],
        rows: byTime.map((c) => [time(c), String(c.watchNumber ?? '—'), list(c.toolNames).includes(tool) ? 'yes' : 'no', list(c.requestedToolNames).join(', ') || '(none)']),
      };
    case 'review_tool_errors':
      return {
        kind: 'table', caption: 'Tool results and errors, newest first', columns: ['Time', 'Watch', 'Tool results', 'Reported errors'],
        rows: byTime.map((c) => [time(c), String(c.watchNumber ?? '—'), String(c.toolResults ?? '—'), list(c.toolErrorNames).join(', ') || '—']),
        note: 'WhiteRoom records which tool reported an error, not the error text. The cause is in your agent’s logs.',
      };
    default:
      return null;
  }
}
