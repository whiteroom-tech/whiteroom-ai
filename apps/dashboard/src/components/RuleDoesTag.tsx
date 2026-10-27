import { Tag } from '@whiteroom/ui';
import type { GovernanceRule } from '@/lib/whiteroom/types';
import { DOES_TAG, MODE_LABEL } from '@/lib/vocab';
import { emptyPick, isStopping } from '@/lib/controls-view';

/**
 * A rule's tag, as Controls and the agent page show it: Record only, Not set
 * up, or what it does in Block. Filled only when it really stops calls
 * (isStopping): an alert-only rule, or one with nothing picked yet, isn't.
 * Nothing for an Off rule.
 */
export function RuleDoesTag({ rule }: { rule: GovernanceRule }) {
  if (rule.mode === 'watch') return <Tag tone="muted">{MODE_LABEL.watch}</Tag>;
  if (rule.mode !== 'enforce') return null;
  if (emptyPick(rule)) return <Tag tone="muted">Not set up</Tag>;
  return <Tag tone={isStopping(rule) ? 'block' : 'brand'}>{DOES_TAG[rule.response ?? 'block']}</Tag>;
}
