import { Tag } from '@whiteroom/ui';
import type { GovernanceRule } from '@/lib/whiteroom/types';
import { MODE_LABEL, modeTagText } from '@/lib/vocab';
import { emptyPick, isStopping } from '@/lib/controls-view';

/**
 * A rule's tag, as Controls and the agent page show it: Watch, Not set up,
 * or Enforce (with the action when it isn't Block; Alert only for a rule that
 * only alerts). Filled only when it really stops calls (isStopping): an
 * alert-only rule, or one with nothing picked yet, isn't. Nothing for an Off
 * rule.
 */
export function RuleDoesTag({ rule }: { rule: GovernanceRule }) {
  if (rule.mode === 'watch') return <Tag tone="muted">{MODE_LABEL.watch}</Tag>;
  if (rule.mode !== 'enforce') return null;
  if (emptyPick(rule)) return <Tag tone="muted">Not set up</Tag>;
  return <Tag tone={isStopping(rule) ? 'block' : 'brand'}>{modeTagText(rule)}</Tag>;
}
