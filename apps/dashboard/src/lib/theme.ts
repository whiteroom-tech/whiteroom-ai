'use client';

import { safeGet, safeRemove, safeSet } from '@/lib/safe-storage';

// Theme choice: 'system' follows the OS (no data-theme on the shell); 'light'
// and 'dark' are stored in wr_theme and pinned with data-theme on .wr-shell.
export type ThemeChoice = 'system' | 'light' | 'dark';

export function storedTheme(): ThemeChoice {
  const t = safeGet('wr_theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function applyTheme(theme: ThemeChoice, shell: Element | null = document.querySelector('.wr-shell')) {
  if (!shell) return;
  if (theme === 'system') shell.removeAttribute('data-theme');
  else shell.setAttribute('data-theme', theme);
}

export function chooseTheme(theme: ThemeChoice) {
  if (theme === 'system') safeRemove('wr_theme');
  else safeSet('wr_theme', theme);
  // <html data-wr-theme> is set before paint by app/layout.tsx; keep it in
  // step so choosing System takes effect without a reload.
  if (theme === 'system') document.documentElement.removeAttribute('data-wr-theme');
  else document.documentElement.setAttribute('data-wr-theme', theme);
  applyTheme(theme);
}
