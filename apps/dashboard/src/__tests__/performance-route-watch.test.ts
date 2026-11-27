// Performance › Rules: Model routing's rows. The calls that could use a cheaper
// model (Watch) and the ones that went to one (Enforce), with what they cost at
// each model, apart from what rules caught.
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RulesSummary } from '@/app/(citadel)/performance/_components/RulesSummary';
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
  });

  it('shows the calls that went to a cheaper model on their own row, and never as a saving', () => {
    const none = { calls: 0, unpricedCalls: 0, baselineMicros: 0, costMicros: 0 };
    const routed = text(render({ ...none, routed: { calls: 12, unpricedCalls: 1, baselineMicros: 8_000_000, costMicros: 3_000_000 } }));
    expect(routed).toContain('Model routing 12 calls went to a cheaper model · $8.00 on the model asked for, $3.00 on the cheaper model · 1 not priced Enforce');
    expect(routed).toContain('The same usage at list prices. It isn’t counted in what WhiteRoom saved.');
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

  describe('the measured line', () => {
    const none = { calls: 0, unpricedCalls: 0, baselineMicros: 0, costMicros: 0 };
    const net = (routed: number, control: number, savedMicros: number | null, unpricedPeriods = 0) => ({ ...none, net: { routed: { periods: routed, calls: routed * 10, costMicros: 1 }, control: { periods: control, calls: control * 10, costMicros: 1 }, unpricedPeriods, savedMicros } });

    it('says what routing saved against the runs it left alone, and that it isn’t counted in savings', () => {
      const t = text(render(net(40, 30, 12_400_000)));
      expect(t).toContain('Model routing · measured $12.40 saved · 40 routed runs, 30 left on the model asked for');
      expect(t).toContain('What routed runs cost against runs left on the model asked for. It isn’t counted in what WhiteRoom saved.');
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
