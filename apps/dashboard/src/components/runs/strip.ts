// What the day and hour charts on Runs share: bar heights, bar labels, and
// centring a bar where the chart scrolls sideways (phones).

import { plural } from '@/lib/format';

/** A bar's height for `n` runs against the busiest `max`: at least 14% when there are any, a 2px line when none. */
export function barHeight(n: number, max: number): string | number {
  return n ? `${Math.max(14, (n / max) * 100)}%` : 2;
}

/** "Mon, Oct 26: 3 runs". */
export function barLabel(name: string, n: number): string {
  return `${name}: ${n} ${plural(n, 'run')}`;
}

/** Scrolls `el` so bar `i` of `count` sits in the middle of the view. */
export function centreBar(el: HTMLElement, i: number, count: number): void {
  el.scrollLeft = Math.max(0, ((i + 0.5) / count) * el.scrollWidth - el.clientWidth / 2);
}
