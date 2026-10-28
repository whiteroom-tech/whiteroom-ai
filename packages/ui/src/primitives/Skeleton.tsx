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
 * A card-shaped loading placeholder: skeleton lines inside the house card
 * (card background, hairline border, 14px radius). `label` is what a screen
 * reader hears ("Checking for an existing test…"); it isn't shown. With no
 * `lines`, the card is an empty block of `height`.
 */
export function SkeletonCard({ label, lines = ['55%', '40%', '65%'], height, children, style }: {
  label?: string;
  lines?: (string | number)[];
  height?: number;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  const heights = [12, 28, 10];
  return (
    <div
      role={label ? 'status' : undefined}
      aria-busy={label ? true : undefined}
      style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: height ? undefined : '16px 18px', height, display: 'grid', gap: 8, alignContent: 'start', ...style }}
    >
      {label && <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{label}</span>}
      {!height && lines.map((w, i) => <Skeleton key={i} width={w} height={heights[i % heights.length]} />)}
      {children}
    </div>
  );
}
