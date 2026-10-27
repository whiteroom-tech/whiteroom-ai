// The words customers see for rule modes, in one place, so every page says
// the same thing. Engine identifiers keep their own names ('watch' /
// 'enforce', would_block); only the labels live here. (WhiteRoom's own key is
// always the "WhiteRoom fleet key"; shift-wording.test.ts keeps "your API key"
// out.)

import type { GovernanceMode as RuleMode } from '@/lib/whiteroom/types';

/** Rule mode labels: Off · Record only · Block. */
export const MODE_LABEL: Record<RuleMode, string> = { off: 'Off', watch: 'Record only', enforce: 'Block' };

/** Group headings on Controls, by mode. */
export const MODE_GROUP: Record<RuleMode, string> = { off: 'Off', watch: 'Record only', enforce: 'Acting' };

/** What a mode does, in one line. */
export const MODE_MEANING: Record<RuleMode, string> = {
  off: 'Off: the rule does nothing.',
  watch: 'Record only: the rule records what it would have done and lets every call through.',
  enforce: 'Block: the rule acts on matching calls (alerts, blocks, pauses or stops).',
};

/** The count of everything rules did or would have done. */
export const RULE_ACTIVITY = 'Rule activity';

/**
 * Rule history text from the engine still uses the old mode names
 * ("Watch → Enforce", "… in Watch only"); show it in today's words. Only mode
 * changes and "in Watch" are rewritten, so a name containing "Watch" stays.
 * Display only: parsers (controls-guard) read the stored text.
 */
const OLD_MODE: Record<string, string> = { Off: MODE_LABEL.off, Watch: MODE_LABEL.watch, 'Watch only': MODE_LABEL.watch, Enforce: MODE_LABEL.enforce };
export function modeWords(text: string): string {
  return text
    .replace(/\b(Off|Watch only|Watch|Enforce) → (Off|Watch only|Watch|Enforce)\b/g, (_, a: string, b: string) => `${OLD_MODE[a]} → ${OLD_MODE[b]}`)
    .replace(/\bin Watch( only)?\b/g, `in ${MODE_LABEL.watch}`);
}
