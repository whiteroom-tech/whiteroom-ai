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
 * Enter or Space opens it, and the table is exposed as an ARIA grid (where
 * focusable rows and aria-selected are valid). Without it, a plain table.
 * `selectedKey` tints a row with brand-dim.
 */
export function DataTable<R>({ columns, rows, rowKey, onOpen, selectedKey, rowHeight = 42, caption, empty, footer }: {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  onOpen?: (row: R) => void;
  selectedKey?: string;
  rowHeight?: 40 | 42 | 44;
  /** The table's accessible name (aria-label), e.g. "Runs". */
  caption: string;
  empty?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const grid = columns.map((c) => c.width).join(' ');
  const interactive = !!onOpen;
  const cellRole = interactive ? 'gridcell' : 'cell';
  return (
    <div role={interactive ? 'grid' : 'table'} aria-label={caption} aria-rowcount={rows.length + 1} className="wr-table">
      <div role="rowgroup" className="wr-table__head">
        <div role="row" className="wr-table__row wr-table__row--head" style={{ gridTemplateColumns: grid }}>
          {columns.map((c) => (
            <span key={c.key} role="columnheader" className={c.align === 'right' ? 'is-right' : undefined}>{c.header}</span>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        {rows.length === 0 && empty && (
          <div role="row" className="wr-table__empty">
            <span role={cellRole} aria-colspan={columns.length}>{empty}</span>
          </div>
        )}
        {rows.map((r) => {
          const k = rowKey(r);
          return (
            <div
              key={k}
              role="row"
              tabIndex={onOpen ? 0 : undefined}
              aria-selected={interactive && selectedKey !== undefined ? selectedKey === k : undefined}
              className={`wr-table__row${onOpen ? ' is-link' : ''}${selectedKey === k ? ' is-selected' : ''}`}
              style={{ gridTemplateColumns: grid, height: rowHeight }}
              onClick={onOpen ? () => onOpen(r) : undefined}
              onKeyDown={onOpen ? (e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r); }
              } : undefined}
            >
              {columns.map((c) => (
                <span key={c.key} role={cellRole} className={`${c.align === 'right' ? 'is-right' : ''}${c.numeric ? ' is-num' : ''}`.trim() || undefined}>
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
