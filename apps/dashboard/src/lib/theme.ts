'use client';

import { safeGet, safeSet } from '@/lib/safe-storage';

// Theme choice, stored in wr_theme and mirrored on <html data-wr-theme>.
// Dark is the default when nothing is stored. 'light' and 'dark' are also
// pinned with data-theme on .wr-shell; 'system' follows the OS through the
// prefers-color-scheme block in globals.css.
export type ThemeChoice = 'system' | 'light' | 'dark';

export function storedTheme(): ThemeChoice {
  const t = safeGet('wr_theme');
  return t === 'light' || t === 'system' ? t : 'dark';
}

export function applyTheme(theme: ThemeChoice, shell: Element | null = document.querySelector('.wr-shell')) {
  if (!shell) return;
  if (theme === 'system') shell.removeAttribute('data-theme');
  else shell.setAttribute('data-theme', theme);
}

export function chooseTheme(theme: ThemeChoice) {
  safeSet('wr_theme', theme);
  // <html data-wr-theme> is set before paint by app/layout.tsx; keep it in
  // step so the choice takes effect without a reload.
  document.documentElement.setAttribute('data-wr-theme', theme);
  applyTheme(theme);
}
