// Home's "Latest changes" and its fact line: rule and agent changes only,
// each with who made it and where to look, plus the day the fleet was last
// active. Pure, so the wording can be unit-tested.

import type { AuditEntry, RunDaysResult } from '@/lib/whiteroom/types';
import type { ControlActor } from '@/lib/control-actors';
import type { GovernanceTally } from '@/lib/governance';
import { agentChangeWho, historyWho } from '@/lib/control-actors';
import { RULE_LABELS } from '@/lib/governance';
import { historyText } from '@/lib/rule-history';
import { ROUTES } from '@/lib/routes';
import { fmtCount, fmtWhen, plural } from '@/lib/format';
import { formatDayKey } from '@/lib/zone-time';

/** The audit event types that are rule or agent changes. Home reads each one by type, so busy fleets can't push them out. */
export const CHANGE_TYPES = ['governance_rule_changed', 'register', 'deregister', 'agent_paused', 'agent_stopped', 'agent_resumed'] as const;

export interface ChangeRow {
  key: string;
  time: string;
  text: string;
  href: string;
}

const agentHref = (id: string) => `/agents/${encodeURIComponent(id)}`;

/** " by R Haque", " from the dashboard", " through the API", or '' when nobody is recorded. */
function actorPhrase(by: unknown, at: string, ruleId: string, actions: ControlActor[]): string {
  if (typeof by !== 'string' || !by) return '';
  if (by === 'api') return ' through the API';
  const who = historyWho({ ruleId, time: at, by }, actions);
  return who.startsWith('from ') ? ` ${who}` : ` by ${who}`;
}

/** One rule or agent change in plain words, or null for any other event. */
export function changeRow(e: AuditEntry, actions: ControlActor[] = [], now: number = Date.now(), used?: Set<ControlActor>): ChangeRow | null {
  const at = String(e.timestamp ?? '');
  const agent = String(e.agentId ?? '').trim();
  const base = { key: String(e.id ?? `${e.type}-${at}`), time: fmtWhen(at, now) };
  if (e.type === 'governance_rule_changed') {
    const ruleId = String(e.ruleId ?? '');
    const label = e.ruleType ? RULE_LABELS[e.ruleType] ?? 'Rule' : 'Rule';
    // The engine's message is "<Label>: <description>".
    const description = String(e.message ?? '').replace(/^[^:]*:\s*/, '');
    const what = historyText({ description, ruleType: e.ruleType! }, true);
    const text = /^(added|removed|deleted|created)$/i.test(what) ? `${label} rule ${what.toLowerCase().replace('deleted', 'removed').replace('created', 'added')}` : `${label}: ${what}`;
    return { ...base, text: `${text}${actorPhrase(e.by, at, ruleId, actions)}`, href: ruleId ? `${ROUTES.controls}?rule=${encodeURIComponent(ruleId)}` : ROUTES.controls };
  }
  if (!agent) return null;
  const type = String(e.type);
  // What the dashboard records for each change, to name the person behind an older "dashboard" record.
  const ACTION: Record<string, string> = { agent_paused: 'pause_agent', agent_stopped: 'stop_agent', agent_resumed: 'resume_agent', deregister: 'deregister_agent' };
  const by = typeof e.by === 'string' ? e.by : undefined;
  const person = ACTION[type] ? agentChangeWho({ agentId: agent, action: ACTION[type], time: at, by }, actions, used) : null;
  const done = (verb: string) => {
    // Holds a rule makes write no audit event yet (engine follow-up), so every one here was made by a person or the API.
    if (person) return ` ${verb} by ${person}`;
    if (by === 'api') return ` ${verb} through the API`;
    if (by === 'dashboard' || by?.startsWith('user:')) return ` ${verb} from the dashboard`;
    return ` ${verb}`;
  };
  const said: Record<string, string> = {
    register: ' joined the fleet',
    // A removal names who did it when the dashboard recorded it.
    deregister: person ? ` was removed by ${person}` : ' left the fleet',
    agent_paused: done('paused'),
    agent_stopped: done('stopped'),
    agent_resumed: done('resumed'),
  };
  const text = said[type];
  if (!text) return null;
  return { ...base, text: `${agent}${text}`, href: agentHref(agent) };
}

/** The newest `n` changes from any mix of events, newest first; duplicates (same id) once. */
export function latestChanges(entries: AuditEntry[], actions: ControlActor[] = [], n = 4, now: number = Date.now()): ChangeRow[] {
  const seen = new Set<string>();
  const t = (e: AuditEntry) => Date.parse(String(e.timestamp ?? '')) || 0;
  const rows: ChangeRow[] = [];
  // A dashboard row that named one change can't name another (newest change first).
  const used = new Set<ControlActor>();
  for (const e of [...entries].sort((a, b) => t(b) - t(a))) {
    const key = String(e.id ?? `${e.type}-${String(e.timestamp ?? '')}`);
    if (seen.has(key)) continue;
    const r = changeRow(e, actions, now, used);
    if (!r) continue;
    seen.add(r.key);
    rows.push(r);
    if (rows.length === n) break;
  }
  return rows;
}

/** The most recent day before today with runs, from run_days; null when none. */
export function lastActiveDay(res: RunDaysResult | null, today: string): { day: string; runs: number } | null {
  if (!res) return null;
  const days = res.days.filter((d) => d.day < today && d.runs > 0).sort((a, b) => a.day.localeCompare(b.day));
  return days.at(-1) ?? null;
}

/** "Sat, Oct 24" for a local YYYY-MM-DD. */
export function dayLabel(day: string): string {
  return formatDayKey(day, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * A tally in the outcome words: "2 blocked · 60 would have acted". A Record-only
 * hit can be a would-be pause, stop or alert as well as a block, so it says
 * "acted" (as tallyShort does). '' for none, unless `always`, which keeps
 * "0 blocked · 0 would have acted" (the Rule activity card, where a zero is the answer).
 */
export function ruleOutcomes(t: GovernanceTally, always = false): string {
  const bits: string[] = [];
  if (t.stopped) bits.push(`${fmtCount(t.stopped)} stopped`);
  if (t.paused) bits.push(`${fmtCount(t.paused)} paused`);
  if (t.blocks || always) bits.push(`${fmtCount(t.blocks)} blocked`);
  if (t.toldYou) bits.push(`${fmtCount(t.toldYou)} ${plural(t.toldYou, 'alert')}`);
  if (t.wouldBlocks || always) bits.push(`${fmtCount(t.wouldBlocks)} would have acted`);
  return bits.join(' · ');
}
