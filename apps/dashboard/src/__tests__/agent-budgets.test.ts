// Per-agent budgets: the helpers behind Cost prediction's Save and its
// "Also add a Spend cap at this amount" (the card's flows are in cost-prediction.test).
import { describe, expect, it } from 'vitest';
import type { GovernanceRule } from '@/lib/whiteroom/types';
import { capRuleFor, existingCap, parseBudget, refusalText } from '@/lib/agent-budgets';

const cap = (appliesTo: string[] | 'all', dailyCap: number, unit: 'dollars' | 'tokens' = 'dollars') =>
  ({ id: `gr_${dailyCap}`, ruleType: 'spend_cap', mode: 'watch', response: 'block', appliesTo, params: { dailyCap, scope: 'day', unit } }) as unknown as GovernanceRule;

describe('agent budget helpers', () => {
  it('reads an amount in dollars, above 0 and up to the cap', () => {
    expect(parseBudget('25')).toBe(25);
    expect(parseBudget(' $12.5 ')).toBe(12.5);
    expect(parseBudget('1,000')).toBe(1000);
    // Plain dollars and cents only.
    for (const bad of ['', '0', '-3', 'ten', '2000000', '1e5', '0x10', '.5e1', '0.001']) expect(parseBudget(bad)).toBeNull();
  });

  it('builds a Spend cap for just that agent, in Record only, and finds one already there', () => {
    expect(capRuleFor('lead-agent', 10)).toEqual({ ruleType: 'spend_cap', mode: 'watch', response: 'block', params: { dailyCap: 10, scope: 'day', unit: 'dollars' }, appliesTo: ['lead-agent'] });
    expect(existingCap([cap(['lead-agent'], 10)], 'lead-agent', 10)?.id).toBe('gr_10');
    // Not the same cap: other amount, other agents too, fleet-wide, or in tokens.
    expect(existingCap([cap(['lead-agent'], 20), cap(['lead-agent', 'writer'], 10), cap('all', 10), cap(['lead-agent'], 10, 'tokens')], 'lead-agent', 10)).toBeNull();
  });

  it('says the engine’s refusals a person can act on in plain words, and never its own text', () => {
    expect(refusalText('There’s no agent lead-agent in this fleet.')).toBe('That agent isn’t in this fleet.');
    expect(refusalText("There's no agent a-1 in this fleet.")).toBe('That agent isn’t in this fleet.');
    expect(refusalText('A fleet can have at most 30 rules.')).toBe('This fleet already has the most rules it can have. Remove one in Controls first.');
    expect(refusalText('budget_usd must be a number above 0 and at most 1000000, or null to clear it.')).toBeNull();
    expect(refusalText(undefined)).toBeNull();
  });

});
