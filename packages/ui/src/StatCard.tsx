import { color, FONT_DISPLAY, FONT_MONO } from './theme';
import { Hint } from './primitives/Hint';

/**
 * A labelled figure.
 * - `tile` (default): the small inner tile on the onboarding fleet-status panel.
 * - `card`: the redesign's stat card (README › Shared components): label with
 *   an optional ⓘ, a 28px value and a mono sub-caption that can be a link.
 */
export function StatCard({ label, value, variant = 'tile', hint, suffix, sub, subHref }: {
  label: string;
  value: React.ReactNode;
  variant?: 'tile' | 'card';
  /** Plain-language definition behind the ⓘ. */
  hint?: string;
  /** Muted tail after the value, e.g. "/ 4" in "2 / 4". */
  suffix?: React.ReactNode;
  sub?: React.ReactNode;
  /** Turns the sub-caption into a link, e.g. "up to $2.17 saved →". */
  subHref?: string;
}) {
  if (variant === 'tile') {
    return (
      <div className="rounded-lg p-4" style={{ background: color.sunk, border: `1px solid ${color.line}` }}>
        <p className="text-[11px] font-mono tracking-[.12em] uppercase" style={{ color: color.tx2 }}>{label}</p>
        <p className="text-2xl font-display font-bold mt-1" style={{ color: color.tx }}>{value}</p>
      </div>
    );
  }
  const subStyle: React.CSSProperties = { display: 'block', fontFamily: FONT_MONO, fontSize: 11, marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  return (
    <div style={{ background: color.card, border: `1px solid ${color.line}`, borderRadius: 14, padding: '16px 18px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 12.5, fontWeight: 500, color: color.tx2 }}>
        {label}{hint && <Hint text={hint} />}
      </div>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 28, fontWeight: 700, lineHeight: 1.1, marginTop: 4, color: color.tx, fontVariantNumeric: 'tabular-nums' }}>
        {value}{suffix != null && <span style={{ color: color.tx2, fontWeight: 600 }}> {suffix}</span>}
      </div>
      {sub != null && (subHref
        ? <a href={subHref} className="wr-stat-link" style={{ ...subStyle, color: color.brand, textDecoration: 'none' }}>{sub}</a>
        : <span style={{ ...subStyle, color: color.tx2 }}>{sub}</span>)}
    </div>
  );
}
