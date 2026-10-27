// The words customers see for rule modes, outcomes and keys, in one place, so
// every page says the same thing. Engine identifiers keep their own names
// ('watch' / 'enforce', would_block); only the labels live here.

import type { GovernanceMode as RuleMode } from '@/lib/whiteroom/types';

/** Rule mode labels: Off · Record only · Block. */
export const MODE_LABEL: Record<RuleMode, string> = { off: 'Off', watch: 'Record only', enforce: 'Block' };

/** Group headings on Controls, by mode. */
export const MODE_GROUP: Record<RuleMode, string> = { off: 'Off', watch: 'Record only', enforce: 'Blocking' };

/** What a mode does, in one line. */
export const MODE_MEANING: Record<RuleMode, string> = {
  off: 'Off: the rule does nothing.',
  watch: 'Record only: the rule records what it would have done and lets every call through.',
  enforce: 'Block: the rule acts on matching calls.',
};

/** The count of everything rules did or would have done. */
export const RULE_ACTIVITY = 'Rule activity';

/** Outcome words. */
export const OUTCOME = { blocked: 'blocked', wouldHaveBlocked: 'would have blocked', wouldHaveActed: 'would have acted' } as const;

/** WhiteRoom's own key. Provider keys are "API keys"; ours never is. */
export const FLEET_KEY = 'WhiteRoom fleet key';

/**
 * Rule history text from the engine still uses the old mode names
 * ("Watch → Enforce"); show it in today's words. Display only: parsers
 * (controls-guard) read the stored text.
 */
export function modeWords(text: string): string {
  return text
    .replace(/\bWatch only\b/g, MODE_LABEL.watch)
    .replace(/\bWatch\b/g, MODE_LABEL.watch)
    .replace(/\bEnforce\b/g, MODE_LABEL.enforce);
}
