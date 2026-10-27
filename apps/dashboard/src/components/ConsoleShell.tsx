'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Logo, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import { ROUTES, isNavActive } from '@/lib/routes';
import { ROLE_LABELS, type OrgRole } from '@/lib/org-roles';
import { applyTheme, storedTheme } from '@/lib/theme';
import { AccountMenu } from '@/components/AccountMenu';

/**
 * Chrome for the enterprise console (console.whiteroom.tech).
 *
 * Separate from AppShell on purpose: the fleet sidebar (Home, Runs, Fleet key)
 * is the personal workspace, and those routes 404 on this host.
 */

export function ConsoleShell({
  children,
  orgName,
  role,
  invitations = 0,
}: {
  children: React.ReactNode;
  orgName: string | null;
  role: OrgRole | null;
  invitations?: number;
}) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const shell = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { applyTheme(storedTheme(), shell.current); }, []);

  const person = session?.user?.name || session?.user?.email || 'Signed in';
  const roleLabel = role ? ROLE_LABELS[role] : null;
  const active = isNavActive(pathname, ROUTES.organization);

  return (
    <div ref={shell} className={`wr-shell citadel-layout${menuOpen ? ' navigation-open' : ''}`}>
      <aside className="wr-sidebar" aria-label="Organization">
        <div className="wr-sidebar__brand">
          <Logo width={22} height={30} gradientId="wr-console-mark" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 'var(--fs-md)', fontWeight: 700, letterSpacing: '.02em', lineHeight: 1.1, color: 'var(--tx)' }}>
              WhiteRoom
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx2)', marginTop: 4 }}>Organization</div>
          </div>
        </div>

        <nav aria-label="Console" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="wr-sidebar__eyebrow">{orgName || 'Company'}</div>
          <Link
            href={ROUTES.organization}
            aria-current={active ? 'page' : undefined}
            className={`wr-sidebar__item${active ? ' is-active' : ''}`}
          >
            <span>Overview</span>
          </Link>
        </nav>

        <div className="wr-sidebar__account">
          <span aria-hidden="true" className="wr-sidebar__avatar">{person.charAt(0).toUpperCase()}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person}</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {roleLabel ?? 'Console'}
            </div>
          </div>
          <AccountMenu organization={orgName} invitations={invitations} />
        </div>
      </aside>

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <button type="button" className="citadel-mobile-menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
          {menuOpen ? 'Close menu' : 'Menu'}
        </button>
        {children}
      </div>
    </div>
  );
}
