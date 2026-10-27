'use client';

// One line of a rule's change log: what changed, when and by whom, the old and
// new sentence for a settings change, and Undo when it can be undone safely.

import { fmtWhen, timeAgo } from '@/lib/format';
import { historyWho, type ControlActor } from '@/lib/control-actors';
import { RULE_LABELS } from '@/lib/governance';
import { changeDetail, historyText, type Undo } from '@/lib/rule-history';
import type { GovernanceHistoryEntry } from '@/lib/whiteroom/types';

export function HistoryLine({ entry, actors, withRule, compact, undo, onUndo, busy }: {
  entry: GovernanceHistoryEntry;
  actors?: ControlActor[];
  /** Name the rule too (the fleet-wide Recent changes list). */
  withRule?: boolean;
  /** No old/new sentences (the page's Recent changes): one line, and Undo when there is one. */
  compact?: boolean;
  undo: Undo | null;
  onUndo: (u: Undo, entryId: string) => void;
  busy?: boolean;
}) {
  const detail = changeDetail(entry);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-sm)' }}>
      {/* One layout for every change: what changed and who on the left, when always on the right. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <span style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>{what(entry, withRule)} · {historyWho(entry, actors ?? [])}</span>
        <time dateTime={entry.time} title={timeAgo(entry.time)} style={{ color: 'var(--tx2)', flex: 'none', whiteSpace: 'nowrap' }}>{fmtWhen(entry.time)}</time>
      </div>
      {detail && !compact && (
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

/** "Spend cap added" for an add or removal in the fleet-wide list, else "Spend cap · <change>". */
function what(entry: GovernanceHistoryEntry, withRule?: boolean): string {
  const text = historyText(entry, withRule);
  if (!withRule) return text;
  const label = RULE_LABELS[entry.ruleType] ?? 'Rule';
  return /^(Added|Removed|Deleted|Created)$/.test(text) ? `${label} ${text.toLowerCase()}` : `${label} · ${text}`;
}
