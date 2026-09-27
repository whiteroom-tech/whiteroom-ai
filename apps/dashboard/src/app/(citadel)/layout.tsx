'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { safeGet } from '@/lib/safe-storage';

export default function CitadelLayout({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const stored = safeGet('wr_theme');
    if (stored === 'light' || stored === 'dark') {
      document.querySelector('.wr-shell')?.setAttribute('data-theme', stored);
    }
  }, []);

  return (
    <div
      className={`wr-shell citadel-layout${menuOpen ? " navigation-open" : ""}`}
      style={{
        background: 'var(--bg)',
        color: 'var(--tx)',
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 14.5,
        display: 'grid',
        gridTemplateColumns: '212px 1fr',
        gridTemplateRows: 'minmax(0, 1fr)',
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      <Sidebar />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <button className="citadel-mobile-menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}</svg>
          {menuOpen ? 'Close menu' : 'Menu'}
        </button>
        {children}
      </div>
    </div>
  );
}
