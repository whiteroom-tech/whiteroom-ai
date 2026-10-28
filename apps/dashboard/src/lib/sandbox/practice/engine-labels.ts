// The one place the dashboard reads meaning out of the engine's control-check
// labels. Source: engine repo apps/engine/src/readiness/controls.ts:135-176
// (`ruleDetail` + `ruleLabels`, engine main 1f3d6163). The formats:
//
//   "Spend cap"                                   only rule of its type
//   "Spend cap (100,000 tokens a day)"            several of its type: its settings
//   "Spend cap ($5 a run, for alpha, beta)"       …then the agents it covers, when not all
//   "Spend cap (100,000 tokens a day) #2"         same settings and mode as an earlier row
//   "Keywords (0 keywords)" / "Keywords (1 keyword)"   keyword rules: a count, never the words
//
// Settings appear only when a fleet has two or more rules of that type, so a
// lone keyword rule with no keywords reads just "Keywords" and can't be told
// apart here. E1 (pre-flight spec §8) moves this into structured fields
// (and has the engine skip empty keyword rules); this module then goes away.

import type { PracticeControlCheck } from './types';

export interface ControlLabel {
  /** The control's name: "Spend cap". */
  name: string;
  /** What sets the rule apart from others of its type, agents included; null when the label has none. */
  settings: string | null;
  /** The engine's " #n" for a row alike in settings and mode to an earlier one; null for the first. */
  n: number | null;
}

const LABEL_RE = /^(.*?)(?: \((.*)\))?(?: #(\d+))?$/;

/** Splits an engine control-check label into its name, settings and " #n". */
export function parseControlLabel(label: string): ControlLabel {
  const m = LABEL_RE.exec(label)!;
  return { name: m[1], settings: m[2] ?? null, n: m[3] ? Number(m[3]) : null };
}

/** A keyword rule whose label says it has no keywords ("Keywords (0 keywords)", maybe ", for …" after). */
export function isEmptyKeywordRule(c: Pick<PracticeControlCheck, 'id' | 'label'>): boolean {
  if (!c.id.startsWith('ctl.keyword.')) return false;
  return /^0 keywords(?:,|$)/.test(parseControlLabel(c.label).settings ?? '');
}

/**
 * What makes two rows the same rule as far as the label can tell: name,
 * settings, mode and the agents covered. Null when the label carries no
 * settings, since then sameness can't be claimed.
 */
export function sameRuleKey(c: Pick<PracticeControlCheck, 'label' | 'mode' | 'agents'>): string | null {
  const l = parseControlLabel(c.label);
  if (l.settings === null) return null;
  const agents = c.agents === 'all' ? 'all' : [...c.agents].sort().join(',');
  return [l.name, l.settings, c.mode ?? '', agents].join('\u0000');
}
