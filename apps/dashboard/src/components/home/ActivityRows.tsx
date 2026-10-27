import { Tag, FONT_MONO } from '@whiteroom/ui';
import type { ActivityRow } from '@/lib/home';

/** Activity rows in plain words (Home, Agent detail), or a muted empty line. */
export function ActivityRows({ rows, empty }: { rows: ActivityRow[]; empty: string }) {
  if (rows.length === 0) {
    return <p style={{ margin: 0, padding: '14px 18px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{empty}</p>;
  }
  return rows.map((r) => (
    <div key={r.key} className="wr-activity-row">
      <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)' }}>{r.time}</span>
      <span style={{ fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.text}</span>
      {r.tag ? <Tag tone={r.tag.tone}>{r.tag.label}</Tag> : <span />}
    </div>
  ));
}
