// The By-agent table's performance wheel (audit M12): one 0-10 score per
// agent, broken into the three categories it's averaged from.

import type { AgentScore } from './whiteroom/types';

/** Red at or below 30% of max, amber below 70%, green above — null reads as unknown, not bad. */
export function tierColor(value: number | null, max: number): string {
  if (value == null) return 'var(--tx3)';
  const pct = value / max;
  if (pct <= 0.3) return 'var(--bad)';
  if (pct < 0.7) return 'var(--warn)';
  return 'var(--ok)';
}

export function scoreColor(score: number | null): string {
  return tierColor(score, 10);
}

export interface ScoreWedge {
  label: string;
  value: number | null;
  color: string;
}

/** The wheel's three equal wedges, fixed order, each colored by its own 0-100 value. */
export function scoreWedges(a: Pick<AgentScore, 'completeRate' | 'costDiligence' | 'speedScore'>): ScoreWedge[] {
  return [
    { label: 'Task success', value: a.completeRate, color: tierColor(a.completeRate, 100) },
    { label: 'Cost diligence', value: a.costDiligence, color: tierColor(a.costDiligence, 100) },
    { label: 'Speed', value: a.speedScore, color: tierColor(a.speedScore, 100) },
  ];
}

/** A flat conic-gradient of equal wedges — no gaps, the wheel is too small for them to read anyway. */
export function wheelGradient(wedges: Pick<ScoreWedge, 'color'>[]): string {
  const step = 360 / wedges.length;
  return `conic-gradient(${wedges.map((w, i) => `${w.color} ${i * step}deg ${(i + 1) * step}deg`).join(', ')})`;
}

/** One line for the wheel's title attribute: what each wedge is, in order. */
export function wedgeSummary(wedges: Pick<ScoreWedge, 'label' | 'value'>[]): string {
  return wedges.map((w) => `${w.label}: ${w.value == null ? 'no data' : `${w.value}/100`}`).join(' · ');
}
