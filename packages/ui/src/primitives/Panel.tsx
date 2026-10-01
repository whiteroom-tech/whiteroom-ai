// Panel: card surface, 1px line border, radius 14. The optional header holds
// a title, a count and a right-aligned slot for controls (README › Shared components).
export function Panel({ title, count, actions, children, bodyPadding = '16px 18px', id, className = '' }: {
  title?: React.ReactNode;
  count?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /** Pass 0 for lists and tables that draw their own row padding. */
  bodyPadding?: string | number;
  id?: string;
  className?: string;
}) {
  return (
    <section id={id} className={`wr-panel ${className}`.trim()}>
      {(title || actions || count != null) && (
        <div className="wr-panel__head">
          {title && <h2 className="wr-panel__title">{title}</h2>}
          {count != null && <span className="wr-panel__count">{count}</span>}
          {actions && <div className="wr-panel__actions">{actions}</div>}
        </div>
      )}
      {children != null && <div style={{ padding: bodyPadding }}>{children}</div>}
    </section>
  );
}
