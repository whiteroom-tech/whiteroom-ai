// @vitest-environment happy-dom
// The hour chart where it scrolls (phones): it opens on the busiest hour once
// per day, and a poll that changes the busiest hour doesn't move the person.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { HourStrip } from '@/components/runs/HourStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sizes: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  for (const [k, v] of [['scrollWidth', 960], ['clientWidth', 320]] as const) {
    sizes[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
  }
});
afterAll(() => { for (const k of Object.keys(sizes)) if (sizes[k]) Object.defineProperty(HTMLElement.prototype, k, sizes[k]!); });

describe('hour chart scrolling', () => {
  it('opens on the busiest hour once per day, and stays put across polls', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const render = (dayName: string, hours: { hour: number; runs: number }[]) => act(async () => { root.render(h(HourStrip, { dayName, hours, selected: null, onPick: () => {} })); });
    await render('Mon, Oct 26', [{ hour: 18, runs: 5 }, { hour: 9, runs: 1 }]);
    const wrap = el.querySelector('.wr-hourstrip-wrap') as HTMLElement;
    expect(wrap.scrollLeft).toBe((18 / 24) * 960 - 160);
    wrap.scrollLeft = 40;
    // A poll makes 9 am the busiest: the person's scroll stays.
    await render('Mon, Oct 26', [{ hour: 18, runs: 5 }, { hour: 9, runs: 9 }]);
    expect(wrap.scrollLeft).toBe(40);
    // Another day opens on its own busiest hour.
    await render('Tue, Oct 27', [{ hour: 6, runs: 3 }]);
    expect(wrap.scrollLeft).toBe((6 / 24) * 960 - 160);
    // A day with no runs yet waits, then opens on its first busy hour once one arrives.
    wrap.scrollLeft = 0;
    await render('Wed, Oct 28', []);
    expect(wrap.scrollLeft).toBe(0);
    await render('Wed, Oct 28', [{ hour: 12, runs: 1 }]);
    expect(wrap.scrollLeft).toBe((12 / 24) * 960 - 160);
    root.unmount();
  });
});
