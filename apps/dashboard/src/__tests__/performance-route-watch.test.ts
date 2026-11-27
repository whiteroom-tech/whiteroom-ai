// Performance › Rules: Model routing's row in Watch. The calls that could use
// a cheaper model and what they cost at each, apart from what rules caught.
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
  renderToStaticMarkup(h(RulesSummary, { counts: governanceCounts([]), rules, unavailable: false, routeWatch }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('Model routing on Performance', () => {
  it('shows the calls, what they cost as sent and on the cheaper model, and that it isn’t a saving', () => {
    const html = render({ calls: 41, unpricedCalls: 0, baselineMicros: 12_400_000, costMicros: 6_200_000 });
    expect(text(html)).toContain('Model routing 41 calls could use a cheaper model · $12.40 as sent, $6.20 on the cheaper model Watch');
    expect(text(html)).toContain('The same usage at list prices. Nothing was changed, so this isn’t a saving.');
    // The one rule opens from the row.
    expect(html).toContain('href="/controls?rule=gr_route"');
    // What rules caught is still its own line, and these calls aren't in it.
    expect(text(html)).toContain('0 blocked · 0 would have acted');
  });

  it('says how many calls had no price, and gives no dollars when none had one', () => {
    expect(text(render({ calls: 5, unpricedCalls: 2, baselineMicros: 3_000_000, costMicros: 1_500_000 }))).toContain('5 calls could use a cheaper model · $3.00 as sent, $1.50 on the cheaper model · 2 not priced');
    const none = text(render({ calls: 1, unpricedCalls: 1, baselineMicros: 0, costMicros: 0 }));
    expect(none).toContain('1 call could use a cheaper model · 1 not priced');
    expect(none).not.toContain('$');
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
