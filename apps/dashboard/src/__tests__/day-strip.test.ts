// @vitest-environment happy-dom
// Runs' charts as the mockup draws them: a titled day card with true bar
// heights, the busiest count, date ticks and flagged segments; and the hour
// card with counts, the rule-activity mark, "Showing …" and Back to 30 days.
// On phones both scroll sideways (bars stay tappable): where they open, and
// that a poll never moves the person.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { DayStrip } from '@/components/runs/DayStrip';
import { HourStrip } from '@/components/runs/HourStrip';
import { barHeight, tickIndexes } from '@/components/runs/strip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const days = (flagged: boolean) => Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, runs: i === 20 ? 47 : i % 3, ...(flagged ? { flagged: i === 20 ? 4 : 0 } : {}) }));

async function mount(node: React.ReactElement) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  return { el, done: async () => { await act(async () => root.unmount()); el.remove(); } };
}

describe('bar heights and ticks', () => {
  it('draws true heights: no floor beyond a visible sliver, a hairline for none', () => {
    expect(barHeight(47, 47)).toBe('max(3px, 100.00%)');
    expect(barHeight(1, 47)).toBe('max(3px, 2.13%)');
    expect(barHeight(0, 47)).toBe('1px');
  });
  it('ticks the first day, every 7th and the last', () => {
    expect(tickIndexes(30)).toEqual([0, 7, 14, 21, 29]);
    expect(tickIndexes(1)).toEqual([0]);
  });
});

describe('day chart', () => {
  it('has a title, a legend, the busiest count and the flagged segment when known', async () => {
    const pick = vi.fn();
    const { el, done } = await mount(h(DayStrip, { days: days(true), selected: null, inRange: (d: string) => d >= '2026-09-24', onPick: pick, title: 'Runs per day · last 30 days', legend: 'Last 7 days · 60 runs · select a day to see its hours', flaggedKnown: true }));
    expect(el.querySelector('h2')?.textContent).toBe('Runs per day · last 30 days');
    expect(el.textContent).toContain('Last 7 days · 60 runs · select a day to see its hours');
    expect(el.textContent).toContain('Flagged');
    expect(el.querySelector('.wr-runchart__max')?.textContent).toBe('47');
    expect(el.querySelectorAll('.wr-runchart__flag')).toHaveLength(1);
    expect(el.querySelectorAll('.wr-runchart__day.is-in')).toHaveLength(7);
    const busiest = el.querySelectorAll('button')[20];
    expect(busiest.getAttribute('aria-label')).toBe('Mon, Sep 21: 47 runs, 4 flagged');
    await act(async () => { (busiest as HTMLButtonElement).click(); });
    expect(pick).toHaveBeenCalledWith('2026-09-21');
    await done();
  });
  it('leaves out the flagged key and segments on engines that don’t count them', async () => {
    const { el, done } = await mount(h(DayStrip, { days: days(false), selected: null, inRange: () => false, onPick: () => {}, title: 't', legend: 'l', flaggedKnown: false }));
    expect(el.textContent).not.toContain('Flagged');
    expect(el.querySelector('.wr-runchart__flag')).toBeNull();
    await done();
  });
});

