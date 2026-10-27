// Pure helpers for Agent detail. No React, so the rules
// for what an operator may do, and what the page says, can be unit-tested.
//
// Actions: Pause holds the agent (Gov v1) or, on older fleets, pauses it
// for a short while; Resume releases either. Customer copy never says how
// WhiteRoom keeps an agent going, only what the operator can do.

import type { AgentInfo, AuditEntry, FleetDiagnosis, RunSummary } from '@/lib/whiteroom/types';
import type { AgentState } from '@whiteroom/ui';
import { tallyParts, type GovernanceTally } from '@/lib/governance';
import { TITLES, isDiagnosisDetector } from '@/lib/diagnosis/copy';
import { fmtTokens, plural, timeAgo } from '@/lib/format';
import { agentState, currentShift, taskWord } from '@/lib/home';

/** When the current break ends (epoch ms), or null when it can't be told. */
export function breakEndsAt(a: Pick<AgentInfo, 'alarmAt' | 'restStartedAt' | 'restMinutes'>): number | null {
  const alarm = Date.parse(String(a.alarmAt ?? ''));
  if (!Number.isNaN(alarm)) return alarm;
  // A manual break records its start but no alarm; the engine ends it after
  // restMinutes, so the end is computed the same way it checks it.
  const start = Date.parse(String(a.restStartedAt ?? ''));
  if (!Number.isNaN(start) && typeof a.restMinutes === 'number') return start + a.restMinutes * 60_000;
  return null;
}

export type ActionGate = { allowed: boolean; why?: string };

/**
 * Pause: on a Gov v1 fleet any agent that isn't held; on an older fleet only
 * one that is working right now.
 */
export function canPause(a: AgentInfo): ActionGate {
  if (a.hold) return { allowed: false, why: `It’s already ${a.hold.state}.` };
  if (a.govV1) return { allowed: true };
  const s = agentState(a);
  if (s === 'working') return { allowed: true };
  if (s === 'resting') return { allowed: false, why: 'It is already paused.' };
  return { allowed: false, why: 'Only a working agent can be paused.' };
}

/** Resume releases a hold, or ends a short pause once it can be ended. */
export function canResume(a: AgentInfo, now: number = Date.now()): ActionGate {
  if (a.hold) return { allowed: true };
  if (agentState(a) !== 'resting') return { allowed: false, why: 'It isn’t paused.' };
  const end = breakEndsAt(a);
  if (end !== null && now < end) {
    const min = Math.max(1, Math.ceil((end - now) / 60_000));
    return { allowed: false, why: `It can resume in ${min} min.` };
  }
  return { allowed: true };
}

/** The header's one action: Resume while held or paused, otherwise Pause. */
export function headerAction(a: AgentInfo): 'pause' | 'resume' {
  return a.hold || agentState(a) === 'resting' ? 'resume' : 'pause';
}

/** The header's status words, with no pill: "Waiting for work", "Working", "Paused"… */
export function statusWords(state: AgentState | 'removing'): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (state) {
    case 'working': case 'handover': return { text: 'Working', tone: 'ok' };
    case 'paused': return { text: 'Paused', tone: 'warn' };
    case 'resting': return { text: 'Paused for a moment', tone: 'warn' };
    case 'stopped': return { text: 'Stopped', tone: 'warn' };
    case 'stale': return { text: 'Not reporting', tone: 'warn' };
    case 'disconnected': return { text: 'Disconnected', tone: 'muted' };
    case 'pausing': return { text: 'Pausing…', tone: 'muted' };
    case 'stopping': return { text: 'Stopping…', tone: 'muted' };
    case 'resuming': return { text: 'Resuming…', tone: 'muted' };
    case 'removing': return { text: 'Removing…', tone: 'muted' };
    default: return { text: 'Waiting for work', tone: 'muted' };
  }
}

/** The Now card. */
export interface NowCard {
  /** Header right: "Running", "Not running", "Paused", "Stopped". */
  status: string;
  /** "Run #8 · 62 tasks · 9.4 min so far" or "Last run #4 · 6 tasks"; null with no run known. */
  run: { label: string; number: number; tail: string } | null;
  /** When the last run started, from Recent runs, when it's there. */
  runId: string | null;
  runDate: string | null;
  /** "All time: 60 tasks · 53.4K tokens"; null when the engine doesn't send lifetime totals. */
  allTime: string | null;
}

