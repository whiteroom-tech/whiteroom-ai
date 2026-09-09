'use client';

import { useState, useEffect } from 'react';

type WrTheme = 'system' | 'light' | 'dark';

function applyTheme(theme: WrTheme) {
  const shell = document.querySelector('.wr-shell');
  if (!shell) return;
  if (theme === 'system') shell.removeAttribute('data-theme');
  else shell.setAttribute('data-theme', theme);
}

const THEME_ICON: Record<WrTheme, React.ReactNode> = {
  system: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>,
  light: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>,
  dark: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>,
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<WrTheme>('system');

  useEffect(() => {
    const stored = localStorage.getItem('wr_theme') as WrTheme | null;
    if (stored && (stored === 'light' || stored === 'dark')) {
      setTheme(stored);
      applyTheme(stored);
    }
  }, []);

  function cycleTheme() {
    const order: WrTheme[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
    if (next === 'system') localStorage.removeItem('wr_theme');
    else localStorage.setItem('wr_theme', next);
    applyTheme(next);
  }

  return (
    <button
      onClick={cycleTheme}
      title={`Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}`}
      style={{ background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 5, padding: '3px 7px', cursor: 'pointer', color: 'var(--tx3)', lineHeight: 1, display: 'flex', alignItems: 'center', gap: 4 }}
    >
      {THEME_ICON[theme]}
    </button>
  );
}
