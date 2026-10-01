'use client';

export type Column<R> = {
  key: string;
  header: React.ReactNode;
  /** CSS grid track, e.g. '56px' or 'minmax(140px,1fr)'. */
  width: string;
  align?: 'left' | 'right';
  /** Mono, tabular numbers. */
  numeric?: boolean;
  render: (row: R) => React.ReactNode;
};

/**
 * Mono uppercase header, 40–44px rows, numeric columns right-aligned and
 * tabular. With `onOpen`, the whole row is the target: it's focusable and
 * Enter or Space opens it. `selectedKey` tints a row with brand-dim.
 */
export function DataTable<R>({ columns, rows, rowKey, onOpen, selectedKey, rowHeight = 42, caption, empty, footer }: {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  onOpen?: (row: R) => void;
  selectedKey?: string;
  rowHeight?: 40 | 42 | 44;
  /** Visually hidden table name for screen readers. */
  caption: string;
  empty?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const grid = columns.map((c) => c.width).join(' ');
  return (
    <div role="table" aria-label={caption} className="wr-table">
      <div role="rowgroup" className="wr-table__head">
        <div role="row" className="wr-table__row wr-table__row--head" style={{ gridTemplateColumns: grid }}>
          {columns.map((c) => (
            <span key={c.key} role="columnheader" className={c.align === 'right' ? 'is-right' : undefined}>{c.header}</span>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        {rows.length === 0 && empty && <div className="wr-table__empty">{empty}</div>}
        {rows.map((r) => {
          const k = rowKey(r);
          return (
            <div
              key={k}
              role="row"
              tabIndex={onOpen ? 0 : undefined}
              aria-selected={selectedKey === undefined ? undefined : selectedKey === k}
              className={`wr-table__row${onOpen ? ' is-link' : ''}${selectedKey === k ? ' is-selected' : ''}`}
              style={{ gridTemplateColumns: grid, height: rowHeight }}
              onClick={onOpen ? () => onOpen(r) : undefined}
              onKeyDown={onOpen ? (e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r); }
              } : undefined}
            >
              {columns.map((c) => (
                <span key={c.key} role="cell" className={`${c.align === 'right' ? 'is-right' : ''}${c.numeric ? ' is-num' : ''}`.trim() || undefined}>
                  {c.render(r)}
                </span>
              ))}
            </div>
          );
        })}
      </div>
      {footer && <div className="wr-table__foot">{footer}</div>}
    </div>
  );
}
