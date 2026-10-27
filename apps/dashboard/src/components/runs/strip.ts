// What the day and hour charts on Runs share: bar heights, bar labels and date ticks.

import { plural } from '@/lib/format';

/** A bar's height for `n` runs against the busiest `max`: its true share, at least 3px when there are any, a 1px line when none. */
export function barHeight(n: number, max: number): string {
  return n ? `max(3px, ${((n / Math.max(1, max)) * 100).toFixed(2)}%)` : '1px';
}

/** "Mon, Oct 26: 3 runs", with ", 1 flagged" or ", rule activity" when known. */
export function barLabel(name: string, n: number, extra: { flagged?: number; ruleActivity?: number } = {}): string {
  return `${name}: ${n} ${plural(n, 'run')}${extra.flagged ? `, ${extra.flagged} flagged` : ''}${extra.ruleActivity ? ', rule activity' : ''}`;
}

/** Which bars get a date tick under a strip of `n`: the first, every 7th, and the last. */
export function tickIndexes(n: number, every = 7): number[] {
  if (n <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < n - 3; i += every) out.push(i);
  out.push(n - 1);
  return out;
}
