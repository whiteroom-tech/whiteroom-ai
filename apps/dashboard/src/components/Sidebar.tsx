'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Logo, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';
import { myOrganizationSummary } from '@/lib/organization-actions';
import { safeGet } from '@/lib/safe-storage';
import { isNavActive } from '@/lib/routes';
import { NAV, NavIcon } from '@/components/nav-items';
import { APP_VERSION } from '@/components/citadel/PageChrome';
import { AccountMenu } from '@/components/AccountMenu';

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
    <aside id="wr-main-nav" className="wr-sidebar" aria-label="Main">
      <div className="wr-sidebar__brand">
        <Logo width={22} height={30} gradientId="wr-sidebar-mark" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 700, letterSpacing: '.02em', lineHeight: 1.1, color: 'var(--tx)' }}>WhiteRoom</div>
          {fleetId && (
            <div title={fleetId} style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fleetId}</div>
          )}
        </div>
      </div>

      <nav aria-label="Pages" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map(({ group, items }) => (
          <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div className="wr-sidebar__eyebrow">{group}</div>
            {items.map((item) => {
              const active = isNavActive(pathname, item.href, item.also);
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
          <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person}</div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{role ? `${role} · ${APP_VERSION}` : APP_VERSION}</div>
        </div>
        <AccountMenu organization={org ? org.name ?? '' : null} invitations={org?.invitations ?? 0} />
      </div>
    </aside>
  );
}
