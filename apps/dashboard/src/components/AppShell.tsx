'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { PhoneTabBar } from '@/components/PhoneTabBar';
import { applyTheme, storedTheme } from '@/lib/theme';

/**
 * The one layout for every signed-in page (README › Global shell): a 248px
 * sidebar and the page column. Pages draw their own header with PageHeader.
 * Below 720px the sidebar gives way to a bottom tab bar; its More opens the
 * sidebar over the page (globals.css).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useEffect(() => { applyTheme(storedTheme(), shell.current); }, []);
  // Going to a page closes the menu; so does Escape.
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div ref={shell} className={`wr-shell wr-shell--tabs citadel-layout${menuOpen ? ' navigation-open' : ''}`}>
      <Sidebar />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {children}
      </div>
      {menuOpen && <div className="wr-menu-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
      <PhoneTabBar menuOpen={menuOpen} onMore={() => setMenuOpen((v) => !v)} />
    </div>
  );
}
