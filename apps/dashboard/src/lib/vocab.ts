// The words customers see for rule modes, in one place, so every page says
// the same thing. Engine identifiers keep their own names ('watch' /
// 'enforce', would_block); only the labels live here. (WhiteRoom's own key is
// always the "WhiteRoom fleet key"; shift-wording.test.ts keeps "your API key"
// out.)

import type { GovernanceMode as RuleMode, GovernanceResponse } from '@/lib/whiteroom/types';

/** Rule mode labels: Off · Watch · Enforce. */
export const MODE_LABEL: Record<RuleMode, string> = { off: 'Off', watch: 'Watch', enforce: 'Enforce' };

/**
 * The notify response in customer words: the "When enforced" option, the
 * verb in a rule's sentence, the count of times it fired, and its tag. The
 * engine value stays 'notify'.
 */
export const NOTIFY = { option: 'Only alert me', verb: 'alert you', done: 'alerted you', tag: 'Alert only' } as const;

/**
 * An enforced rule's tag: Enforce, plus what it does when that isn't blocking
 * the call. A rule that only alerts never stops a call, so it says Alert only
 * rather than Enforce (the Controls lead line counts it apart too).
 */
export const ENFORCE_TAG: Record<GovernanceResponse, string> = { block: 'Enforce', pause: 'Enforce · pauses', stop: 'Enforce · stops', notify: NOTIFY.tag };

/** A rule's mode as its tag reads: Off, Watch, or what it enforces (ENFORCE_TAG). */
export function modeTagText(rule: { mode: RuleMode; response?: GovernanceResponse }): string {
  return rule.mode === 'enforce' ? ENFORCE_TAG[rule.response ?? 'block'] : MODE_LABEL[rule.mode];
}

/** The count of everything rules did or would have done. */
export const RULE_ACTIVITY = 'Rule activity';

/**
 * Rule history text uses the engine's mode names ("Watch → Enforce", "… in
 * Watch only"), and entries written Oct 22–28 used the retired labels ("in
 * Record only"); show them all in today's words. Only mode changes and "in
 * <mode>" are rewritten, so a name containing "Watch" stays. Display only:
 * parsers (controls-guard) read the stored text.
 */
const OLD_MODE: Record<string, string> = {
  Off: MODE_LABEL.off, Watch: MODE_LABEL.watch, 'Watch only': MODE_LABEL.watch, 'Record only': MODE_LABEL.watch, Enforce: MODE_LABEL.enforce, Block: MODE_LABEL.enforce,
};
const MODE_WORD = 'Off|Watch only|Watch|Record only|Enforce|Block';
export function modeWords(text: string): string {
  return text
    .replace(new RegExp(`\\b(${MODE_WORD}) → (${MODE_WORD})\\b`, 'g'), (_, a: string, b: string) => `${OLD_MODE[a]} → ${OLD_MODE[b]}`)
    .replace(/\bin (Watch only|Watch|Record only)\b/g, `in ${MODE_LABEL.watch}`);
}
