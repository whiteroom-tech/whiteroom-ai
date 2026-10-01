'use client';

import { useEffect, useRef, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { applyTheme, storedTheme } from '@/lib/theme';

/**
 * The one layout for every signed-in page (README › Global shell): a 220px
 * sidebar and the page column. Pages draw their own header with PageHeader.
 * Below 720px the sidebar folds into a menu button (globals.css).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => { applyTheme(storedTheme(), shell.current); }, []);

  return (
    <div ref={shell} className={`wr-shell citadel-layout${menuOpen ? ' navigation-open' : ''}`}>
      <Sidebar />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <button type="button" className="citadel-mobile-menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}</svg>
          {menuOpen ? 'Close menu' : 'Menu'}
        </button>
        {children}
      </div>
    </div>
  );
}
