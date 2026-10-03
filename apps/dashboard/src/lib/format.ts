// Shared display formatters for the Citadel pages. Pure functions, no React.
//
// These consolidate copies that had drifted apart across the pages: the local
// fmtK helpers rendered 1.5M tokens as "1500.0K", while the performance page's
// fmtTokens handled millions correctly — that behavior is canonical here.

import { estimateCost } from './analytics-metrics';

// Re-exported so display code has one import for cost math + formatting; the
// implementation (and its tests) stay in analytics-metrics.
export { estimateCost };

/** kWh consumed per token — used for the "energy saved" stat. */
export const KWH_PER_TOKEN = 0.0000004;

/** Energy from saved tokens: "≈490 Wh", "≈2.1 kWh"; null when there's nothing to show. */
export function fmtEnergy(tokensSaved: number): string | null {
  return fmtKwh(tokensSaved * KWH_PER_TOKEN);
}

/** "≈490 Wh" / "≈2.1 kWh" from kWh (e.g. the engine's "0.4900 kWh"); null for zero or unreadable. */
export function fmtKwh(kwh: number): string | null {
  if (!(kwh > 0)) return null;
  return kwh < 1 ? `≈${Math.max(1, Math.round(kwh * 1000))} Wh` : `≈${kwh.toFixed(1)} kWh`;
}

/** Token counts: 999 → "999", 1500 → "1.5K", 1_500_000 → "1.50M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return n < 1_000_000 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1_000_000).toFixed(2)}M`;
}

/** Cost in micro-dollars: more precision the smaller the amount. */
export function fmtCost(micros: number): string {
  if (micros === 0) return '$0.00';
  const d = micros / 1_000_000;
  return d < 0.01 ? `$${d.toFixed(4)}` : d < 1 ? `$${d.toFixed(3)}` : `$${d.toFixed(2)}`;
}

/** "Oct 1", or "Oct 1, 2025" outside the current year, in the viewer's time zone. '' for an unreadable time. */
export function fmtDay(ts: string | number | Date, now: number = Date.now()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(!sameYear && { year: 'numeric' }) });
}

/** "2:15 pm" today, else "Oct 1": a time column that's never mistaken for today. '' for an unreadable time. */
export function fmtWhen(ts: string | number | Date, now: number = Date.now()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date(now).toDateString() ? fmtTime(d) : fmtDay(d, now);
}

/** "2:15 pm" in the viewer's time zone: the one clock-time wording. '' for an unreadable time. */
export function fmtTime(ts: string | number | Date): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  // ICU puts a narrow no-break space before "PM"; normalise it so copy and tests match.
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toLowerCase();
}

/** "just now", "5 min ago", "2 hours ago", "3 days ago": the one relative-time wording. '' for an unreadable time. */
export function timeAgo(ts: string | number | Date, now: number = Date.now()): string {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '';
  // A time slightly ahead of this clock reads as just now.
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}
