import { FONT_DISPLAY } from '@whiteroom/ui';

/**
 * One score as a single ring: the arc is the score out of 10, the number sits
 * in the middle. One neutral colour (green only at 9 and up), never a red or
 * amber tier, so a middling score doesn't read as an alarm.
 */
export function ScoreRing({ score, size = 52 }: { score: number; size?: number }) {
  const r = size * 0.4;
  const c = 2 * Math.PI * r;
  const w = size * 0.1;
  const mid = size / 2;
  const shown = Math.max(0, Math.min(10, score));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Score ${shown} out of 10`} style={{ flex: 'none' }}>
      <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--track)" strokeWidth={w} />
      <circle
        cx={mid} cy={mid} r={r} fill="none"
        stroke={shown >= 9 ? 'var(--ok)' : 'var(--brand)'} strokeWidth={w} strokeLinecap="round"
        strokeDasharray={`${((shown / 10) * c).toFixed(1)} ${c.toFixed(1)}`}
        transform={`rotate(-90 ${mid} ${mid})`}
      />
      <text x={mid} y={mid + size * 0.12} textAnchor="middle" fontFamily={FONT_DISPLAY} fontSize={Math.max(14, Math.round(size * 0.35))} fontWeight={600} fill="var(--tx)">{shown}</text>
    </svg>
  );
}
