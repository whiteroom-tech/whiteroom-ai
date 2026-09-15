'use client';

import { useEffect } from 'react';
import { Sidebar } from '@/components/Sidebar';

export default function CitadelLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const stored = localStorage.getItem('wr_theme');
    if (stored === 'light' || stored === 'dark') {
      document.querySelector('.wr-shell')?.setAttribute('data-theme', stored);
    }
  }, []);

  return (
    <div
      className="wr-shell"
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
        {children}
      </div>
    </div>
  );
}
