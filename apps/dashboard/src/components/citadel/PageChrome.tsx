'use client';

// The shared page header for every signed-in page (README › Header patterns),
// and the pieces pages build their heads from. Theme, text size and sign out
// sit in the sidebar (SidebarPreferences); the version is on its account row.

import { FONT_DISPLAY, Icon } from '@whiteroom/ui';
import { fmtTime } from '@/lib/format';

export const APP_VERSION = 'v1.1 Beta';

export function PageHeader({
  title,
  fleetId,
  fleetTitle = 'Fleet ID',
  badge,
  split = false,
  children,
}: {
  /** Page name, or a breadcrumb on detail pages. */
  title: React.ReactNode;
  /** Shown after the title as "/ fleet-id". */
  fleetId?: string | null;
  /** Tooltip for that context; Settings shows the account email there. */
  fleetTitle?: string;
  /** Live status or a status pill, after the fleet id. */
  badge?: React.ReactNode;
  /**
   * Split 2:1 like a page with a side column (Controls), so the actions end
   * where the main column ends. The side part stays empty.
   */
  split?: boolean;
  /** Page-level actions, right-aligned. At most two buttons. */
  children?: React.ReactNode;
}) {
  const content = (
    <>
      {/* The title keeps its width (only the fleet ID yields); a very long agent name wraps instead of overlapping. */}
      <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 'var(--fs-page)', lineHeight: 1.25, fontWeight: 600, color: 'var(--tx)', margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flexShrink: 0, maxWidth: '60%', overflowWrap: 'anywhere' }}>
        {title}
      </h1>
      {fleetId && (
        <span className="citadel-page-fleet" title={fleetTitle} style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          / {fleetId}
        </span>
      )}
      {badge}
      {/* One group, so on a narrow screen the actions wrap together rather than one by one. */}
      <div className="citadel-page-actions" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: split ? 8 : 12 }}>{children}</div>
    </>
  );
  return (
    <header
      className={split ? 'citadel-page-header citadel-page-header--split' : 'citadel-page-header'}
      style={{ minHeight: '4.5rem', flexShrink: 0, display: 'flex', borderBottom: '1px solid var(--line)', minWidth: 0, ...(split ? { alignItems: 'stretch' } : { alignItems: 'center', gap: 12, padding: '0 24px' }) }}
    >
      {split ? <><div className="citadel-page-header__main">{content}</div><div className="citadel-page-header__side" aria-hidden="true" /></> : content}
    </header>
  );
}

/**
 * The header's freshness: "● Live · updated 11:08", "Retrying · last updated
 * 11:08" while reads fail, or "Waiting for the first call" for a new fleet.
 */
export function LiveStatus({ at, failing = false, empty = false }: { at: number | null; failing?: boolean; empty?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>
      {failing
        ? <><span style={{ color: 'var(--warn)', display: 'flex' }}><Icon name="alertCircle" size={12} /></span>Retrying{at ? ` · last updated ${fmtTime(at)}` : ''}</>
        : empty
          ? <><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid var(--tx2)' }} />Waiting for the first call</>
          : <><span className="wr-dot wr-dot--ok" style={{ width: 7, height: 7 }} />Live{at ? ` · updated ${fmtTime(at)}` : ''}</>}
    </span>
  );
}

/**
 * A page section's heading: a 26px title, a sub-line saying what the section
 * is for, and an optional note on the right ("last 7 days", a link).
 */
export function SectionHeader({ id, title, sub, meta }: { id?: string; title: React.ReactNode; sub?: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <div className="wr-section-head">
      <div style={{ minWidth: 0 }}>
        <h2 id={id} className="wr-section-head__title">{title}</h2>
        {sub && <p className="wr-section-head__sub">{sub}</p>}
      </div>
      {meta && <div className="wr-section-head__meta">{meta}</div>}
    </div>
  );
}

/** One plain sentence under the page header saying what the page is for. */
export function PageLead({ children }: { children: React.ReactNode }) {
  return <p className="wr-page-lead">{children}</p>;
}
