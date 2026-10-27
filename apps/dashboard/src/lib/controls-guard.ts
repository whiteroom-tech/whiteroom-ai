// Controls safety rails that need no engine change (Governance Loop Rev 9
// §3, "Heavy rungs"): a rule may only stop agents once it has run in Watch
// for a day, and turning that on means typing who it applies to.

import { keywordTotal } from '@/lib/controls-view';
import type { GovernanceHistoryEntry, GovernanceParams, GovernanceResponse, GovernanceRule, GovernanceScope, KeywordParams, ModelAllowlistParams, ToolListParams } from '@/lib/whiteroom/types';
import { plural, HOUR_MS } from '@/lib/format';

/**
 * A rule in Enforce that can act, so the proxy refuses calls it can't tie to
 * an agent. An empty model allowlist or tool list acts on nothing, and Alert
 * me lets every call through. Mirrors the engine's fleetHasEnforcingRule
 * (concepts/governance.ts).
 */
export function canAct(rule: Pick<GovernanceRule, 'mode' | 'ruleType' | 'params' | 'response'>): boolean {
  if (rule.mode !== 'enforce') return false;
  if (rule.response === 'notify') return false;
  if (rule.ruleType === 'model_allowlist' && (rule.params as ModelAllowlistParams).allowedModels.length === 0) return false;
  if (rule.ruleType === 'tool_list' && (rule.params as ToolListParams).blockedTools.length === 0) return false;
  if (rule.ruleType === 'keyword' && keywordTotal(rule.params as KeywordParams) === 0) return false;
  return true;
}

export const STOP_WATCH_HOURS = 24;

// Mode changes and creation are read from each history entry's before/after
// snapshots (engine 0058): before === null is the rule being added, and a
// different before.mode and after.mode is a mode change, whatever the entry's
// description says (Undo, copies and suggestions write their own). Older
// entries without snapshots fall back to the engine's wording, "Off → Watch"
// and "Added new …". If neither reads, Watch time is 0 and actions that need a
// day in Record only stay unavailable (fails closed). The engine doesn't
// enforce this guard.
const MODE_CHANGE = /^(Off|Watch|Enforce) → (Off|Watch|Enforce)$/;
const MODE_WORD = { off: 'Off', watch: 'Watch', enforce: 'Enforce' } as const;

type ModeEvent = { at: number; created?: string; from?: string; to?: string };

/** What one history entry says about the rule's mode: added in a mode, a change from one to another, or nothing. */
function modeEvent(h: GovernanceHistoryEntry): ModeEvent | null {
  const at = Date.parse(h.time);
  if (h.before === null && h.after) return { at, created: MODE_WORD[h.after.mode] };
  if (h.before && h.after) return h.before.mode !== h.after.mode ? { at, from: MODE_WORD[h.before.mode], to: MODE_WORD[h.after.mode] } : null;
  if (h.before !== undefined || h.after !== undefined) return null;
  const m = MODE_CHANGE.exec(h.description);
  if (m) return { at, from: m[1], to: m[2] };
  return /^Added new /.test(h.description) ? { at, created: '' } : null;
}

/** The rule's stretches in Watch from its history: the longest (ms) and when the current one began (null: not in Watch). */
function watchStretches(ruleId: string, history: GovernanceHistoryEntry[], currentMode: string, now: number): { best: number; current: number | null } {
  const events = history.filter((h) => h.ruleId === ruleId).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .map(modeEvent).filter((e): e is ModeEvent => e !== null);
  if (events.length === 0) return { best: 0, current: null };
  let start: number | null = null;
  let best = 0;
  for (const [i, e] of events.entries()) {
    if (e.created !== undefined) {
      // An old creation entry doesn't say the mode: the first change's "from", else today's mode.
      const next = events.slice(i + 1).find((x) => x.from);
      const mode = e.created || (next?.from ?? (currentMode === 'watch' ? 'Watch' : 'Other'));
      start = mode === 'Watch' ? e.at : null;
      continue;
    }
    if (e.from === 'Watch' && start !== null) { best = Math.max(best, e.at - start); start = null; }
    if (e.to === 'Watch') start = e.at;
  }
  const current = start !== null && currentMode === 'watch' ? start : null;
  if (current !== null) best = Math.max(best, now - current);
  return { best: Number.isFinite(best) ? best : 0, current };
}

