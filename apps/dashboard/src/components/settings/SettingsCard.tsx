/**
 * One card on Settings, Fleet key and Sandbox, as in the mockup: a 19px
 * title with an optional sub-line and right-hand action in the header, a
 * rule under it, then the body. `tone="danger"` is Delete account's red card.
 */
export function SettingsCard({ id, title, sub, right, tone = 'default', children }: {
  /** The heading's id stem; the section is labelled by it. */
  id: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  tone?: 'default' | 'danger';
  children?: React.ReactNode;
}) {
  return (
    <section className={`wr-panel wr-scard${tone === 'danger' ? ' wr-scard--danger' : ''}`} aria-labelledby={`${id}-title`}>
      <div className="wr-scard__head">
        <div style={{ minWidth: 0 }}>
          <h2 id={`${id}-title`} className="wr-panel__title wr-scard__title">{title}</h2>
          {sub && <p className="wr-scard__sub">{sub}</p>}
        </div>
        {right && <div className="wr-scard__right">{right}</div>}
      </div>
      {children != null && <div className="wr-scard__body">{children}</div>}
    </section>
  );
}
