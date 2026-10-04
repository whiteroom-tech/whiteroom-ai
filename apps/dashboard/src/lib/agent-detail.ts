// Pure helpers for Agent detail (redesign screen 3). No React, so the rules
// for what an operator may do, and what the page says, can be unit-tested.
//
// What today's engine supports: pause_agent sends a working agent on its
// scheduled break early (status "resting"); it starts again on its own when
// the break ends. resume_agent ends a break, but the engine refuses while the
// mandatory break is still running. The redesign's Pause / Stop (calls refused
// until someone resumes) arrive with the governance engine (P2), so the page
// names these actions for what they do: "Start a break" and "Resume".

import type { AgentInfo, AuditEntry, HandoverDoc } from '@/lib/whiteroom/types';
import { agentState, currentShift } from '@/lib/home';

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

/** "Start a break" is for an agent that is working right now. */
export function canStartBreak(a: AgentInfo): ActionGate {
  const s = agentState(a);
  if (s === 'working') return { allowed: true };
  if (s === 'resting') return { allowed: false, why: 'It is already on a break.' };
  return { allowed: false, why: 'Only a working agent can be sent on a break.' };
}

/** Resume ends a break, once the mandatory part is over. */
export function canResume(a: AgentInfo, now: number = Date.now()): ActionGate {
  if (a.hold) return { allowed: true };
  if (agentState(a) !== 'resting') return { allowed: false, why: 'It isn’t on a break.' };
  const end = breakEndsAt(a);
  if (end !== null && now < end) {
    const min = Math.max(1, Math.ceil((end - now) / 60_000));
    return { allowed: false, why: `The break is mandatory; it can resume in ${min} min.` };
  }
  return { allowed: true };
}

/** The shift (or break) progress bar: percent and a short caption; null with no shift running, never a made-up 0%. */
export function shiftProgress(a: AgentInfo, now: number = Date.now()): { pct: number; label: string; onBreak: boolean } | null {
  const s = agentState(a);
  if (s !== 'resting' && !currentShift(a)) return null;
  if (s === 'resting') {
    const pct = clampPct(parseFloat(String(a.restPercent ?? '0')));
    const end = breakEndsAt(a);
    const left = end !== null ? Math.max(0, Math.ceil((end - now) / 60_000)) : null;
    return { pct, onBreak: true, label: left !== null ? `${Math.round(pct)}% of the break · ${left} min left` : `${Math.round(pct)}% of the break` };
  }
  const pct = clampPct(parseFloat(String(a.percentComplete ?? '0').replace('%', '')));
  const left = typeof a.minutesRemaining === 'number' ? ` · ${Math.round(a.minutesRemaining * 10) / 10} min left` : '';
  return { pct, onBreak: false, label: `${Math.round(pct)}%${left}` };
}

function clampPct(n: number): number {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

/**
 * "#3 · 17 tasks · 4.1 min worked · 12.4K tokens" for the Current shift
 * header. With no shift running it says so and labels what it shows instead
 * (last shift, lifetime), so lifetime totals never read as one shift (M14).
 */
export function shiftSummary(a: AgentInfo, fmtTokens: (n: number) => string): string {
  const tasks = (n: number) => `${n} task${n === 1 ? '' : 's'}`;
  const shift = currentShift(a);
  if (shift) {
    const bits = [`#${shift.watchNumber || 1}`, tasks(shift.tasksCompleted), `${Math.round(shift.minutesWorked * 10) / 10} min worked`];
    if (shift.tokensUsed) bits.push(`${fmtTokens(shift.tokensUsed)} tokens`);
    return bits.join(' · ');
  }
  const bits = ['none running'];
  if (a.lastShift) bits.push(`last #${a.lastShift.watchNumber}: ${tasks(a.lastShift.tasksCompleted)}`);
  if (a.lifetime) bits.push(`lifetime ${tasks(a.lifetime.tasksCompleted)}${a.lifetime.tokensUsed ? `, ${fmtTokens(a.lifetime.tokensUsed)} tokens` : ''}`);
  return bits.join(' · ');
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

/** Handover notes as labelled lines; empty when the agent hasn't handed over yet. */
export function handoverLines(doc: HandoverDoc | null | undefined): { label: string; text: string }[] {
  if (!doc) return [];
  const out: { label: string; text: string }[] = [];
  if (doc.state) out.push({ label: 'State', text: doc.state });
  const pending = (doc.pending ?? []).map((p) => p.task).filter(Boolean);
  if (pending.length) out.push({ label: 'Pending', text: pending.join('; ') });
  const warnings = (doc.warnings ?? []).filter(Boolean);
  if (warnings.length) out.push({ label: 'Warning', text: warnings.join(' ') });
  return out;
}

/** Notes long enough to start collapsed: more than about four lines of text in the panel. */
export function notesAreLong(lines: { text: string }[]): boolean {
  return lines.reduce((n, l) => n + l.text.length, 0) > 320;
}

/**
 * What the Handover notes panel can show. Notes belong to a shift: when the
 * agent moves on, the previous shift's notes are out of date, so they're
 * replaced by a loading or failed line until the new ones arrive.
 */
export function notesStatus(notesShift: number | null | undefined, currentShift: number | null, failed: boolean): 'current' | 'loading' | 'failed' {
  if (notesShift === currentShift) return 'current';
  return failed ? 'failed' : 'loading';
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
