// Shared typography tokens. Matches the fonts loaded in app/layout.tsx.
export const FONT_DISPLAY = "'Chakra Petch', sans-serif";
export const FONT_MONO = "'JetBrains Mono', monospace";

// Color tokens from the redesign handoff (README › Design tokens). Values live
// in the dashboard's app/globals.css under .wr-shell, per theme; components
// reference them through these names instead of writing var() strings or raw
// colors by hand.
export const COLOR_TOKENS = [
  'bg', 'card', 'sunk', 'raised', 'line', 'line2', 'track',
  'tx', 'tx2', 'brand', 'brand-dim', 'on-brand',
  'ok', 'warn', 'warn-bg', 'warn-line', 'bad', 'bad-dim', 'ho', 'overlay',
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

/** `color.brand` is `'var(--brand)'`, for inline styles. */
export const color = {
  bg: 'var(--bg)',
  card: 'var(--card)',
  sunk: 'var(--sunk)',
  raised: 'var(--raised)',
  line: 'var(--line)',
  line2: 'var(--line2)',
  track: 'var(--track)',
  tx: 'var(--tx)',
  tx2: 'var(--tx2)',
  brand: 'var(--brand)',
  brandDim: 'var(--brand-dim)',
  onBrand: 'var(--on-brand)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  warnBg: 'var(--warn-bg)',
  warnLine: 'var(--warn-line)',
  bad: 'var(--bad)',
  badDim: 'var(--bad-dim)',
  ho: 'var(--ho)',
  overlay: 'var(--overlay)',
} as const;
