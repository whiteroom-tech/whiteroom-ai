'use client';

import { useMemo } from 'react';
import {
  eventModel,
  eventSubtitle,
  technicalLine,
  classifyAction,
  shortArg,
  prettyToolName,
  feedDayLabel,
  sortNewestFirst,
  pageSlice,
  pageCount,
  clampPage,
  PAGE_SIZE,
  type AuditEntry,
  type EventModel,
  type FeedVariant,
} from '@/lib/activity';

// Three interchangeable row designs over one shared model (ported from
// whiteroom-ai-whiteroom's dashboard). Styled with this app's existing
// navy/hex palette instead of a shared design-token package, since this app
// doesn't define one.

function Headline({ m, open }: { m: EventModel; open: boolean }) {
  return (
    <>
      {m.canExpand && <span style={{ color: 'var(--info)' }}>{open ? '▾' : '▸'} </span>}
      <span style={{ fontWeight: 700, color: 'var(--tx)' }}>{m.who}</span> {m.said}
    </>
  );
}

/** Technical block + expanded tool calls — identical across all three designs. */
function RowDetail({ m, open, technical }: { m: EventModel; open: boolean; technical: boolean }) {
  const tech = technical ? technicalLine(m) : '';
  if (!tech && !open) return null;
  return (
    <>
      {tech && (
        <div style={{ marginTop: 4, borderLeft: '2px solid var(--line)', paddingLeft: 6, fontSize: 10, wordBreak: 'break-word', color: 'var(--tx2)' }}>
          {tech}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 6, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
          <div style={{ marginBottom: 4, fontSize: 9, fontWeight: 700, letterSpacing: 1.2, color: 'var(--tx3)' }}>WHAT IT DID</div>
          {m.details.map((d, i) => {
            const kind = classifyAction(d?.name);
            const arg = shortArg(d?.args);
            return (
              <div key={i}>
                <div className="flex items-baseline gap-1.5" style={{ padding: '2px 0', fontSize: 11 }}>
                  <span aria-hidden>{kind.icon}</span>
                  <span style={{ flexShrink: 0, fontWeight: 600, color: 'var(--info)' }}>{kind.label}</span>
                  <span style={{ minWidth: 0, wordBreak: 'break-word', color: 'var(--tx2)' }}>{arg || prettyToolName(d?.name)}</span>
                </div>
                {technical && (
                  <div style={{ marginLeft: 24, fontSize: 10, wordBreak: 'break-all', color: 'var(--tx3)' }}>
                    {String(d?.name ?? '')}({String(d?.args ?? '')})
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

interface RowProps {
  m: EventModel;
  open: boolean;
  technical: boolean;
  onToggle: () => void;
}

/** Log — ruled ship's logbook: time and watch in a gutter, a continuous spine. */
function LogRow({ m, open, technical, onToggle }: RowProps) {
  return (
    <div className="grid" style={{ gridTemplateColumns: '44px 14px 1fr', borderBottom: '1px solid var(--line)', paddingRight: 8, paddingBottom: 8, marginBottom: 8 }}>
      <div style={{ paddingRight: 8, paddingTop: 6, textAlign: 'right' }}>
        <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--tx2)' }}>{m.clock}</div>
        <div style={{ marginTop: 2, fontSize: 8.5, letterSpacing: 1, color: 'var(--tx3)' }}>{m.watch}</div>
      </div>
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', left: '50%', top: -8, bottom: -8, width: 1, transform: 'translateX(-50%)', background: 'var(--line)' }} />
        <div style={{ position: 'absolute', left: '50%', top: 10, height: 7, width: 7, transform: 'translateX(-50%) rotate(45deg)', borderRadius: 1, background: m.accent }} />
      </div>
      <div style={{ minWidth: 0, paddingLeft: 6, paddingTop: 6 }}>
        <div style={{ cursor: m.canExpand ? 'pointer' : 'default' }} onClick={m.canExpand ? onToggle : undefined}>
          <div style={{ fontSize: 12, lineHeight: 1.4, wordBreak: 'break-word', color: 'var(--tx)' }}>
            <Headline m={m} open={open} />
          </div>
          <div style={{ marginTop: 2, fontSize: 10.5, color: 'var(--tx2)' }}>{eventSubtitle(m)}</div>
        </div>
        <RowDetail m={m} open={open} technical={technical} />
      </div>
    </div>
  );
}

/** Tape — a running thread with a knot per event and an offset slab. */
function TapeRow({ m, open, technical, onToggle }: RowProps) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: '18px 1fr', marginBottom: 6 }}>
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', left: '50%', top: -6, bottom: -6, width: 2, transform: 'translateX(-50%)', background: 'var(--line)' }} />
        <div
          style={{
            position: 'absolute', left: '50%', top: 12, height: 9, width: 9, transform: 'translate(-50%, -50%)', borderRadius: '50%',
            background: m.accent, boxShadow: `0 0 0 2px var(--card), 0 0 10px -1px ${m.accent}`,
          }}
        />
      </div>
      <div style={{ minWidth: 0, borderRadius: '0 8px 8px 0', border: '1px solid var(--line)', borderLeft: `2px solid ${m.accent}`, background: 'var(--raised)', padding: '6px 10px' }}>
        <div style={{ cursor: m.canExpand ? 'pointer' : 'default' }} onClick={m.canExpand ? onToggle : undefined}>
          <div className="flex items-baseline gap-1.5" style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--tx)' }}>
            <span aria-hidden style={{ flexShrink: 0 }}>{m.icon}</span>
            <span style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>
              <Headline m={m} open={open} />
            </span>
            <span style={{ flexShrink: 0, fontFamily: 'monospace', fontSize: 10, color: 'var(--tx3)' }}>{m.clock}</span>
          </div>
          <div style={{ marginTop: 2, fontSize: 10.5, color: 'var(--tx2)' }}>{eventSubtitle(m)}</div>
        </div>
        <RowDetail m={m} open={open} technical={technical} />
      </div>
    </div>
  );
}

/** Manifest — coded cargo strip, scannable by event kind. */
function ManifestRow({ m, open, technical, onToggle }: RowProps) {
  return (
    <div className="grid items-start gap-2" style={{ gridTemplateColumns: '36px 1fr', borderTop: '1px solid var(--line)', padding: 8 }}>
      <div style={{ borderRadius: 4, border: `1px solid ${m.accent}`, padding: '3px 0', textAlign: 'center', fontSize: 8.5, fontWeight: 800, letterSpacing: 0.6, color: m.accent, background: m.accentBg }}>
        {m.code}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ cursor: m.canExpand ? 'pointer' : 'default' }} onClick={m.canExpand ? onToggle : undefined}>
          <div className="flex items-baseline gap-2" style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--tx)' }}>
            <span style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>
              <Headline m={m} open={open} />
            </span>
            <span style={{ flexShrink: 0, fontFamily: 'monospace', fontSize: 10, color: 'var(--tx3)' }}>{m.clock}</span>
          </div>
          <div style={{ marginTop: 2, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--tx3)' }}>{eventSubtitle(m)}</div>
        </div>
        <RowDetail m={m} open={open} technical={technical} />
      </div>
    </div>
  );
}

const ROWS: Record<FeedVariant, (p: RowProps) => React.ReactElement> = {
  log: LogRow,
  tape: TapeRow,
  manifest: ManifestRow,
};

function Pager({ page, pageCount: total, onChange, onFirst, summary }: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  onFirst?: () => void;
  summary: React.ReactNode;
}) {
  const atFirst = page <= 0;
  const atLast = page >= total - 1;
  const btnStyle = (disabled: boolean): React.CSSProperties => ({
    borderRadius: 4, border: '1px solid var(--line2)', background: 'var(--sunk)', padding: '4px 10px', fontSize: 11,
    color: 'var(--tx2)', whiteSpace: 'nowrap', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.3 : 1,
  });
  return (
    <div className="flex items-center justify-between gap-1.5" style={{ borderTop: '1px solid var(--line)', background: 'var(--card)', padding: '6px 10px' }}>
      <button type="button" style={btnStyle(atFirst)} onClick={() => onChange(page - 1)} disabled={atFirst}>◀ Newer</button>
      <span style={{ minWidth: 0, flex: 1, textAlign: 'center', fontSize: 10.5, color: 'var(--tx2)' }}>{summary}</span>
      {onFirst && !atFirst && (
        <button type="button" style={{ ...btnStyle(false), borderColor: 'var(--ok)', background: 'var(--ok-bg)', color: 'var(--ok)' }} onClick={onFirst}>⤒ Latest</button>
      )}
      <button type="button" style={btnStyle(atLast)} onClick={() => onChange(page + 1)} disabled={atLast}>Older ▶</button>
    </div>
  );
}

export function ActivityFeed({
  entries,
  page,
  onPageChange,
  variant,
  technical,
  expanded,
  onToggleExpanded,
}: {
  entries: AuditEntry[];
  page: number;
  onPageChange: (page: number) => void;
  variant: FeedVariant;
  technical: boolean;
  expanded: Set<string>;
  onToggleExpanded: (key: string) => void;
}) {
  // Sorting is O(n log n) over up to 200 entries on a poll — memoise so a
  // re-render for an unrelated state change doesn't redo it.
  const sorted = useMemo(() => sortNewestFirst(entries), [entries]);
  const total = sorted.length;
  const pages = pageCount(total);
  const current = clampPage(page, total);
  const visible = useMemo(() => pageSlice(sorted, current), [sorted, current]);

  // A divider shows when this row's day differs from the previous row's —
  // derived by comparing against the preceding entry rather than carrying a
  // mutable cursor.
  const rows = useMemo(() => {
    const days = visible.map((e) => feedDayLabel(e.timestamp));
    return visible.map((entry, i) => ({
      model: eventModel(entry),
      day: days[i] !== '' && days[i] !== days[i - 1] ? days[i] : '',
    }));
  }, [visible]);

  if (total === 0) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        <p style={{ marginTop: 32, textAlign: 'center', fontSize: 11, lineHeight: 1.6, color: 'var(--tx3)' }}>
          No activity yet.
          <br />
          Events appear here as your agents work.
        </p>
      </div>
    );
  }

  const Row = ROWS[variant] ?? LogRow;
  const start = current * PAGE_SIZE;

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {rows.map(({ model, day }) => (
          <div key={model.key}>
            {day && (
              <div className="flex items-center gap-2" style={{ marginTop: 12, marginBottom: 6 }}>
                <span style={{ whiteSpace: 'nowrap', fontSize: 10, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)' }}>{day}</span>
                <span style={{ height: 1, flex: 1, background: 'var(--line)' }} />
              </div>
            )}
            <Row
              m={model}
              open={model.canExpand && expanded.has(model.key)}
              technical={technical}
              onToggle={() => onToggleExpanded(model.key)}
            />
          </div>
        ))}
      </div>

      <Pager
        page={current}
        pageCount={pages}
        onChange={onPageChange}
        onFirst={() => onPageChange(0)}
        summary={
          <>
            {current === 0 ? 'Latest' : `${start + 1}–${start + visible.length}`} · page {current + 1} of {pages} ·{' '}
            {total} event{total !== 1 ? 's' : ''}
          </>
        }
      />
    </>
  );
}
