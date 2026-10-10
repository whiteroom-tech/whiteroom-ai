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
  /** Page-level actions, right-aligned. At most two buttons. */
  children?: React.ReactNode;
}) {
  return (
    <header className="citadel-page-header" style={{ height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--line)', padding: '0 24px', minWidth: 0 }}>
      <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, color: 'var(--tx)', margin: 0, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, whiteSpace: 'nowrap' }}>
        {title}
      </h1>
      {fleetId && (
        <span className="citadel-page-fleet" title={fleetTitle} style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          / {fleetId}
        </span>
      )}
      {badge}
      {/* One group, so on a narrow screen the actions wrap together rather than one by one. */}
      <div className="citadel-page-actions" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>{children}</div>
    </header>
  );
}
