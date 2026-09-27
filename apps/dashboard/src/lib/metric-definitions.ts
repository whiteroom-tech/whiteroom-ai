// Plain-language definitions for the savings stats, shown behind an ⓘ next to
// each label. They describe the math in lib/analytics-metrics.ts and
// lib/format.ts; if that math changes, update these.

import { estimateCost, KWH_PER_TOKEN } from './format';

export type MetricKey = 'compression' | 'tokensWith' | 'tokensWithout' | 'costSaved' | 'energySaved';

/** Blended $ per million saved tokens, derived from estimateCost so it can't drift. */
const USD_PER_MILLION = estimateCost(1_000_000).toFixed(2);
const KWH_PER_MILLION = +(KWH_PER_TOKEN * 1_000_000).toFixed(3);

/**
 * `watch` — the Overview strip, which covers the current watch.
 * `range` — Run History, which covers the selected date range.
 */
export function metricDefinition(key: MetricKey, scope: 'watch' | 'range'): string {
  const period = scope === 'watch' ? 'in the current watch' : 'in the selected range';
  switch (key) {
    case 'compression':
      return 'How much smaller an agent’s context is after a handover than before it, averaged across handovers.';
    case 'tokensWith':
      return `Tokens your agents actually used through WhiteRoom ${period}.`;
    case 'tokensWithout':
      return scope === 'watch'
        ? 'Tokens used plus the estimated tokens saved. The saving applies the fleet’s lifetime savings rate to this watch’s usage.'
        : 'Tokens used plus the tokens saved by handover compression and context offloads.';
    case 'costSaved':
      return `Tokens saved ${period}, priced at a blended $${USD_PER_MILLION} per million (80% input, 20% output). Performance’s Est. Savings is a different measure: prompt-cache discounts plus governance.`;
    case 'energySaved':
      return `Tokens saved ${period} × ${KWH_PER_MILLION} kWh per million tokens.`;
  }
}
