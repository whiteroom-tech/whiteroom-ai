import { safeGet, safeSet } from '@/lib/safe-storage';

// Text size, stored in wr_text and mirrored on <html data-wr-text> (set before
// first paint by app/layout.tsx). Every font size is a rem token in
// globals.css, so changing the root size scales all text and the layout
// reflows with it. Default is the 100% scale and stores nothing.
export type TextSize = 'md' | 'lg' | 'xl';

export const TEXT_SIZES: { value: TextSize; label: string }[] = [
  { value: 'md', label: 'Default' },
  { value: 'lg', label: 'Large' },
  { value: 'xl', label: 'Larger' },
];

export function parseTextSize(v: string | null): TextSize {
  return v === 'lg' || v === 'xl' ? v : 'md';
}

export function storedTextSize(): TextSize {
  return parseTextSize(safeGet('wr_text'));
}

export function applyTextSize(size: TextSize, root: Element | null = typeof document === 'undefined' ? null : document.documentElement) {
  if (!root) return;
  if (size === 'md') root.removeAttribute('data-wr-text');
  else root.setAttribute('data-wr-text', size);
}

export function chooseTextSize(size: TextSize) {
  safeSet('wr_text', size);
  applyTextSize(size);
}
