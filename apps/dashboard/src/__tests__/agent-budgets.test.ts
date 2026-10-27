// @vitest-environment happy-dom
// Performance › Budgets per agent: the helpers, and the card's flows with a
// stand-in engine — set a budget, "Also block at this amount" adds a Spend
// cap in Record only (once), remove, and refusals said plainly.
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentBudgetForecast, GovernanceRule } from '@/lib/whiteroom/types';
import { callsLeftText, capRuleFor, existingCap, parseBudget } from '@/lib/agent-budgets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AgentBudgetsSection } = await import('@/app/(citadel)/performance/_components/AgentBudgets');

const forecast = (o: Partial<AgentBudgetForecast> = {}): AgentBudgetForecast => ({ agentId: 'lead-agent', budgetUsd: 10, spentTodayUsd: 2, burnRateUsdPerHour: 1, callsLeft: 8, callsLeftReason: 'available', ...o });
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

  it('says the calls left, or why there is no figure', () => {
    expect(callsLeftText(forecast())).toBe('8 calls left today');
    expect(callsLeftText(forecast({ callsLeft: 1 }))).toBe('1 call left today');
    expect(callsLeftText(forecast({ callsLeft: null, callsLeftReason: 'no_history' }))).toBe('No priced calls yet to estimate from');
    expect(callsLeftText(forecast({ callsLeft: null, callsLeftReason: 'partial_coverage' }))).toBe('Some of today’s calls have no price yet');
  });

  it('builds a Spend cap for just that agent, in Record only, and finds one already there', () => {
    expect(capRuleFor('lead-agent', 10)).toEqual({ ruleType: 'spend_cap', mode: 'watch', response: 'block', params: { dailyCap: 10, scope: 'day', unit: 'dollars' }, appliesTo: ['lead-agent'] });
    expect(existingCap([cap(['lead-agent'], 10)], 'lead-agent', 10)?.id).toBe('gr_10');
    // Not the same cap: other amount, other agents too, fleet-wide, or in tokens.
    expect(existingCap([cap(['lead-agent'], 20), cap(['lead-agent', 'writer'], 10), cap('all', 10), cap(['lead-agent'], 10, 'tokens')], 'lead-agent', 10)).toBeNull();
  });
});

function fakeApi(start: AgentBudgetForecast[] = [], rules: GovernanceRule[] = []) {
  let budgets = [...start];
  const api = {
    list: vi.fn(async () => ({ fleetId: 'f1', budgetPeriod: 'day' as const, budgetTimeZone: 'UTC', agents: budgets })),
    set: vi.fn(async (_f: string, agentId: string, usd: number | null) => {
      budgets = budgets.filter((b) => b.agentId !== agentId);
      if (usd !== null) budgets.push(forecast({ agentId, budgetUsd: usd, spentTodayUsd: 0 }));
    }),
    rules: vi.fn(async () => rules),
    addCap: vi.fn(async (_f: string, agentId: string, usd: number) => cap([agentId], usd)),
  };
  return api;
}

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

async function mount(api: ReturnType<typeof fakeApi>, agentIds: string[] = ['lead-agent', 'writer']) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(AgentBudgetsSection, { fleetId: 'f1', agentIds, api })); });
  await flush();
  const type = async (v: string) => {
    const input = el.querySelector('input[aria-label="Daily budget in dollars"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const pick = async (agent: string) => {
    const select = el.querySelector('select[aria-label="Agent"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, agent);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const check = async () => { await act(async () => { (el.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); }); };
  const submit = async () => { await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); }); await flush(); };
  const note = () => el.querySelector('[role="status"], [role="alert"]')?.textContent ?? '';
  return { el, root, type, pick, check, submit, note };
}

