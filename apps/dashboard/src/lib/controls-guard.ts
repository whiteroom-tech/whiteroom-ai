// Controls safety rails that need no engine change (Governance Loop Rev 9
// §3, "Heavy rungs"): a rule may only stop agents once it has run in Watch
// for a day, and turning that on means typing who it applies to. Plus the
// per-rule "Watching: would have…" line from the engine's Watch events.

import type { AuditEntry, GovernanceHistoryEntry, GovernanceResponse, GovernanceScope } from '@/lib/whiteroom/types';

export const STOP_WATCH_HOURS = 24;

// Mode changes are read from the engine's history wording, "Off → Watch"
// (concepts/governance.ts updateRule: `${cap(prev.mode)} → ${cap(mode)}`).
// The history has no structured mode field. If that wording changes, Watch
// time reads as 0 and Stop stays blocked (fails closed) with the reason shown;
// governance-guard tests pin the format. The engine doesn't enforce this guard.
const MODE_CHANGE = /^(Off|Watch|Enforce) → (Off|Watch|Enforce)$/;

/**
 * The longest unbroken stretch, in hours, this rule has spent in Watch,
 * read from its history ("Off → Watch", "Watch → Enforce"). A rule created
 * in Watch counts from its first history entry.
 */
export function longestWatchHours(ruleId: string, history: GovernanceHistoryEntry[], currentMode: string, now: number = Date.now()): number {
  const entries = history.filter((h) => h.ruleId === ruleId).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (entries.length === 0) return 0;
  const changes = entries.flatMap((h) => {
    const m = MODE_CHANGE.exec(h.description);
    return m ? [{ from: m[1], to: m[2], at: Date.parse(h.time) }] : [];
  });
  // The mode it was created in: the first change's "from", else today's mode,
  // but only counted from the engine's own creation entry ("Added new …").
  const created = /^Added new /.test(entries[0].description);
  const createdIn = changes[0]?.from ?? (currentMode === 'watch' ? 'Watch' : 'Other');
  let start: number | null = created && createdIn === 'Watch' ? Date.parse(entries[0].time) : null;
  let best = 0;
  for (const c of changes) {
    if (c.from === 'Watch' && start !== null) { best = Math.max(best, c.at - start); start = null; }
    if (c.to === 'Watch') start = c.at;
  }
  if (start !== null && currentMode === 'watch') best = Math.max(best, now - start);
  return Number.isFinite(best) ? best / 3_600_000 : 0;
}

/** Why Stop can't be turned on yet, or null when it can. */
export function stopBlockedReason(ruleId: string, history: GovernanceHistoryEntry[], currentMode: string, now: number = Date.now()): string | null {
  const h = longestWatchHours(ruleId, history, currentMode, now);
  if (h >= STOP_WATCH_HOURS) return null;
  const ran = h < 1 ? 'less than an hour' : `${Math.floor(h)} ${Math.floor(h) === 1 ? 'hour' : 'hours'}`;
  return `Run this rule in Watch for ${STOP_WATCH_HOURS} hours before it can stop agents, so you can see what it would have done. It has run in Watch for ${ran}.`;
}

/**
 * What a rule change needs before it may go ahead: nothing, a typed
 * confirmation (it would stop agents for real), or nothing at all yet
 * (not long enough in Watch). Stop + Enforce is "for real", whichever
 * of the two is set last.
 */
export function stopCheck(
  rule: { id: string; mode: string; response?: GovernanceResponse },
  change: { mode?: string; response?: GovernanceResponse },
  history: GovernanceHistoryEntry[],
  now: number = Date.now(),
): { kind: 'ok' } | { kind: 'confirm' } | { kind: 'blocked'; reason: string } {
  const mode = change.mode ?? rule.mode;
  const response = change.response ?? rule.response ?? 'block';
  const already = rule.mode === 'enforce' && rule.response === 'stop';
  if (mode !== 'enforce' || response !== 'stop' || already) return { kind: 'ok' };
  const reason = stopBlockedReason(rule.id, history, rule.mode, now);
  return reason ? { kind: 'blocked', reason } : { kind: 'confirm' };
}

/** What to type to let a rule stop agents: the agents it covers, by name. */
export function stopPhrase(scope: GovernanceScope): string {
  return scope === 'all' ? 'stop all agents' : scope.join(', ');
}

const WOULD_VERB: Record<GovernanceResponse, string> = { notify: 'told you about', block: 'blocked', pause: 'paused', stop: 'stopped' };

/**
 * "Watching: would have paused lead-agent 86 times" from the engine's
 * governance_would_block events for this version of the rule. Null when
 * it hasn't fired since its last change.
 */
export function watchSummary(rule: { id: string; version: number; response?: GovernanceResponse }, events: AuditEntry[]): string | null {
  const response = rule.response ?? 'block';
  const byAgent = new Map<string, number>();
  for (const e of events) {
    // Only events from the rule as it is now: an older version may have had
    // another response, threshold or scope.
    if (e.type !== 'governance_would_block' || e.ruleId !== rule.id || Number(e.ruleVersion) !== rule.version) continue;
    const agent = String(e.agentId ?? 'an agent');
    const n = Number(e.occurrences);
    byAgent.set(agent, (byAgent.get(agent) ?? 0) + (Number.isFinite(n) && n > 0 ? n : 1));
  }
  if (byAgent.size === 0) return null;
  const parts = [...byAgent].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n === 1 ? 'once' : `${n.toLocaleString()} times`}`);
  const shown = parts.slice(0, 3).join(', ') + (parts.length > 3 ? ` and ${parts.length - 3} more` : '');
  return `Watching: would have ${WOULD_VERB[response]} ${shown} since its last change.`;
}
