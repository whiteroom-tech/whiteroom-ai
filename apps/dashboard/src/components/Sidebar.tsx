'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Logo, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import { myOrganizationSummary } from '@/lib/organization-actions';
import { safeGet } from '@/lib/safe-storage';
import { ROUTES } from '@/lib/routes';
import { APP_VERSION } from '@/components/citadel/PageChrome';
import { AccountMenu } from '@/components/AccountMenu';

// 24-unit line icons, stroke 2 (README › Global shell › Icons).
const ICON_PATHS = {
  home: 'M3 11l9-8 9 8v10a1 1 0 01-1 1h-5v-7h-6v7H4a1 1 0 01-1-1z',
  runs: 'M4 6h16M4 12h16M4 18h10',
  performance: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  controls: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  sandbox: 'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.3 7l8.7 5 8.7-5M12 22V12',
  fleetKey: 'M15 7a4 4 0 11-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0115 7zM16 10h.01',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
};

type NavKey = keyof typeof ICON_PATHS;

interface NavItem {
  key: NavKey;
  href: string;
  label: string;
  /** Native tooltip in plain words (README › Labels and hover help). */
  tip: string;
  /** Extra paths that count as this page, e.g. old routes. */
  also?: string[];
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Monitor',
    items: [
      { key: 'home', href: ROUTES.home, label: 'Home', tip: 'Does anything need you, and what is the fleet doing right now', also: ['/fleet'] },
      { key: 'runs', href: ROUTES.runs, label: 'Runs', tip: 'Every stretch of work by every agent, and what happened in it' },
      { key: 'performance', href: ROUTES.performance, label: 'Performance', tip: 'Cost, savings, errors and unusual behaviour over time' },
    ],
  },
  {
    group: 'Govern',
    items: [
      { key: 'controls', href: ROUTES.controls, label: 'Controls', tip: 'Rules that watch your agents and step in when you want them to' },
    ],
  },
  {
    group: 'Setup',
    items: [
      { key: 'sandbox', href: ROUTES.sandbox, label: 'Sandbox', tip: 'Try an agent on a test task before it touches real work' },
      { key: 'fleetKey', href: ROUTES.fleetKey, label: 'Fleet key', tip: 'Your API key and proxy address, needed to connect an agent' },
      { key: 'settings', href: ROUTES.settings, label: 'Settings', tip: 'Profile, plan, alerts and sign-in' },
    ],
  },
];

const isUnder = (path: string, href: string) => path === href || path.startsWith(href + '/');

function NavIcon({ name }: { name: NavKey }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();

  const [fleetId, setFleetId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setFleetId(safeGet('wr_fleet'));
    read();
    window.addEventListener('storage', read);
    window.addEventListener('focus', read);
    return () => { window.removeEventListener('storage', read); window.removeEventListener('focus', read); };
  }, []);

  // Re-read on navigation so accepting or leaving an organization updates the
  // account menu without a reload.
  const [org, setOrg] = useState<Awaited<ReturnType<typeof myOrganizationSummary>>>(null);
  useEffect(() => {
    let live = true;
    myOrganizationSummary().then((s) => { if (live) setOrg(s); }).catch(() => {});
    return () => { live = false; };
  }, [pathname]);

  // Fleet-key sessions have no user account, so the row names the fleet.
  const person = session?.user?.name || session?.user?.email || 'Fleet key session';
  const role = org?.role ? ROLE_LABEL[org.role] ?? org.role : null;

  return (
    <aside className="wr-sidebar" aria-label="Main">
      <div className="wr-sidebar__brand">
        <Logo width={22} height={30} gradientId="wr-sidebar-mark" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 700, letterSpacing: '.02em', lineHeight: 1.1, color: 'var(--tx)' }}>WhiteRoom</div>
          {fleetId && (
            <div title={fleetId} style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: 'var(--tx2)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fleetId}</div>
          )}
        </div>
      </div>

      <nav aria-label="Pages" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map(({ group, items }) => (
          <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div className="wr-sidebar__eyebrow">{group}</div>
            {items.map((item) => {
              const active = isUnder(pathname, item.href) || (item.also ?? []).some((p) => isUnder(pathname, p));
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  title={item.tip}
                  aria-current={active ? 'page' : undefined}
                  className={`wr-sidebar__item${active ? ' is-active' : ''}`}
                >
                  <NavIcon name={item.key} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="wr-sidebar__account">
        <span aria-hidden="true" className="wr-sidebar__avatar">{person.charAt(0).toUpperCase()}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person}</div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10.5, color: 'var(--tx2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{role ? `${role} · ${APP_VERSION}` : APP_VERSION}</div>
        </div>
        <AccountMenu organization={org ? org.name ?? '' : null} invitations={org?.invitations ?? 0} />
      </div>
    </aside>
  );
}
