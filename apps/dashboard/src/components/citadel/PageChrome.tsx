'use client';

// Shared header and footer for every Citadel page. Each page used to draw its
// own top bar, so titles, badges and sign-out drifted apart page to page.

import { ThemeToggle } from '@/components/ThemeToggle';
import { FONT_MONO } from '@whiteroom/ui';

export const APP_VERSION = 'v1.1 Beta';

export function SignOutButton() {
  return (
    <button
      onClick={() => { window.location.href = '/auth/sign-out'; }}
      style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx2)', border: '1px solid var(--line2)', borderRadius: 6, padding: '6px 12px', background: 'var(--card)', cursor: 'pointer', whiteSpace: 'nowrap' }}
    >
      Sign out
    </button>
  );
}

export function PageHeader({
  title,
  fleetId,
  badge,
  children,
}: {
  /** Page name. A node so Performance can render its drill-down breadcrumb. */
  title: React.ReactNode;
  /** Shown as secondary context next to the title. */
  fleetId?: string | null;
  /** Optional status pill, e.g. the Sandbox run mode. */
  badge?: React.ReactNode;
  /** Page-level controls, placed before the theme toggle. */
  children?: React.ReactNode;
}) {
  return (
    <header className="citadel-page-header flex items-center gap-3" style={{ height: 54, flexShrink: 0, borderBottom: '1px solid var(--line)', padding: '0 20px', minWidth: 0 }}>
      <h1 style={{ fontSize: 14, fontWeight: 600, color: 'var(--tx)', margin: 0, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {title}
      </h1>
      {fleetId && (
        <span className="citadel-page-fleet" title="Fleet ID" style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          / {fleetId}
        </span>
      )}
      {badge}
      <span style={{ marginLeft: 'auto' }} />
      {children}
      <ThemeToggle />
      <SignOutButton />
    </header>
  );
}

export function PageFooter({ note }: { note?: React.ReactNode }) {
  return (
    <footer className="citadel-page-footer flex justify-between gap-4" style={{ padding: '6px 20px', borderTop: '1px solid var(--line)', background: 'var(--sunk)', fontSize: 11.5, color: 'var(--tx3)', flexShrink: 0 }}>
      <span>{note}</span>
      <span style={{ whiteSpace: 'nowrap' }}>© 2026 WhiteRoom</span>
    </footer>
  );
}
