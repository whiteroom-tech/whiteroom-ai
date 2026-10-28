// @vitest-environment happy-dom
// Performance › Cost prediction: the what-if math and wording, and the card's
// flows with a stand-in engine — folded by default, one agent at a time, live
// "≈ N model calls" as you type, Save (with the optional Spend cap), and an
// older engine without the per-agent prediction.
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentBudgetForecast, AgentBudgetsResult, GovernanceRule } from '@/lib/whiteroom/types';
import {
  agentCostLine, allowsText, budgetsNote, defaultAgent, firstToRunOut, hasPrediction, parseTokenBudget, pickableAgents, todayLine, unitsAllowed, unitWord,
} from '@/lib/cost-prediction';
import { capRuleFor } from '@/lib/agent-budgets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never) }));

const { CostPredictionSection } = await import('@/app/(citadel)/performance/_components/CostPrediction');

const agent = (agentId: string, o: Partial<AgentBudgetForecast> = {}): AgentBudgetForecast => ({
  agentId, budgetUsd: null, budgetTokens: null, spentTodayUsd: 0, tokensToday: 0, callsLeft: null, callsLeftReason: 'no_budget',
  taskType: null, costPerTaskUsd: 0.01, tokensPerTask: 1_000, tasksLeft: null, limitedBy: null, tasksLeftReason: 'no_budget', ...o,
});
const res = (agents: AgentBudgetForecast[], newer = true): AgentBudgetsResult => ({ fleetId: 'f1', budgetPeriod: 'day', budgetTimeZone: 'UTC', ...(newer && { unit: 'call', rateLookbackHours: 336 }), agents });

describe('cost prediction helpers', () => {
  it('says model calls for the engine’s unit, never tasks it can’t count', () => {
    expect(unitWord('call')).toBe('model call');
    expect(unitWord(undefined)).toBe('model call');
    expect(unitWord('task')).toBe('task');
    expect(hasPrediction(res([]))).toBe(true);
    expect(hasPrediction(res([], false))).toBe(false);
  });

  it('works out what an amount allows at the agent’s rate, and which runs out first', () => {
    expect(unitsAllowed(20, 0.0081)).toBe(2469);
    expect(unitsAllowed(0.08, 0.01)).toBe(8); // not 7 from a float quotient
    expect(unitsAllowed(20, null)).toBeNull();
    expect(unitsAllowed(null, 0.01)).toBeNull();
    expect(allowsText(1, 'model call')).toBe('≈ 1 model call');
    expect(allowsText(2469, 'model call')).toBe('≈ 2,469 model calls');
    expect(firstToRunOut(10, 20)).toBe('The dollar budget runs out first.');
    expect(firstToRunOut(30, 20)).toBe('The token limit runs out first.');
    expect(firstToRunOut(20, 20)).toBe('Both run out at about the same time.');
    expect(firstToRunOut(20, null)).toBeNull();
  });

  it('reads a whole token limit, and nothing else', () => {
    expect(parseTokenBudget('10,000,000')).toBe(10_000_000);
    for (const bad of ['', '0', '1.5', '1e6', '-4', '20000000000']) expect(parseTokenBudget(bad)).toBeNull();
  });

  it('names the agent’s cost per working hour when the engine sends it, and per call honestly labelled', () => {
    expect(agentCostLine(agent('a', { burnRateUsdPerHour: 0.354, costPerTaskUsd: 0.0081 }), 'model call', 336)).toBe('$0.354 an hour while it works · $0.0081 a model call · last 14 days');
    expect(agentCostLine(agent('a', { costPerTaskUsd: 0.0081 }), 'model call', undefined)).toBe('$0.0081 a model call');
    expect(agentCostLine(agent('a', { costPerTaskUsd: null }), 'model call', 336)).toBeNull();
  });

  it('says today against a saved budget, from the newer or the older engine’s figure', () => {
    expect(todayLine(agent('a'), 'model call')).toBeNull();
    expect(todayLine(agent('a', { budgetUsd: 20, spentTodayUsd: 0.42, tasksLeft: 2417, tasksLeftReason: null }), 'model call')).toBe('$0.420 spent today · ≈ 2,417 model calls left');
    expect(todayLine(agent('a', { budgetUsd: 2, spentTodayUsd: 2.31 }), 'model call')).toBe('$2.31 spent today · over today’s budget');
    const older: AgentBudgetForecast = { agentId: 'a', budgetUsd: 5, spentTodayUsd: 1, callsLeft: 40, callsLeftReason: 'available' };
    expect(todayLine(older, 'model call')).toBe('$1.00 spent today · ≈ 40 model calls left');
  });

  it('lists every agent the engine sends, plus traffic agents for an older engine, and starts on one with a budget', () => {
    const newer = pickableAgents(res([agent('b'), agent('a', { budgetUsd: 3 })]), ['zz']);
    expect(newer.map((a) => a.agentId)).toEqual(['a', 'b']);
    expect(defaultAgent(newer)).toBe('a');
    const older = pickableAgents(res([{ agentId: 'b', budgetUsd: 5, spentTodayUsd: 0, callsLeft: 1, callsLeftReason: 'available' }], false), ['c', '', 'b']);
    expect(older.map((a) => a.agentId)).toEqual(['b', 'c']);
    expect(defaultAgent([agent('x'), agent('y')])).toBe('x');
    expect(budgetsNote(newer)).toBe('1 agent with a budget');
    expect(budgetsNote([agent('x')])).toBe('pick an agent to see what a budget allows');
  });
});