export function nowCard(a: AgentInfo, runs: RunSummary[] | null, fmtDate: (iso: string) => string): NowCard {
  const s = agentState(a);
  const shift = currentShift(a);
  const status = a.hold ? (a.hold.state === 'stopped' ? 'Stopped' : 'Paused') : s === 'resting' ? 'Paused' : shift ? 'Running' : 'Not running';
  let run: NowCard['run'] = null;
  if (shift) {
    run = { label: 'Run', number: shift.watchNumber || 1, tail: [taskWord(shift.tasksCompleted), `${Math.round(shift.minutesWorked * 10) / 10} min so far`].join(' · ') };
  } else if (a.lastShift) {
    run = { label: 'Last run', number: a.lastShift.watchNumber, tail: taskWord(a.lastShift.tasksCompleted) };
  }
  const match = run ? (runs ?? []).find((r) => r.shift === run.number) : undefined;
  const allTime = a.lifetime
    ? `All time: ${[taskWord(a.lifetime.tasksCompleted), a.lifetime.tokensUsed ? `${fmtTokens(a.lifetime.tokensUsed)} tokens` : ''].filter(Boolean).join(' · ')}`
    : null;
  return { status, run, runId: match?.runId ?? null, runDate: match ? fmtDate(match.startedAt) : null, allTime };
}

/** Rule activity on the Last 7 days card: Home's words ("2 blocked · 58 would have blocked"), or "0 caught". */
export function weekRuleWords(t: GovernanceTally): { count: number; word: string }[] {
  const out = tallyParts(t);
  return out.length ? out : [{ count: 0, word: 'caught' }];
}

/**
 * One line from the fleet health check for this agent, or null when the
 * check is off or hasn't looked at it: "1 problem: Repeating the same call ·
 * checked 2 hours ago", "4 checks passed · checked 1 day ago", or "Waiting for
 * more calls".
 */
export function agentHealthLine(d: FleetDiagnosis | null, agentId: string, now: number = Date.now()): { tone: 'warn' | 'ok' | 'muted'; text: string } | null {
  if (!d || !d.checkedAt) return null;
  const checked = `checked ${timeAgo(d.checkedAt, now)}`;
  const report = d.reports.find((r) => r.agentId === agentId);
  if (!report) {
    return d.waiting.some((w) => w.agentId === agentId) ? { tone: 'muted', text: 'Waiting for more calls before the first check' } : null;
  }
  const open = report.findings.filter((f) => f.status === 'open');
  if (open.length > 0) {
    const first = isDiagnosisDetector(open[0].detector) ? TITLES[open[0].detector] : 'A check found a problem';
    const more = open.length > 1 ? ` and ${open.length - 1} more` : '';
    return { tone: 'warn', text: `${open.length} ${plural(open.length, 'problem')}: ${first}${more} · ${checked}` };
  }
  const passed = report.clear.length;
  return { tone: 'ok', text: `${passed > 0 ? `${passed} ${plural(passed, 'check')} passed` : 'No problems found'} · ${checked}` };
}

/** The model the agent last called, from its newest audit entry that names one. */
export function lastModel(entries: AuditEntry[]): string | null {
  let best: { at: number; model: string } | null = null;
  for (const e of entries) {
    if (typeof e.model !== 'string' || !e.model) continue;
    const at = Date.parse(String(e.timestamp));
    if (!Number.isNaN(at) && (!best || at > best.at)) best = { at, model: e.model };
  }
  return best?.model ?? null;
}

/** check_watch answers an unknown agent with { error: "Agent '…' not found." }. */
export function isNotFound(res: unknown): boolean {
  const err = (res as { error?: unknown } | null)?.error;
  return typeof err === 'string' && /not found/i.test(err);
}

/** The agent id from a URL segment; a malformed escape stays raw instead of throwing. */
export function agentIdFromSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The agent page's Last 7 days token figures. Without WhiteRoom is an
 * estimate: what it used plus what smaller context saved it. Null when the
 * audit read failed, so the card shows "—", never 0.
 */
export function weekTokens(w: { used?: number; saved?: number } | undefined): { without: number; used: number; saved: number; pct: number } | null {
  if (w?.used === undefined) return null;
  const saved = w.saved ?? 0;
  const without = w.used + saved;
  return { without, used: w.used, saved, pct: without > 0 ? Math.round((saved / without) * 100) : 0 };
}
