import { safeGet, safeSet } from '@/lib/safe-storage';

// Text size, stored in wr_text and mirrored on <html data-wr-text> (set before
// first paint by app/layout.tsx). Every font size is a rem token in
// globals.css, so changing the root size scales all text and the layout
// reflows with it. Default is the 100% scale and sets no attribute.
export type TextSize = 'md' | 'lg' | 'xl';

export const TEXT_SIZES: { value: TextSize; label: string }[] = [
  { value: 'md', label: 'Default' },
  { value: 'lg', label: 'Large' },
  { value: 'xl', label: 'Larger' },
];

/** The sidebar's compact labels; each keeps its full name for screen readers. */
export const TEXT_SIZE_SHORT: Record<TextSize, string> = { md: 'A', lg: 'A+', xl: 'A++' };

/** Fired on window when the size changes, so every control on the page shows it. */
export const TEXT_SIZE_CHANGED = 'wr:text-size-changed';

/**
 * Runs inline in <head> before first paint (app/layout.tsx). Plain ES5 so it
 * can be inlined as a string; applies the same rule as parseTextSize.
 */
export const TEXT_SIZE_BOOT = "var s=localStorage.getItem('wr_text');if(s==='lg'||s==='xl')document.documentElement.setAttribute('data-wr-text',s);";

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
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TEXT_SIZE_CHANGED));
}
