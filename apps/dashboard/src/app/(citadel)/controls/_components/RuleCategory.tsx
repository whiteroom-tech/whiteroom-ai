// A rule's category label ("Data protection", "Cost & reliability"), shown on
// Controls rows, in the editor and in Add a rule. Upper-cased by .ctl-cat.

import type { GovernanceRuleType } from '@/lib/whiteroom/types';
import { RULE_CATEGORY } from '@/lib/governance';

export function RuleCategory({ type }: { type: GovernanceRuleType }) {
  return <span className="ctl-cat">{RULE_CATEGORY[type]}</span>;
}
