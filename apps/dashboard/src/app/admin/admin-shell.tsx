'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from '@/components/ThemeToggle';
import { FONT_DISPLAY } from '@whiteroom/ui';

/**
 * Chrome for the admin section.
 *
 * Deliberately does NOT reuse @/components/Sidebar. Two reasons, and both
 * matter:
 *
 *   1. On the admin host every non-admin route 404s (see proxy.ts), so the
 *      app's nav would be a column of dead links.
 *   2. Sidebar ships in the bundle of every customer-facing page. Anything
 *      admin-shaped living in it — a label, an icon, a href — is readable by
 *      any user who opens the JS, which is the disclosure this whole split
 *      exists to close.
 *
 * The two components staying separate is the feature, not duplication to be
 * tidied away later.
 */
/** Sections of the panel, in the order they are drawn. */
const NAV = [
  {
    href: '/admin',
    label: 'Users',
    icon: (
      <>
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </>
    ),
  },
  {
    href: '/admin/organizations',
    label: 'Organizations',
    icon: (
      <>
        <path d="M3 21h18M5 21V7l7-4 7 4v14" />
        <path d="M9 21v-4h6v4M9 10h.01M15 10h.01M9 14h.01M15 14h.01" />
      </>
    ),
  },
];

/**
 * Which nav item to light up. Most specific match wins: /admin prefixes every
 * admin route, so matching per item would light Users up on every page.
 */
function activeHref(pathname: string): string | undefined {
  return NAV.filter((item) => pathname === item.href || pathname.startsWith(item.href + '/'))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function AdminShell({
  title,
  breadcrumb,
  children,
}: {
  title: string;
  breadcrumb?: { href: string; label: string };
  children: React.ReactNode;
}) {
  const current = activeHref(usePathname());

  useEffect(() => {
    const stored = localStorage.getItem('wr_theme');
    if (stored === 'light' || stored === 'dark') {
      document.querySelector('.wr-shell')?.setAttribute('data-theme', stored);
    }
  }, []);

  return (
    <div className="wr-shell" style={{ display: 'flex', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <aside
        style={{
          width: 212,
          flexShrink: 0,
          borderRight: '1px solid var(--line)',
          padding: '16px 11px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          background: 'var(--card)',
        }}
      >
        <div className="flex items-center gap-2.5" style={{ padding: '5px 10px 18px' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--ho)', boxShadow: '0 0 9px var(--ho)' }} />
          <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 15, letterSpacing: 2.5, color: 'var(--tx)', whiteSpace: 'nowrap' }}>
            WR ADMIN
          </span>
        </div>

        {NAV.map((item) => {
          const active = item.href === current;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className="flex items-center gap-2.5"
              style={{
                padding: '8px 10px', borderRadius: 7, fontSize: 14, fontWeight: 600,
                textDecoration: 'none',
                background: active ? 'var(--ho-bg)' : 'transparent',
                color: active ? 'var(--ho)' : 'var(--tx2)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {item.icon}
              </svg>
              <span>{item.label}</span>
            </Link>
          );
        })}

        <div style={{ marginTop: 'auto', padding: '11px 10px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--tx3)' }}>
          Internal tools
        </div>
      </aside>

      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)', color: 'var(--tx)' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '26px 24px 80px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              {breadcrumb && (
                <>
                  <Link href={breadcrumb.href} style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' }}>
                    {breadcrumb.label}
                  </Link>
                  <span style={{ color: 'var(--tx3)' }}>/</span>
                </>
              )}
              <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {title}
              </h1>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
                  padding: '3px 9px', borderRadius: 99,
                  background: 'var(--ho-bg)', color: 'var(--ho)', border: '1px solid var(--ho)',
                }}
              >
                Internal
              </span>
              <ThemeToggle />
            </div>
          </div>
          <p style={{ fontSize: 13, color: 'var(--tx3)', margin: '0 0 22px' }}>
            Everything you change here is written to the admin audit log.
          </p>
          {children}
        </div>
      </main>
    </div>
  );
}
