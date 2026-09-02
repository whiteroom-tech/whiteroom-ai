'use client';

// Two "agent view" glyphs built as a meter, not decoration: the ring's fill
// and the beacon's size/glow both track a real ratio (watch or rest
// progress), and the animation is a status signal — only a `working` agent
// actively earns motion, so pulse reads as "doing something right now"
// rather than wallpaper. Static-first: every animation here is registered
// only under `prefers-reduced-motion: no-preference` (see the @keyframes in
// fleet/page.tsx's <style> block), so a reduced-motion viewer sees the same
// glyphs perfectly still.

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const clampPct = (n: number) => Math.min(100, Math.max(0, n));

/** Apple-Watch-style concentric rings: outer = watch/rest progress, inner = health.
 *  Track is the same hue at low alpha (a "lighter step of the same ramp"), so
 *  the filled arc reads as *how full* rather than a second, disconnected color. */
export function RingGauge({
  progress,
  progressColor,
  health,
  healthColor,
  animate,
  size = 72,
}: {
  progress: number;
  progressColor: string;
  health: number;
  healthColor: string;
  animate: boolean;
  size?: number;
}) {
  const outerStroke = 6;
  const innerStroke = 4;
  const gap = 3;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - outerStroke / 2 - 1;
  const innerR = outerR - outerStroke / 2 - gap - innerStroke / 2;
  const outerC = 2 * Math.PI * outerR;
  const innerC = 2 * Math.PI * innerR;
  const outerOffset = outerC * (1 - clampPct(progress) / 100);
  const innerOffset = innerC * (1 - clampPct(health) / 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ transform: 'rotate(-90deg)', animation: animate ? 'ring-glow 2.4s ease-in-out infinite' : undefined }}
    >
      <circle cx={cx} cy={cy} r={outerR} fill="none" stroke={hexToRgba(progressColor, 0.16)} strokeWidth={outerStroke} />
      <circle
        cx={cx} cy={cy} r={outerR} fill="none" stroke={progressColor} strokeWidth={outerStroke} strokeLinecap="round"
        strokeDasharray={outerC} strokeDashoffset={outerOffset} style={{ transition: 'stroke-dashoffset .6s ease' }}
      />
      <circle cx={cx} cy={cy} r={innerR} fill="none" stroke={hexToRgba(healthColor, 0.18)} strokeWidth={innerStroke} />
      <circle
        cx={cx} cy={cy} r={innerR} fill="none" stroke={healthColor} strokeWidth={innerStroke} strokeLinecap="round"
        strokeDasharray={innerC} strokeDashoffset={innerOffset} style={{ transition: 'stroke-dashoffset .6s ease' }}
      />
    </svg>
  );
}

/** A signal light: a working agent pings outward like sonar, a resting one
 *  breathes slowly, everything else sits as a steady, dimmer dot. Color is
 *  never the only cue — every caller pairs this with the status word as text. */
export function Beacon({
  color,
  animate,
  breathe,
  size = 18,
}: {
  color: string;
  animate: boolean;
  breathe?: boolean;
  size?: number;
}) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size * 2.4, height: size * 2.4 }}>
      {animate && [0, 1].map((i) => (
        <span
          key={i}
          aria-hidden
          style={{
            position: 'absolute', width: size, height: size, borderRadius: '50%',
            border: `1.5px solid ${color}`, animation: `beacon-ping 2.2s ${i * 1.1}s ease-out infinite`,
          }}
        />
      ))}
      <span
        style={{
          width: size, height: size, borderRadius: '50%',
          background: `radial-gradient(circle at 35% 30%, ${hexToRgba(color, 0.95)}, ${hexToRgba(color, 0.55)} 70%)`,
          boxShadow: `0 0 ${animate ? 14 : 6}px ${hexToRgba(color, animate ? 0.7 : 0.32)}`,
          animation: breathe ? 'beacon-breathe 3.6s ease-in-out infinite' : undefined,
        }}
      />
    </span>
  );
}
