// Home's "Latest changes" and its fact line: rule and agent changes only,
// each with who made it and where to look, plus the day the fleet was last
// active. Pure, so the wording can be unit-tested.

import type { AuditEntry, RunDaysResult } from '@/lib/whiteroom/types';
import type { ControlActor } from '@/lib/control-actors';
import type { GovernanceTally } from '@/lib/governance';
import { historyWho } from '@/lib/control-actors';
import { RULE_LABELS } from '@/lib/governance';
import { historyText } from '@/lib/rule-history';
import { ROUTES } from '@/lib/routes';
import { fmtWhen, plural } from '@/lib/format';

/** The audit event types that are rule or agent changes. Home reads each one by type, so busy fleets can't push them out. */
export const CHANGE_TYPES = ['governance_rule_changed', 'register', 'deregister', 'agent_paused', 'agent_stopped', 'agent_resumed'] as const;

export interface ChangeRow {
  key: string;
  time: string;
  text: string;
  href: string;
}

const agentHref = (id: string) => `/agents/${encodeURIComponent(id)}`;

/** " by R Haque", " by a rule", " from the dashboard", " through the API", or '' when nobody is recorded. */
function actorPhrase(by: unknown, at: string, ruleId: string, actions: ControlActor[]): string {
  if (typeof by !== 'string' || !by) return '';
  if (by.startsWith('rule:')) return ' by a rule';
  if (by === 'api') return ' through the API';
  const who = historyWho({ ruleId, time: at, by }, actions);
  return who.startsWith('from ') ? ` ${who}` : ` by ${who}`;
}

/** One rule or agent change in plain words, or null for any other event. */
export function changeRow(e: AuditEntry, actions: ControlActor[] = [], now: number = Date.now()): ChangeRow | null {
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
  const said: Record<string, string> = {
    register: 'joined the fleet',
    deregister: 'left the fleet',
    agent_paused: 'paused',
    agent_stopped: 'stopped',
    agent_resumed: 'resumed',
  };
  const verb = said[String(e.type)];
  if (!verb) return null;
  const who = e.type === 'agent_paused' || e.type === 'agent_stopped' || e.type === 'agent_resumed' ? actorPhrase(e.by, at, '', actions) : '';
  return { ...base, text: `${agent} ${verb}${who}`, href: agentHref(agent) };
}

/** The newest `n` changes from any mix of events, newest first; duplicates (same id) once. */
export function latestChanges(entries: AuditEntry[], actions: ControlActor[] = [], n = 4, now: number = Date.now()): ChangeRow[] {
  const seen = new Set<string>();
  const t = (e: AuditEntry) => Date.parse(String(e.timestamp ?? '')) || 0;
  const rows: ChangeRow[] = [];
  for (const e of [...entries].sort((a, b) => t(b) - t(a))) {
    const r = changeRow(e, actions, now);
    if (!r || seen.has(r.key)) continue;
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
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * A tally in the outcome words: "2 blocked · 60 would have blocked". '' for
 * none, unless `always`, which keeps "0 blocked · 0 would have blocked" (the
 * Rule activity card, where a zero is the answer).
 */
export function ruleOutcomes(t: GovernanceTally, always = false): string {
  const bits: string[] = [];
  if (t.stopped) bits.push(`${t.stopped} stopped`);
  if (t.paused) bits.push(`${t.paused} paused`);
  if (t.blocks || always) bits.push(`${t.blocks} blocked`);
  if (t.toldYou) bits.push(`${t.toldYou} ${plural(t.toldYou, 'alert')}`);
  if (t.wouldBlocks || always) bits.push(`${t.wouldBlocks} would have blocked`);
  return bits.join(' · ');
}