describe('Budgets per agent card', () => {
  it('lists each budget against today’s spend, with the calls left', async () => {
    const m = await mount(fakeApi([forecast(), forecast({ agentId: 'writer', budgetUsd: 1, spentTodayUsd: 1.5, callsLeft: 0 })]));
    const rows = [...m.el.querySelectorAll('.wr-agent-budget')].map((r) => r.textContent);
    expect(rows[0]).toContain('lead-agent');
    expect(rows[0]).toContain('of $10.00 today');
    expect(rows[0]).toContain('8 calls left today');
    expect(rows[1]).toContain('Over today’s budget');
    m.root.unmount();
  });

  it('sets a budget only: no rule is added', async () => {
    const api = fakeApi();
    const m = await mount(api);
    await m.pick('writer');
    await m.type('25');
    await m.submit();
    expect(api.set).toHaveBeenCalledWith('f1', 'writer', 25, undefined);
    expect(api.addCap).not.toHaveBeenCalled();
    expect(m.note()).toContain('Budget for writer set to $25.00 a day.');
    expect(m.el.textContent).toContain('writer');
    m.root.unmount();
  });

  it('"Also block at this amount" adds a Spend cap for that agent in Record only, and links to it', async () => {
    const api = fakeApi();
    const m = await mount(api);
    await m.type('10');
    await m.check();
    await m.submit();
    expect(api.addCap).toHaveBeenCalledWith('f1', 'lead-agent', 10, undefined);
    expect(m.note()).toContain('Added a Spend cap for lead-agent at this amount, in Record only');
    expect(m.el.querySelector('a[href="/controls?rule=gr_10"]')).toBeTruthy();
    m.root.unmount();
  });

  it('doesn’t add the same cap twice', async () => {
    const api = fakeApi([], [cap(['lead-agent'], 10)]);
    const m = await mount(api);
    await m.type('10');
    await m.check();
    await m.submit();
    expect(api.addCap).not.toHaveBeenCalled();
    expect(m.note()).toContain('A Spend cap at this amount is already set for lead-agent.');
    m.root.unmount();
  });

  it('refuses a bad amount without asking the engine, and says why a refused save failed', async () => {
    const api = fakeApi();
    const m = await mount(api);
    await m.type('abc');
    await m.submit();
    expect(api.set).not.toHaveBeenCalled();
    expect(m.note()).toContain('Enter an amount in dollars');
    api.set.mockRejectedValueOnce(Object.assign(new Error('HTTP 400'), { reason: 'There’s no agent lead-agent in this fleet.' }));
    await m.type('5');
    await m.submit();
    expect(m.note()).toBe('Not saved: There’s no agent lead-agent in this fleet.');
    m.root.unmount();
  });

  it('Remove clears a budget and says a Spend cap stays', async () => {
    const api = fakeApi([forecast()]);
    const m = await mount(api);
    await act(async () => { (m.el.querySelector('button[aria-label="Remove the budget for lead-agent"]') as HTMLButtonElement).click(); });
    await flush();
    expect(api.set).toHaveBeenCalledWith('f1', 'lead-agent', null, undefined);
    expect(m.note()).toContain('Any Spend cap for it stays in Controls.');
    m.root.unmount();
  });

  it('stays hidden on an engine without per-agent budgets', async () => {
    const api = fakeApi();
    api.list.mockRejectedValue(Object.assign(new Error('HTTP 400'), { status: 400, reason: 'Unknown action.' }));
    const m = await mount(api);
    expect(m.el.textContent).toBe('');
    m.root.unmount();
  });

  it('says when the budgets can’t be loaded, rather than hiding the card', async () => {
    const api = fakeApi();
    api.list.mockRejectedValue(Object.assign(new Error('HTTP 503'), { status: 503 }));
    const m = await mount(api);
    expect(m.el.textContent).toContain('Couldn’t load the budgets. Retrying…');
    m.root.unmount();
  });

  it('a budget saved but a cap that fails says exactly that', async () => {
    const api = fakeApi();
    api.addCap.mockRejectedValueOnce(Object.assign(new Error('HTTP 400'), { reason: 'A fleet can have at most 30 rules.' }));
    const m = await mount(api);
    await m.type('10');
    await m.check();
    await m.submit();
    expect(api.set).toHaveBeenCalledWith('f1', 'lead-agent', 10, undefined);
    expect(m.note()).toBe('Budget for lead-agent set to $10.00 a day. The Spend cap wasn’t added: A fleet can have at most 30 rules. Add it in Controls, or set the budget again with the box ticked.');
    expect(m.note()).not.toContain('Not saved');
    m.root.unmount();
  });

  it('a Remove that fails says so and keeps the budget', async () => {
    const api = fakeApi([forecast()]);
    api.set.mockRejectedValueOnce(new Error('HTTP 503'));
    const m = await mount(api);
    await act(async () => { (m.el.querySelector('button[aria-label="Remove the budget for lead-agent"]') as HTMLButtonElement).click(); });
    await flush();
    expect(m.note()).toBe('Couldn’t remove the budget for lead-agent. Try again.');
    expect(m.el.querySelector('.wr-agent-budget')?.textContent).toContain('lead-agent');
    m.root.unmount();
  });

  it('a save still running when the fleet changes leaves the new fleet’s card usable and quiet', async () => {
    let release!: () => void;
    const api = fakeApi();
    api.set.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const m = await mount(api);
    await m.type('10');
    await act(async () => { (m.el.querySelector('form') as HTMLFormElement).requestSubmit(); });
    expect(m.el.textContent).toContain('Saving…');
    await act(async () => { m.root.render(h(AgentBudgetsSection, { fleetId: 'f2', agentIds: ['other'], api })); });
    await act(async () => { release(); });
    await flush();
    expect(m.el.textContent).not.toContain('Saving…');
    expect(m.note()).toBe('');
    m.root.unmount();
  });
});

