// 24-unit line icons, stroke 2, round caps, for the primitives. Same
// metaphors as the redesign handoff (README › Assets).
const PATHS = {
  play: 'M6 4l13 8-13 8V4z',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  square: 'M5 5h14v14H5z',
  alert: 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  alertCircle: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 8v4M12 16h.01',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  chevronDown: 'M6 9l6 6 6-6',
  lock: 'M5 11h14v11H5zM7 11V7a5 5 0 0110 0v4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, strokeWidth = 2 }: { name: IconName; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flex: 'none' }}>
      <path d={PATHS[name]} />
    </svg>
  );
}
