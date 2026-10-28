// Controls' change log: what a change did (old → new) and how to undo it.
// Undo never edits the log. An update's undo loads the old settings into the
// editor, and Save records them as a new change, through the same checks as
// any edit (a Stop still needs its day in Watch). A removed rule comes
// back as a new rule in Watch, like any new rule.

import { ruleSentenceText } from '@/lib/controls-view';
import { RULE_LABELS } from '@/lib/governance';
import { modeWords } from '@/lib/vocab';
import type { GovernanceHistoryEntry, GovernanceRule, GovernanceRuleSnapshot } from '@/lib/whiteroom/types';

const FIELDS = ['mode', 'response', 'alsoNotify', 'appliesTo', 'params'] as const;
type Field = (typeof FIELDS)[number];

/** Deep equality that ignores object key order (the log and the rule list may serialise differently). */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
  : v ?? null);
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const norm = (s: GovernanceRuleSnapshot, f: Field) => (f === 'alsoNotify' ? s.alsoNotify === true : f === 'response' ? s.response ?? 'block' : s[f]);

/**
 * A change in today's words. In the fleet-wide list the rule's name is
 * already shown ("Spend cap · …"), so "Removed Spend cap rule" reads
 * "Removed" and "Added new Keywords rule" reads "Added".
 */
export function historyText(entry: Pick<GovernanceHistoryEntry, 'description' | 'ruleType'>, withRule = false): string {
  const text = modeWords(entry.description);
  if (!withRule) return text;
  const label = RULE_LABELS[entry.ruleType]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = label ? text.match(new RegExp(`^(Removed|Added|Deleted|Created)(?: new)? ${label} rule$`, 'i')) : null;
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : text;
}

/** "Was …" / "Now …" sentences for a settings change; the description already says mode, Then and scope changes. */
export function changeDetail(entry: GovernanceHistoryEntry): { was: string; now: string } | null {
  const { before, after } = entry;
  if (!before || !after || same(before.params, after.params)) return null;
  const sentence = (s: GovernanceRuleSnapshot) => ruleSentenceText({ ruleType: entry.ruleType, params: s.params, response: s.response, alsoNotify: s.alsoNotify, mode: s.mode });
  return { was: sentence(before), now: sentence(after) };
}

export type Undo =
  | { kind: 'update'; ruleId: string; changes: Partial<GovernanceRuleSnapshot> }
  | { kind: 'restore'; rule: GovernanceRuleSnapshot & { ruleType: GovernanceRule['ruleType'] } };

/**
 * How to undo this change, or null when it can't be done safely:
 * - a removal: the rule as it was, to add back (in Watch), only on
 *   its newest removal and until the log shows the same rule added since;
 * - an update: only what this change touched, and only while the rule still
 *   looks exactly as the change left it (otherwise a later change would be
 *   overwritten);
 * - an add, an older entry with no snapshots, or a Keywords list the engine
 *   hid: nothing (Remove is the way to undo an add).
 */
export function undoFor(entry: GovernanceHistoryEntry, rules: GovernanceRule[], history: GovernanceHistoryEntry[] = []): Undo | null {
  const { before, after } = entry;
  if (!before) return null;
  const hidden = (s: GovernanceRuleSnapshot) => entry.ruleType === 'keyword' && !(s.params as { keywords?: string[] }).keywords?.length && Boolean((s.params as { keywordCount?: number }).keywordCount);
  if (hidden(before)) return null;
  if (after === null) {
    if (rules.some((r) => r.id === entry.ruleId)) return null;
    // From the log: once a rule with these settings and scope has been added since (the
    // added-back copy, or an identical one made by hand, which would be redundant), or
    // removed again later, this entry no longer offers it, so it can't come back twice.
    // An identical rule that's simply there, with no later add in the log, doesn't hide it.
    const sameRule = (s: GovernanceRuleSnapshot | null | undefined) => !!s && same(s.params, before.params) && same(s.appliesTo, before.appliesTo);
    const later = history.filter((h) => h.id !== entry.id && h.ruleType === entry.ruleType && Date.parse(h.time) > Date.parse(entry.time));
    if (later.some((h) => (h.before === null && sameRule(h.after)) || (h.after === null && sameRule(h.before)))) return null;
    return { kind: 'restore', rule: { ...structuredClone(before), ruleType: entry.ruleType } };
  }
  if (!after) return null;
  const rule = rules.find((r) => r.id === entry.ruleId);
  if (!rule) return null;
  const current: GovernanceRuleSnapshot = { mode: rule.mode, response: rule.response, alsoNotify: rule.alsoNotify, appliesTo: rule.appliesTo, params: rule.params };
  if (!FIELDS.every((f) => same(norm(current, f), norm(after, f)))) return null;
  const changes: Partial<GovernanceRuleSnapshot> = {};
  for (const f of FIELDS) if (!same(norm(before, f), norm(after, f))) (changes as Record<string, unknown>)[f] = structuredClone(before[f]);
  if (Object.keys(changes).length === 0) return null;
  return { kind: 'update', ruleId: rule.id, changes };
}