function fakeApi(start: AgentBudgetsResult, rules: GovernanceRule[] = []) {
  let current = start;
  const api = {
    list: vi.fn(async () => current),
    setBudget: vi.fn(async (_f: string, agentId: string, usd: number | null, _k?: string, tokens?: number | null) => {
      current = { ...current, agents: current.agents.map((a) => (a.agentId === agentId ? { ...a, budgetUsd: usd, budgetTokens: tokens ?? null } : a)) };
    }),
    rules: vi.fn(async () => rules),
    addCap: vi.fn(async (_f: string, agentId: string, usd: number) => ({ id: 'gr_new', ...capRuleFor(agentId, usd) }) as unknown as GovernanceRule),
  };
  return api;
}

async function mount(api: ReturnType<typeof fakeApi>) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(CostPredictionSection, { fleetId: 'f1', agentIds: null, api })); });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  const text = () => (el.textContent ?? '').replace(/\s+/g, ' ');
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.replace('›', '').trim().startsWith(label)) as HTMLButtonElement;
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const inputs = () => [...el.querySelectorAll('input.wr-input')] as HTMLInputElement[];
  const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  return { el, root, text, button, type, inputs, flush };
}

describe('Cost prediction card', () => {
  it('labels an agent with an hourly rate Hourly cost', async () => {
    const api = fakeApi(res([agent('code-reviewer', { burnRateUsdPerHour: 0.354, costPerTaskUsd: 0.0081 })]));
    const m = await mount(api);
    await act(async () => { m.button('Cost prediction').click(); });
    expect(m.text()).toMatch(/Hourly cost.*\$0\.354 an hour while it works/);
  });

  it('says an agent with no priced calls has no hourly cost to show yet', async () => {
    const api = fakeApi(res([agent('code-reviewer', { costPerTaskUsd: null, burnRateUsdPerHour: null })]));
    const m = await mount(api);
    await act(async () => { m.button('Cost prediction').click(); });
    expect(m.text()).toMatch(/Cost\s*No priced calls yet to estimate from\./);
  });

  it('starts folded; unfolded, it shows one agent and works out what a budget and a token limit allow as you type', async () => {
    const api = fakeApi(res([agent('code-reviewer', { costPerTaskUsd: 0.0081, tokensPerTask: 1221 }), agent('lead-agent')]));
    const m = await mount(api);
    expect(m.button('Cost prediction').getAttribute('aria-expanded')).toBe('false');
    expect(m.text()).toContain('pick an agent to see what a budget allows');
    await act(async () => { m.button('Cost prediction').click(); });
    expect((m.el.querySelector('select') as HTMLSelectElement).value).toBe('code-reviewer');
    expect(m.text()).toContain('$0.0081 a model call · last 14 days');
    // No hourly rate for this agent yet: its line is labelled Cost, not Hourly cost.
    expect(m.text()).toMatch(/Cost\s*\$0\.0081 a model call/);
    expect(m.text()).not.toContain('Hourly cost');
    expect(m.text()).toContain('Enter a budget to see how many model calls it allows.');
    const [usd, tok] = m.inputs();
    await m.type(usd, '20');
    expect(m.text()).toContain('≈ 2,469 model calls a day');
    await m.type(tok, '1000000');
    expect(m.text()).toContain('≈ 819 model calls a day');
    expect(m.text()).toContain('The token limit runs out first.');
    expect(m.text()).toContain('A budget never stops code-reviewer.');
    expect(m.text()).not.toMatch(/task/i);
    m.root.unmount();
  });

  it('saves the budget and token limit for that agent, and adds a Spend cap in Watch when asked', async () => {
    const api = fakeApi(res([agent('code-reviewer')]));
    const m = await mount(api);
    await act(async () => { m.button('Cost prediction').click(); });
    const [usd, tok] = m.inputs();
    await m.type(usd, '20');
    await m.type(tok, '500000');
    const box = m.el.querySelector('input[type=checkbox]') as HTMLInputElement;
    await act(async () => { box.click(); });
    await act(async () => { m.button('Save for').click(); });
    await m.flush();
    expect(api.setBudget).toHaveBeenCalledWith('f1', 'code-reviewer', 20, undefined, 500_000);
    expect(api.addCap).toHaveBeenCalledWith('f1', 'code-reviewer', 20, undefined);
    expect(m.text()).toContain('Saved for code-reviewer. Added a Spend cap at $20.00 a day, in Watch.');
    m.root.unmount();
  });

  it('won’t save a token limit without a dollar budget, and says so beside the field', async () => {
    const api = fakeApi(res([agent('code-reviewer')]));
    const m = await mount(api);
    await act(async () => { m.button('Cost prediction').click(); });
    await m.type(m.inputs()[1], '500000');
    expect(m.text()).toContain('≈ 500 model calls a day'); // the what-if works on its own
    await act(async () => { m.button('Save for').click(); });
    await m.flush();
    expect(api.setBudget).not.toHaveBeenCalled();
    expect(m.el.querySelector('[role=alert]')!.textContent).toContain('A token limit goes with a daily budget in dollars');
    expect(m.inputs()[0].getAttribute('aria-invalid')).toBe('true');
    m.root.unmount();
  });

  it('an older engine: no token limit, the agents from traffic, and nothing to compute without a rate', async () => {
    const api = fakeApi(res([{ agentId: 'lead-agent', budgetUsd: 5, spentTodayUsd: 1, callsLeft: 40, callsLeftReason: 'available' }], false));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(CostPredictionSection, { fleetId: 'f1', agentIds: ['writer'], api, defaultOpen: true })); });
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    const text = (el.textContent ?? '').replace(/\s+/g, ' ');
    expect(el.querySelectorAll('input.wr-input')).toHaveLength(1);
    expect([...el.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['lead-agent', 'writer']);
    expect(text).toContain('Shows once it has a few priced calls');
    expect(text).toContain('$1.00 spent today · ≈ 40 model calls left');
    root.unmount();
  });

  it('stays hidden on an engine without per-agent budgets', async () => {
    const api = fakeApi(res([]));
    api.list.mockRejectedValue(Object.assign(new Error('x'), { status: 400, reason: 'Unknown action.' }));
    const m = await mount(api);
    expect(m.el.innerHTML).toBe('');
    m.root.unmount();
  });
});
