// The words customers see for rule modes, in one place, so every page says
// the same thing. Engine identifiers keep their own names ('watch' /
// 'enforce', would_block); only the labels live here. (WhiteRoom's own key is
// always the "WhiteRoom fleet key"; shift-wording.test.ts keeps "your API key"
// out.)

import type { GovernanceMode as RuleMode } from '@/lib/whiteroom/types';

/** Rule mode labels: Off · Record only · Block. */
export const MODE_LABEL: Record<RuleMode, string> = { off: 'Off', watch: 'Record only', enforce: 'Block' };

/**
 * The notify response in customer words: the picker option, the verb in a
 * rule's sentence, the count of times it fired, and its row tag. The engine
 * value stays 'notify'.
 */
export const NOTIFY = { option: 'Alert me', verb: 'alert you', done: 'alerted you', tag: 'Alerts' } as const;

/**
 * A rule's row tag: what it does now. Record only for watch; in Block mode, the response, so a rule
 * that only alerts never wears a red "Block" (only real stops are filled).
 */
export const DOES_TAG: Record<'block' | 'pause' | 'stop' | 'notify', string> = { block: 'Blocks', pause: 'Pauses', stop: 'Stops', notify: NOTIFY.tag };

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