/**
 * The longest unbroken stretch, in hours, this rule has spent in Watch,
 * read from its history ("Off → Watch", "Watch → Enforce"). A rule created
 * in Watch counts from its first history entry.
 */
export function longestWatchHours(ruleId: string, history: GovernanceHistoryEntry[], currentMode: string, now: number = Date.now()): number {
  return watchStretches(ruleId, history, currentMode, now).best / HOUR_MS;
}

/**
 * When an action that needs a day in Record only first can be picked: null
 * when it already can; the time, while the rule is in Record only now;
 * 'record-first' when it isn't recording yet; 'unknown' when it is but the
 * history doesn't say since when (fails closed, like stopBlockedReason).
 */
export function actionAvailableFrom(ruleId: string, history: GovernanceHistoryEntry[], currentMode: string, now: number = Date.now()): number | 'record-first' | 'unknown' | null {
  const { best, current } = watchStretches(ruleId, history, currentMode, now);
  if (best >= STOP_WATCH_HOURS * HOUR_MS) return null;
  if (current !== null) return current + STOP_WATCH_HOURS * HOUR_MS;
  return currentMode === 'watch' ? 'unknown' : 'record-first';
}

/** Why Stop can't be turned on yet, or null when it can. */
export function stopBlockedReason(ruleId: string, history: GovernanceHistoryEntry[], currentMode: string, now: number = Date.now(), what = 'stop agents'): string | null {
  const h = longestWatchHours(ruleId, history, currentMode, now);
  if (h >= STOP_WATCH_HOURS) return null;
  const ran = h < 1 ? 'less than an hour' : `${Math.floor(h)} ${plural(Math.floor(h), 'hour')}`;
  return `Run this rule in Record only for ${STOP_WATCH_HOURS} hours before it can ${what}, so you can see what it would have done. It has run in Record only for ${ran}.`;
}

/**
 * A Keywords rule that stops incoming data (Block, Pause or Stop on
 * "incoming" or "both") ends the run: the agent re-sends the same data each
 * call. So, like Stop, it needs a day in Watch and a typed confirmation
 * (Controls spec Rev 1, decision 3). Stop itself is stopCheck's.
 */
export function keywordBlockCheck(
  rule: { id: string; ruleType: string; mode: string; response?: GovernanceResponse; params: GovernanceParams },
  change: { mode?: string; response?: GovernanceResponse; params?: GovernanceParams },
  history: GovernanceHistoryEntry[],
  now: number = Date.now(),
): { kind: 'ok' } | { kind: 'confirm' } | { kind: 'blocked'; reason: string } {
  if (rule.ruleType !== 'keyword') return { kind: 'ok' };
  type R = { mode: string; response?: GovernanceResponse; params: GovernanceParams };
  const onIncoming = (r: R) => r.mode === 'enforce' && (r.response ?? 'block') !== 'notify' && (r.params as KeywordParams).where !== 'replies';
  const next = { mode: change.mode ?? rule.mode, response: change.response ?? rule.response, params: change.params ?? rule.params };
  // Stop is stopCheck's; a rule already ending runs on incoming data (Stop too) was confirmed then.
  if (!onIncoming(next) || next.response === 'stop' || onIncoming(rule)) return { kind: 'ok' };
  const reason = stopBlockedReason(rule.id, history, rule.mode, now, `${keywordVerb(next.response)} on incoming data`);
  return reason ? { kind: 'blocked', reason } : { kind: 'confirm' };
}

/** What a Keywords rule that acts on incoming data does: block the call, or pause the agent. */
export function keywordVerb(response: GovernanceResponse | undefined): 'block calls' | 'pause agents' {
  return response === 'pause' ? 'pause agents' : 'block calls';
}

/** What to type to let a Keywords rule act on incoming data: the agents it covers, by name. */
export function keywordPhrase(scope: GovernanceScope, response?: GovernanceResponse): string {
  return scope === 'all' ? `${response === 'pause' ? 'pause' : 'block'} all agents` : scope.join(', ');
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
