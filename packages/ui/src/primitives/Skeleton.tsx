import type { CSSProperties, ReactNode } from 'react';

/**
 * A grey block at the size the real content will take, shown while it loads
 * (no spinner). Use it for first loads; say "Retrying…" beside it when a load
 * keeps failing.
 */
export function Skeleton({ width = '100%', height = 12, radius = 5, style }: {
  width?: string | number;
  height?: number;
  radius?: number;
  style?: CSSProperties;
}) {
  return <div aria-hidden="true" style={{ width, height, borderRadius: radius, background: 'var(--sunk)', ...style }} />;
}

/**
 * A card-shaped loading placeholder: the house card (card background,
 * hairline border, 14px radius) holding either skeleton lines or nothing.
 * Give it `lines` (padded rows of placeholder text) or `height` (an empty
 * block that size, for a chart or table); with `height`, `lines` is ignored.
 * `label` is what a screen reader hears ("Checking for an existing test…");
 * it isn't shown.
 */
export function SkeletonCard({ label, lines = ['55%', '40%', '65%'], heights = [12, 28, 10], height, children, style }: {
  /** Screen-reader text; makes the card a busy status. */
  label?: string;
  /** Widths of the placeholder lines. Ignored when `height` is set. */
  lines?: (string | number)[];
  /** Each line's height in px, by position (repeats when shorter than `lines`). Ignored when `height` is set. */
  heights?: number[];
  /** An empty card this tall, instead of lines. */
  height?: number;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      role={label ? 'status' : undefined}
      aria-busy={label ? true : undefined}
      style={{ position: 'relative', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: height ? undefined : '16px 18px', height, display: 'grid', gap: 8, alignContent: 'start', ...style }}
    >
      {label && <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{label}</span>}
      {!height && lines.map((w, i) => <Skeleton key={i} width={w} height={heights[i % heights.length]} />)}
      {children}
    </div>
  );
}
