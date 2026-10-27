'use client';

// The shared page header for every signed-in page (README › Header patterns).
// Theme and sign out moved to the account menu in the sidebar, and the footer
// is gone; the version now sits on the sidebar's account row.

import { FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

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
      <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 'var(--fs-page)', lineHeight: 1.2, fontWeight: 700, color: 'var(--tx)', margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flexShrink: 0, maxWidth: '60%', overflowWrap: 'anywhere' }}>
        {title}
      </h1>
      {fleetId && (
        <span className="citadel-page-fleet" title={fleetTitle} style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
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
