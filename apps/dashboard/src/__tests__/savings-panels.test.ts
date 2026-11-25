import { describe, expect, it } from 'vitest';
import { agentDaySavings, auditSavingsEvent, dailySavings, localDayFromTs } from '@/lib/analytics-metrics';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokensCompare } from '@/components/performance/SavingsPanels';

// Performance's Savings chart and By agent table, moved from Run History,
// must keep Run History's numbers: same attribution, same per-agent-day math.

const now = new Date(2026, 9, 1, 15, 0).getTime(); // Oct 1, local
const at = (day: number, hour = 10) => new Date(2026, 9, day, hour, 0).toISOString();

const entries = [
  { type: 'task_complete', timestamp: at(1), agentId: 'Lead-Agent', tokensUsed: 1000 },
  { type: 'task_complete', timestamp: at(1, 11), agentId: 'writer', tokensUsed: 3000 },
  { type: 'self_handover', timestamp: at(1, 12), agentId: 'lead-agent', contextTokens: 50_000, handoverDocTokens: 2_000 },
  { type: 'task_complete', timestamp: new Date(2026, 8, 28, 9).toISOString(), agentId: 'lead-agent', tokensUsed: 500 },
  { type: 'task_complete', timestamp: new Date(2026, 8, 20, 9).toISOString(), agentId: 'ancient', tokensUsed: 7 },
];

describe('dailySavings', () => {
  it('returns every day of the window, oldest first, with zeros for quiet days', () => {
    const days = dailySavings(entries, 7, now);
    expect(days.map((d) => d.day)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
    expect(days.find((d) => d.day === '2026-09-28')!.used).toBe(500);
    expect(days.find((d) => d.day === '2026-09-26')).toEqual({ day: '2026-09-26', used: 0, saved: 0 });
    // Older than the window: not counted anywhere.
    expect(days.reduce((s, d) => s + d.used, 0)).toBe(1000 + 3000 + 500);
  });

  it('computes saved with the same per-agent-day math as Run History', () => {
    const inWindow = entries.filter((e) => localDayFromTs(e.timestamp) >= '2026-09-25');
    const expected = agentDaySavings(inWindow.map((e) => auditSavingsEvent(e, localDayFromTs(e.timestamp)))).byDay.get('2026-10-01');
    expect(dailySavings(entries, 7, now).at(-1)!.saved).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });
});

describe('Input sent to your models', () => {
  const days = [
    { day: '2026-10-21', used: 0, saved: 0 },
    { day: '2026-10-22', used: 50_100, saved: 1_569_900 },
    { day: '2026-10-23', used: 1_670_000, saved: 960_000 },
  ];
  it('shows the two totals, what was saved, the energy estimate and each day', () => {
    const html = renderToStaticMarkup(h(TokensCompare, { days, usdByDay: { '2026-10-22': 1_260_000 }, defaultOpen: true }));
    expect(html).toContain('Input sent to your models');
    expect(html).toContain('Without WhiteRoom, est.');
    expect(html).toContain('>4.25M<');
    expect(html).toContain('>1.72M<');
    // What the bars add up to, beside the title.
    expect(html).toContain('2.53M fewer tokens · about 60% less');
    expect(html).toContain('less energy, estimated');
    // The chart is always the 7 days, whatever the range: its fold says so.
    expect(html).toContain('By day · last 7 days');
    expect(html).toContain('1.57M saved');
    expect(html).toContain('$1.26');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('font-mono');
  });
  it('sizes the bars: the with-bar as its share of the without-bar, days against the busiest day', () => {
    const html = renderToStaticMarkup(h(TokensCompare, { days, defaultOpen: true }));
    expect(html).toContain('width:calc((100% - 72px) * 1)');
    expect(html).toContain('width:calc((100% - 72px) * 0.405)'); // 1.72M of 4.25M
    // The busiest day (2.63M without) fills the plot; its 1.67M with WhiteRoom is 63 of 100px.
    expect(html).toContain('height:100px');
    expect(html).toContain('height:63px');
    // A tiny day still shows a sliver, never 0px.
    expect(html).toContain('height:3px');
  });
  it('a quiet day shows a dash, and a day without a dollar figure shows only its tokens', () => {
    const html = renderToStaticMarkup(h(TokensCompare, { days, usdByDay: null, defaultOpen: true }));
    expect(html).toContain('>—<');
    expect(html).toContain('960K saved');
    expect(html).not.toContain('wr-tokens__usd');
  });
  it('keeps the totals on show with the day chart folded, and says so when nothing ran', () => {
    const closed = renderToStaticMarkup(h(TokensCompare, { days }));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('Without WhiteRoom, est.');
    expect(closed).toContain('>4.25M<');
    expect(closed).not.toContain('wr-tokens__days');
    expect(renderToStaticMarkup(h(TokensCompare, { days: [days[0]], defaultOpen: true }))).toContain('No input reached your models in the last 7 days.');
  });
  it('says nothing was saved when the range had calls and saved none', () => {
    const html = renderToStaticMarkup(h(TokensCompare, { days: null, range: { used: 10, saved: 0, label: 'today' } }));
    expect(html).toContain('Nothing saved in this range.');
    expect(html).not.toContain('fewer tokens');
    expect(html).toContain('>10<');
  });
  it('shows no bars when the range could not be read, never the 7 days under its name, and keeps the day chart', () => {
    const html = renderToStaticMarkup(h(TokensCompare, { days, range: null, unavailable: true, defaultOpen: true }));
    expect(html).toContain('Couldn’t load, retrying on the next refresh.');
    expect(html).not.toContain('wr-tokens__totals');
    expect(html).not.toContain('fewer tokens');
    expect(html).toContain('By day · last 7 days');
    expect(html).toContain('wr-tokens__days');
  });
  it('offers the day chart only when the 7 days have calls, and carries the spend note', () => {
    const fold = (html: string) => html.includes('By day · last 7 days');
    expect(fold(renderToStaticMarkup(h(TokensCompare, { days })))).toBe(true);
    // Calls in the range, no input per day.
    expect(fold(renderToStaticMarkup(h(TokensCompare, { days: null, range: { used: 10, saved: 30, label: 'today' } })))).toBe(false);
    // None in the range, some in the 7 days.
    expect(fold(renderToStaticMarkup(h(TokensCompare, { days, range: { used: 0, saved: 0, label: 'today' } })))).toBe(true);
    // None at all.
    expect(fold(renderToStaticMarkup(h(TokensCompare, { days: null, range: { used: 0, saved: 0, label: 'today' } })))).toBe(false);
    expect(renderToStaticMarkup(h(TokensCompare, { days, note: 'Spend: prices 16 days old' }))).toContain('Spend: prices 16 days old');
  });
});
