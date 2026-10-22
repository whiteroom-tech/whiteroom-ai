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
  /** One word, for the legend beside the wheel. */
  short: string;
  value: number | null;
  color: string;
}

/** The wheel's three equal wedges, fixed order, each colored by its own 0-100 value. */
export function scoreWedges(a: Pick<AgentScore, 'completeRate' | 'costDiligence' | 'speedScore'>): ScoreWedge[] {
  return [
    { label: 'Task success', short: 'Tasks', value: a.completeRate, color: tierColor(a.completeRate, 100) },
    { label: 'Cost diligence', short: 'Cost', value: a.costDiligence, color: tierColor(a.costDiligence, 100) },
    { label: 'Speed', short: 'Speed', value: a.speedScore, color: tierColor(a.speedScore, 100) },
  ];
}

/**
 * The wheel as SVG ring segments: equal arcs in order, clockwise from the
 * top, with a small gap between them so each reads as its own part.
 */
export function wheelArcs(count: number, size: number, stroke: number, gapDeg = 14): string[] {
  const r = (size - stroke) / 2;
  const c = size / 2;
  const step = 360 / count;
  const at = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return `${+(c + r * Math.cos(rad)).toFixed(2)} ${+(c + r * Math.sin(rad)).toFixed(2)}`;
  };
  return Array.from({ length: count }, (_, i) => {
    const from = i * step + gapDeg / 2;
    const to = (i + 1) * step - gapDeg / 2;
    return `M ${at(from)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${at(to)}`;
  });
}

/** A segment's stroke: its tier color, or the faint track when there's no data (gray would read as a score). */
export function wedgeStroke(w: Pick<ScoreWedge, 'value' | 'color'>): string {
  return w.value == null ? 'var(--track)' : w.color;
}

/** One line for the wheel's title attribute: what each wedge is, in order. */
export function wedgeSummary(wedges: Pick<ScoreWedge, 'label' | 'value'>[]): string {
  return wedges.map((w) => `${w.label}: ${w.value == null ? 'no data' : `${w.value}/100`}`).join(' · ');
}
