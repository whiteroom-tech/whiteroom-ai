'use client';

// One line of a rule's change log: what changed, when and by whom, the old and
// new sentence for a settings change, and Undo when it can be undone safely.

import { timeAgo } from '@/lib/format';
import { historyWho, type ControlActor } from '@/lib/control-actors';
import { RULE_LABELS } from '@/lib/governance';
import { changeDetail, type Undo } from '@/lib/rule-history';
import { modeWords } from '@/lib/vocab';
import type { GovernanceHistoryEntry } from '@/lib/whiteroom/types';

export function HistoryLine({ entry, actors, withRule, undo, onUndo, busy }: {
  entry: GovernanceHistoryEntry;
  actors?: ControlActor[];
  /** Name the rule too (the fleet-wide Recent changes list). */
  withRule?: boolean;
  undo: Undo | null;
  onUndo: (u: Undo, entryId: string) => void;
  busy?: boolean;
}) {
  const detail = changeDetail(entry);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-sm)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ minWidth: 0 }}>{withRule && `${RULE_LABELS[entry.ruleType]} · `}{modeWords(entry.description)}</span>
        <span style={{ color: 'var(--tx2)', flex: 'none' }}>{timeAgo(entry.time)}{actors && ` · ${historyWho(entry, actors)}`}</span>
      </div>
      {detail && (
        <div style={{ color: 'var(--tx2)', lineHeight: 1.45 }}>
          <div>Was: {detail.was}</div>
          <div>Now: {detail.now}</div>
        </div>
      )}
      {undo && (
        <button type="button" className="gov-link" disabled={busy} onClick={() => onUndo(undo, entry.id)}
          style={{ alignSelf: 'flex-start', padding: '2px 0', border: 0, background: 'none', color: 'var(--brand)', fontWeight: 600, fontSize: 'var(--fs-sm)', cursor: busy ? 'default' : 'pointer' }}>
          {undo.kind === 'restore' ? 'Add it back' : 'Undo this change'}
        </button>
      )}
    </div>
  );
}
