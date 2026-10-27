'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { PhoneTabBar } from '@/components/PhoneTabBar';
import { AccountClosingBanner } from '@/components/AccountClosingBanner';
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
  // Going to a page closes the menu (as does any link in it, even to this
  // page); Escape and the scrim close it and return focus to More. While it's
  // open, focus starts in it and the page behind is inert.
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  // Widening past the phone layout (a rotated tablet, a resized window) hides
  // the tab bar and scrim, so the menu closes too, and nothing stays inert.
  useEffect(() => {
    const wide = window.matchMedia?.('(min-width: 721px)');
    if (!wide) return;
    const onChange = () => { if (wide.matches) setMenuOpen(false); };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, []);
  const more = () => shell.current?.querySelector<HTMLButtonElement>('.wr-tabbar [aria-controls="wr-main-nav"]');
  const closeMenu = () => { setMenuOpen(false); more()?.focus(); };
  useEffect(() => {
    if (!menuOpen) return;
    shell.current?.querySelector<HTMLElement>('#wr-main-nav a, #wr-main-nav button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    const nav = shell.current?.querySelector('#wr-main-nav');
    const onLink = (e: Event) => { if ((e.target as Element).closest('a')) setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    nav?.addEventListener('click', onLink);
    return () => { window.removeEventListener('keydown', onKey); nav?.removeEventListener('click', onLink); };
  }, [menuOpen]);

  return (
    <div ref={shell} className={`wr-shell wr-shell--tabs citadel-layout${menuOpen ? ' navigation-open' : ''}`}>
      <Sidebar />
      <div inert={menuOpen} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <AccountClosingBanner />
        {children}
      </div>
      {menuOpen && <div className="wr-menu-scrim" aria-hidden="true" onClick={closeMenu} />}
      <PhoneTabBar menuOpen={menuOpen} onMore={() => setMenuOpen((v) => !v)} />
    </div>
  );
}