describe('hour chart', () => {
  it('shows counts, marks hours with rule activity, and offers All hours and Back to 30 days', async () => {
    const pick = vi.fn();
    const back = vi.fn();
    const { el, done } = await mount(h(HourStrip, { dayName: 'Sat, Oct 24', hours: [{ hour: 20, runs: 9, ruleActivity: 6 }, { hour: 21, runs: 2, ruleActivity: 0 }], selected: 21, onPick: pick, onBack: back }));
    expect(el.querySelector('h2')?.textContent).toBe('Sat, Oct 24 by hour');
    expect(el.textContent).toContain('Showing 9 pm–10 pm');
    expect([...el.querySelectorAll('.wr-runchart__count')].map((c) => c.textContent)).toEqual(['9', '2']);
    expect(el.querySelectorAll('.wr-runchart__bar.has-rule')).toHaveLength(1);
    expect(el.textContent).toContain('Hour with rule activity');
    const buttons = [...el.querySelectorAll('button')];
    await act(async () => { buttons.find((b) => b.textContent === 'All hours')!.click(); });
    expect(pick).toHaveBeenCalledWith(null);
    await act(async () => { buttons.find((b) => b.textContent === 'Back to 30 days')!.click(); });
    expect(back).toHaveBeenCalled();
    await done();
  });
  it('says so when the day has no runs, and hides the rule key without the data', async () => {
    const { el, done } = await mount(h(HourStrip, { dayName: 'Sun, Oct 25', hours: [], selected: null, onBack: () => {} }));
    expect(el.textContent).toContain('No runs that day.');
    await done();
    const second = await mount(h(HourStrip, { dayName: 'Sun, Oct 25', hours: [{ hour: 3, runs: 1 }], selected: null, onBack: () => {} }));
    expect(second.el.textContent).not.toContain('rule activity');
    await second.done();
  });
});

describe('chart scrolling (phones)', () => {
  const sizes: Record<string, PropertyDescriptor | undefined> = {};
  beforeAll(() => {
    for (const [k, v] of [['scrollWidth', 960], ['clientWidth', 320]] as const) {
      sizes[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
      Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
    }
  });
  afterAll(() => { for (const k of Object.keys(sizes)) if (sizes[k]) Object.defineProperty(HTMLElement.prototype, k, sizes[k]!); });

  it('opens the day chart on the newest day, centres a pick, and stays put across polls', async () => {
    const props = (selected: string | null = null) => ({ days: days(false), selected, inRange: () => true, onPick: () => {}, title: 't', legend: 'l', flaggedKnown: false });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => root.render(h(DayStrip, props())));
    const strip = el.querySelector('.wr-strip-scroll') as HTMLElement;
    expect(strip.scrollLeft).toBe(960);
    strip.scrollLeft = 120;
    await act(async () => root.render(h(DayStrip, props())));
    expect(strip.scrollLeft).toBe(120);
    await act(async () => root.render(h(DayStrip, props('2026-09-10'))));
    expect(strip.scrollLeft).toBe((9.5 / 30) * 960 - 160);
    await act(async () => root.unmount());
    el.remove();
  });

  it('opens the hour chart on the busiest hour once per day', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const render = (dayName: string, hours: { hour: number; runs: number }[]) => act(async () => { root.render(h(HourStrip, { dayName, hours, selected: null, onPick: () => {}, onBack: () => {} })); });
    await render('Mon, Oct 26', [{ hour: 18, runs: 5 }, { hour: 9, runs: 1 }]);
    const wrap = el.querySelector('.wr-strip-scroll') as HTMLElement;
    expect(wrap.scrollLeft).toBe((18.5 / 24) * 960 - 160);
    wrap.scrollLeft = 40;
    await render('Mon, Oct 26', [{ hour: 18, runs: 5 }, { hour: 9, runs: 9 }]);
    expect(wrap.scrollLeft).toBe(40);
    await render('Tue, Oct 27', [{ hour: 6, runs: 3 }]);
    expect((el.querySelector('.wr-strip-scroll') as HTMLElement).scrollLeft).toBe((6.5 / 24) * 960 - 160);
    // A day with no runs yet waits, then opens on its first busy hour once one arrives.
    await render('Wed, Oct 28', []);
    expect(el.querySelector('.wr-strip-scroll')).toBeNull();
    await render('Wed, Oct 28', [{ hour: 12, runs: 1 }]);
    expect((el.querySelector('.wr-strip-scroll') as HTMLElement).scrollLeft).toBe((12.5 / 24) * 960 - 160);
    await act(async () => root.unmount());
    el.remove();
  });
});
