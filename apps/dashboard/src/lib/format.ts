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

/** "02:15 PM" in the browser's locale. */
export function fmtTime(ts: string | number | Date): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
