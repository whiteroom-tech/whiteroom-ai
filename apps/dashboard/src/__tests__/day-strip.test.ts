// @vitest-environment happy-dom
// The day strip where it scrolls (phones): it opens on the newest day, and a
// poll's re-render (a fresh but equal days array) never pulls the person back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { DayStrip } from '@/components/runs/DayStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sizes: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  for (const [k, v] of [['scrollWidth', 1000], ['clientWidth', 300]] as const) {
    sizes[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
  }
});
afterAll(() => { for (const k of Object.keys(sizes)) if (sizes[k]) Object.defineProperty(HTMLElement.prototype, k, sizes[k]!); });

const days = () => Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, runs: i % 3 }));

describe('day strip scrolling', () => {
  it('opens on the newest day and stays where the person scrolled across re-renders', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const props = () => ({ days: days(), selected: null, inRange: () => true, onPick: () => {} });
    await act(async () => { root.render(h(DayStrip, props())); });
    const strip = el.querySelector('.wr-strip-scroll') as HTMLElement;
    expect(strip.scrollLeft).toBe(1000);
    strip.scrollLeft = 120;
    await act(async () => { root.render(h(DayStrip, props())); });
    expect(strip.scrollLeft).toBe(120);
    // Picking a day centres it; un-picking leaves the strip where it is.
    await act(async () => { root.render(h(DayStrip, { ...props(), selected: '2026-10-10' })); });
    expect(strip.scrollLeft).toBe((9.5 / 30) * 1000 - 150);
    await act(async () => { root.render(h(DayStrip, props())); });
    expect(strip.scrollLeft).toBe((9.5 / 30) * 1000 - 150);
    // A different window (paging) opens at its newest day.
    await act(async () => { root.render(h(DayStrip, { ...props(), days: days().map((d) => ({ ...d, day: d.day.replace('2026-10', '2026-09') })) })); });
    expect(strip.scrollLeft).toBe(1000);
    root.unmount();
  });
});

describe('day strip legend', () => {
  it('says what each bar shade means, and names the picked day once there is one', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const props = { days: days(), selected: null as string | null, inRange: () => true, onPick: () => {} };
    await act(async () => { root.render(h(DayStrip, props)); });
    const legend = () => el.querySelector('.wr-daystrip__legend') as HTMLElement;
    expect(legend().textContent).toBe('Days listed belowOther days');
    expect(legend().querySelector('.wr-daystrip__key.is-in')).toBeTruthy();
    await act(async () => { root.render(h(DayStrip, { ...props, selected: '2026-10-10' })); });
    expect(legend().textContent).toBe('Picked dayOther days');
    expect(legend().querySelector('.wr-daystrip__key.is-selected')).toBeTruthy();
    expect(legend().querySelector('.wr-daystrip__key.is-in')).toBeNull();
    await act(async () => { root.unmount(); });
    el.remove();
  });
});

