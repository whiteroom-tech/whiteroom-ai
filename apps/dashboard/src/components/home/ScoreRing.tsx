import { FONT_DISPLAY } from '@whiteroom/ui';

/**
 * An agent's score out of 10 as one ring: the brand colour, green from 9 up.
 * One colour on purpose (no red/amber tiers): the score is a summary, not an alarm.
 */
export function ScoreRing({ score, size = 40 }: { score: number; size?: number }) {
  const s = Math.max(0, Math.min(10, score));
  const r = size * 0.4;
  const c = 2 * Math.PI * r;
  const w = size * 0.1;
  const mid = size / 2;
  const label = Number.isInteger(s) ? String(s) : s.toFixed(1);
  return (
    <svg className="wr-score-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Score ${label} out of 10`}>
      <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--track)" strokeWidth={w} />
      <circle
        cx={mid} cy={mid} r={r} fill="none"
        stroke={s >= 9 ? 'var(--ok)' : 'var(--brand)'} strokeWidth={w} strokeLinecap="round"
        strokeDasharray={`${((s / 10) * c).toFixed(1)} ${c.toFixed(1)}`}
        transform={`rotate(-90 ${mid} ${mid})`}
      />
      <text x={mid} y={mid + size * 0.12} textAnchor="middle" fontFamily={FONT_DISPLAY} fontSize={Math.max(14, Math.round(size * 0.35))} fontWeight={600} fill="var(--tx)">{label}</text>
    </svg>
  );
}
