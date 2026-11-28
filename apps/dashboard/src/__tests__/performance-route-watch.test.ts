// Performance › Rules: Model routing's rows. The calls that could use a cheaper
// model (Watch) and the ones that went to one (Enforce), with what they cost at
// each model, apart from what rules caught.
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RulesSummary } from '@/app/(citadel)/performance/_components/RulesSummary';
import { SavedInTotal } from '@/components/performance/SavingsPanels';
import { routeSaved, type RouteWatch } from '@/lib/analytics-metrics';
import { governanceCounts } from '@/lib/governance';
import type { GovernanceRule } from '@/lib/whiteroom/types';

const route = (id: string): GovernanceRule => ({
  id, fleetId: 'f', ruleType: 'model_route', params: { ladder: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  mode: 'watch', response: 'notify', appliesTo: ['support-agent'], version: 1, changedBy: 'test', changedAt: '2026-11-20T00:00:00Z',
});
const render = (routeWatch: Parameters<typeof RulesSummary>[0]['routeWatch'], rules: GovernanceRule[] = [route('gr_route')]) =>
  renderToStaticMarkup(h(RulesSummary, { counts: { ...governanceCounts([]), blocks: 3, wouldBlocks: 141 }, rules, unavailable: false, routeWatch }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('Model routing on Performance', () => {
  it('shows the calls, what they cost as sent and on the cheaper model, and that it isn’t a saving', () => {
    const html = render({ calls: 41, unpricedCalls: 0, baselineMicros: 12_400_000, costMicros: 6_200_000 });
    expect(text(html)).toContain('Model routing 41 calls could use a cheaper model · $12.40 as sent, $6.20 on the cheaper model Watch');
    expect(text(html)).toContain('The same usage at list prices. Nothing was changed, so this isn’t a saving.');
    // The one rule opens from the row.
    expect(html).toContain('href="/controls?rule=gr_route"');
    // What rules caught is its own line, the same with the row as without it: these calls aren't in it.
    expect(text(html)).toContain('3 blocked · 141 would have acted');
    expect(text(render(null))).toContain('3 blocked · 141 would have acted');
  });

  it('says how many calls had no price, and gives no dollars when none had one', () => {
    expect(text(render({ calls: 5, unpricedCalls: 2, baselineMicros: 3_000_000, costMicros: 1_500_000 }))).toContain('5 calls could use a cheaper model · $3.00 as sent, $1.50 on the cheaper model · 2 not priced');
    const none = text(render({ calls: 1, unpricedCalls: 1, baselineMicros: 0, costMicros: 0 }));
    expect(none).toContain('1 call could use a cheaper model · 1 not priced');
    expect(none).not.toContain('$');
    // No dollars on the Watch row either, so no note about prices under it.
    expect(none).not.toContain('list prices');
  });

  it('shows the calls that went to a cheaper model on their own row, and never as a saving', () => {
    const none = { calls: 0, unpricedCalls: 0, baselineMicros: 0, costMicros: 0 };
    const routed = text(render({ ...none, routed: { calls: 12, unpricedCalls: 1, baselineMicros: 8_000_000, costMicros: 3_000_000 } }));
    expect(routed).toContain('Model routing 12 calls went to a cheaper model · $8.00 on the model asked for, $3.00 on the cheaper model · 1 not priced Enforce');
    expect(routed).toContain('The same usage at list prices. Until enough runs are measured, the difference is the estimate in Saved in total, under Cost.');
    expect(routed).not.toContain('could use a cheaper model');
    // The one rule opens from this row too.
    expect(render({ ...none, routed: { calls: 12, unpricedCalls: 0, baselineMicros: 8_000_000, costMicros: 3_000_000 } })).toContain('href="/controls?rule=gr_route"');
    // None of them priced: the count alone, no dollars.
    const unpriced = text(render({ ...none, routed: { calls: 2, unpricedCalls: 2, baselineMicros: 0, costMicros: 0 } }));
    expect(unpriced).toContain('2 calls went to a cheaper model · 2 not priced');
    expect(unpriced).not.toContain('$');
    // No routed calls in the range: no such row.
    expect(text(render({ calls: 41, unpricedCalls: 0, baselineMicros: 12_400_000, costMicros: 6_200_000, routed: none }))).not.toContain('went to a cheaper model');
    // A range with both shows both, each with its own line.
    const both = text(render({ calls: 41, unpricedCalls: 0, baselineMicros: 12_400_000, costMicros: 6_200_000, routed: { calls: 12, unpricedCalls: 0, baselineMicros: 8_000_000, costMicros: 3_000_000 } }));
    expect(both).toContain('41 calls could use a cheaper model');
    expect(both).toContain('12 calls went to a cheaper model');
    // Neither changes what rules caught.
    expect(both).toContain('3 blocked · 141 would have acted');
  });

  it('says how many routed calls the cheaper model didn’t answer or refused, also when none got through', () => {
    const none = { calls: 0, unpricedCalls: 0, baselineMicros: 0, costMicros: 0 };
    const some = text(render({ ...none, routed: { calls: 12, unpricedCalls: 0, baselineMicros: 8_000_000, costMicros: 3_000_000, failedCalls: 3, refusedCalls: 2 } }));
    expect(some).toContain('12 calls went to a cheaper model · $8.00 on the model asked for, $3.00 on the cheaper model · 3 got no answer · 2 refused by the cheaper model, sent to the model asked for Enforce');
    const onlyRefused = text(render({ ...none, routed: { ...none, refusedCalls: 4 } }));
    expect(onlyRefused).toContain('0 calls went to a cheaper model · 4 refused by the cheaper model, sent to the model asked for');
    expect(onlyRefused).not.toContain('$');
    // No dollars on the row, so no note about prices under it.
    expect(onlyRefused).not.toContain('list prices');
    // An engine that doesn't count them says nothing about them.
    expect(text(render({ ...none, routed: { calls: 12, unpricedCalls: 0, baselineMicros: 8_000_000, costMicros: 3_000_000 } }))).not.toMatch(/no answer|refused/);
  });

  describe('the measured line', () => {
    const none = { calls: 0, unpricedCalls: 0, baselineMicros: 0, costMicros: 0 };
    const net = (routed: number, control: number, savedMicros: number | null, unpricedPeriods = 0) => ({ ...none, net: { routed: { periods: routed, calls: routed * 10, costMicros: 1 }, control: { periods: control, calls: control * 10, costMicros: 1 }, unpricedPeriods, savedMicros } });

    it('says what routing saved against the runs it left alone, and where that figure is counted', () => {
      const t = text(render(net(40, 30, 12_400_000)));
      expect(t).toContain('Model routing · measured $12.40 saved · 40 routed runs, 30 left on the model asked for');
      expect(t).toContain('What routed runs cost against runs left on the model asked for. It is in Saved in total, under Cost, and not in Saved by WhiteRoom.');
    });

    it('says when the figure covers only part of the fleet: what is still short of runs is counted beside it', () => {
      const some = { ...net(40, 30, 12_400_000), net: { ...net(40, 30, 12_400_000).net, groups: { measured: 1, waiting: 2 } } };
      expect(text(render(some))).toContain('$12.40 saved · 40 routed runs, 30 left on the model asked for · covers part of your fleet so far');
      const all = { ...net(40, 30, 12_400_000), net: { ...net(40, 30, 12_400_000).net, groups: { measured: 3, waiting: 0 } } };
      expect(text(render(all))).not.toContain('covers part of your fleet');
      // A loss over part of the fleet says both, and the unpriced count comes after.
      const loss = { ...net(40, 30, -2_000_000, 3), net: { ...net(40, 30, -2_000_000, 3).net, groups: { measured: 1, waiting: 1 } } };
      expect(text(render(loss))).toContain('$2.00 more spent · 40 routed runs, 30 left on the model asked for · covers part of your fleet so far · 3 not priced');
      // With no figure at all the row already says more runs are needed.
      const none = { ...net(4, 3, null), net: { ...net(4, 3, null).net, groups: { measured: 0, waiting: 2 } } };
      expect(text(render(none))).not.toContain('covers part of your fleet');
      expect(text(render(none))).toContain('Not enough runs to measure yet');
    });

    it('says a loss as a loss', () => {
      expect(text(render(net(30, 30, -6_000_000)))).toContain('$6.00 more spent · 30 routed runs, 30 left on the model asked for');
    });

    it('gives the counts and no figure until there are enough runs of each kind', () => {
      const t = text(render(net(12, 1, null)));
      expect(t).toContain('Not enough runs to measure yet · 12 routed runs, 1 left on the model asked for · more of each needed');
      // No figure, so nothing is said about savings.
      expect(t).not.toContain('counted in what WhiteRoom saved');
      expect(t).not.toContain('$');
    });

    it('says how many runs had a call with no price, also when that is all of them', () => {
      expect(text(render(net(40, 30, 12_400_000, 3)))).toContain('$12.40 saved · 40 routed runs, 30 left on the model asked for · 3 not priced');
      expect(text(render(net(0, 0, null, 5)))).toContain('Not enough runs to measure yet · 0 routed runs, 0 left on the model asked for · more of each needed · 5 not priced');
    });

    it('says nothing saved as that', () => {
      expect(text(render(net(30, 30, 0)))).toContain('$0.00 saved · 30 routed runs');
    });

    it('shows nothing with no runs of either kind, or from an engine that sends none', () => {
      expect(text(render(net(0, 0, null)))).not.toContain('measured');
      expect(text(render(none))).not.toContain('measured');
    });
  });

  it('shows nothing when no call could, the engine sent none, or its read failed', () => {
    for (const none of [{ calls: 0, unpricedCalls: 0, baselineMicros: 0, costMicros: 0 }, null, undefined]) {
      expect(text(render(none))).not.toContain('cheaper model');
    }
  });

  it('doesn’t link the row when there is no single rule to open', () => {
    const watch = { calls: 3, unpricedCalls: 0, baselineMicros: 900_000, costMicros: 450_000 };
    expect(render(watch, [route('a'), route('b')])).not.toContain('?rule=');
    expect(render(watch, [])).not.toContain('?rule=');
  });
});

describe('Saved in total: Saved by WhiteRoom with what Model routing saved', () => {
  const none = { calls: 0, unpricedCalls: 0, baselineMicros: 0, costMicros: 0 };
  const arm = (periods: number) => ({ periods, calls: periods * 10, costMicros: 1, failedCalls: 0, refusedCalls: 0 });
  const watch = (over: Partial<RouteWatch>): RouteWatch => ({ ...none, ...over });
  const row = (whiteRoomMicros: number, route: RouteWatch | null, partial = false) =>
    text(renderToStaticMarkup(h(SavedInTotal, { whiteRoomMicros, partial, route: routeSaved(route) })));

  it('picks the measured figure once there is one, and until then the price difference of the calls that were routed', () => {
    const routed = { calls: 10, unpricedCalls: 0, baselineMicros: 9_000_000, costMicros: 3_000_000 };
    expect(routeSaved(watch({ routed, net: { routed: arm(40), control: arm(30), unpricedPeriods: 0, savedMicros: 4_000_000 } }))).toEqual({ micros: 4_000_000, measured: true, partial: false, partOfFleet: false });
    expect(routeSaved(watch({ routed, net: { routed: arm(4), control: arm(3), unpricedPeriods: 0, savedMicros: null } }))).toEqual({ micros: 6_000_000, measured: false, partial: false, partOfFleet: false });
    expect(routeSaved(watch({ routed }))).toEqual({ micros: 6_000_000, measured: false, partial: false, partOfFleet: false });
    // A measured zero is a figure; it is not "nothing measured".
    expect(routeSaved(watch({ routed, net: { routed: arm(40), control: arm(30), unpricedPeriods: 0, savedMicros: 0 } }))).toEqual({ micros: 0, measured: true, partial: false, partOfFleet: false });
  });

  it('has no figure in Watch, with nothing routed, or when no routed call has a price', () => {
    expect(routeSaved(null)).toBeNull();
    expect(routeSaved(watch({ calls: 41, baselineMicros: 12_400_000, costMicros: 6_200_000 }))).toBeNull();
    expect(routeSaved(watch({ routed: none }))).toBeNull();
    expect(routeSaved(watch({ routed: { calls: 3, unpricedCalls: 3, baselineMicros: 0, costMicros: 0 } }))).toBeNull();
    // With none there is no row: the page is as it was.
    expect(row(5_000_000, null)).toBe('');
  });

  it('adds the two and shows each part, the estimate said as one', () => {
    const t = row(5_000_000, watch({ routed: { calls: 10, unpricedCalls: 0, baselineMicros: 9_000_000, costMicros: 3_000_000 } }));
    expect(t).toContain('Saved in total $11.00 · $5.00 from less input sent and caching · $6.00 from Model routing (estimate)');
    expect(t).toContain('Model routing is an estimate until enough runs are measured: the same calls at the two models’ list prices. WhiteRoom doesn’t charge for it.');
  });

  it('marks the figure as a lower bound when some routed calls or runs had no price', () => {
    const some = watch({ routed: { calls: 10, unpricedCalls: 2, baselineMicros: 9_000_000, costMicros: 3_000_000 } });
    expect(routeSaved(some)).toMatchObject({ partial: true });
    expect(row(5_000_000, some)).toContain('Saved in total $11.00+ · $5.00 from less input sent and caching · $6.00 from Model routing+ (estimate)');
    // A measured figure leaves an unpriced run out of both sides: it is not a lower bound, and a loss is never shown with a "+".
    expect(routeSaved(watch({ net: { routed: arm(40), control: arm(30), unpricedPeriods: 3, savedMicros: -3_000_000 } }))).toEqual({ micros: -3_000_000, measured: true, partial: false, partOfFleet: false });
  });

  it('says so when the measured figure covers only part of the fleet', () => {
    const part = watch({ net: { routed: arm(40), control: arm(30), unpricedPeriods: 0, savedMicros: 4_000_000, groups: { measured: 1, waiting: 2 } } });
    expect(routeSaved(part)).toMatchObject({ measured: true, partOfFleet: true });
    expect(row(5_000_000, part)).toContain('It covers part of your fleet so far: the rest needs more runs. WhiteRoom doesn’t charge for it.');
    const whole = watch({ net: { routed: arm(40), control: arm(30), unpricedPeriods: 0, savedMicros: 4_000_000, groups: { measured: 3, waiting: 0 } } });
    expect(row(5_000_000, whole)).not.toContain('part of your fleet');
  });

  it('a measured loss comes off the total, and a total below zero is said as one', () => {
    const net = (savedMicros: number) => watch({ net: { routed: arm(40), control: arm(30), unpricedPeriods: 0, savedMicros } });
    const t = row(5_000_000, net(-2_000_000));
    expect(t).toContain('Saved in total $3.00 · $5.00 from less input sent and caching · $2.00 more spent by Model routing');
    expect(t).not.toContain('(estimate)');
    expect(t).toContain('Model routing is measured against runs left on the model asked for, over whole days, so it can cover a little more than the range shown. WhiteRoom doesn’t charge for it.');
    expect(row(1_000_000, net(-4_000_000))).toContain('Saved in total −$3.00 ·');
  });
});

describe('the routed row, once the measured figure is showing', () => {
  it('no longer points to an estimate in the total: the total uses the measured figure', () => {
    const routed = { calls: 10, unpricedCalls: 0, baselineMicros: 9_000_000, costMicros: 3_000_000 };
    const arm = (periods: number) => ({ periods, calls: periods * 10, costMicros: 1, failedCalls: 0, refusedCalls: 0 });
    const base = { calls: 0, unpricedCalls: 0, baselineMicros: 0, costMicros: 0, routed };
    expect(text(render(base))).toContain('Until enough runs are measured, the difference is the estimate in Saved in total');
    expect(text(render({ ...base, net: { routed: arm(4), control: arm(3), unpricedPeriods: 0, savedMicros: null } }))).toContain('Until enough runs are measured');
    const measured = text(render({ ...base, net: { routed: arm(40), control: arm(30), unpricedPeriods: 0, savedMicros: 4_000_000 } }));
    expect(measured).not.toContain('Until enough runs are measured');
    expect(measured).toContain('The same usage at list prices.');
  });
});
