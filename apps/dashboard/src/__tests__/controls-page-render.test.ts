// @vitest-environment happy-dom
// The redesigned Controls page in a DOM (spec Rev 1, D1), with the engine
// mocked: rules as sentences in Enforcing / Watching / Off, the agent filter,
// Save sending only what changed after the Enforce preview, the Discard and
// Remove dialogs.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { GovernanceRule } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// <dialog> in happy-dom: open/close is enough for these tests.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
}

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  useSearchParams: () => nav.params,
}));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'f1', authKey: 'k', resetSession: vi.fn() }) }));
vi.mock('@/lib/control-actors', async (orig) => ({ ...(await orig<typeof import('@/lib/control-actors')>()), fetchControlActors: async () => [] }));

const base = { fleetId: 'f1', version: 1, changedBy: 'test', changedAt: '2026-10-20T00:00:00Z' };
const RULES: GovernanceRule[] = [
  { ...base, id: 'r1', ruleType: 'loop_breaker', mode: 'enforce', response: 'block', appliesTo: 'all', params: { threshold: 100, scope: 'run', ignoreTools: [] } },
  { ...base, id: 'r2', ruleType: 'model_allowlist', mode: 'watch', response: 'block', appliesTo: ['market-researcher'], params: { allowedModels: ['claude-haiku-4-5-20251001'] } },
  { ...base, id: 'r3', ruleType: 'spend_cap', mode: 'watch', response: 'block', appliesTo: 'all', params: { dailyCap: 190, scope: 'day', unit: 'dollars' } },
  { ...base, id: 'r4', ruleType: 'spend_cap', mode: 'watch', response: 'block', appliesTo: 'all', params: { dailyCap: 200, scope: 'day', unit: 'dollars' } },
  { ...base, id: 'r5', ruleType: 'call_rate', mode: 'enforce', response: 'block', appliesTo: ['lead-agent'], params: { maxCalls: 60 } },
  { ...base, id: 'r6', ruleType: 'tool_list', mode: 'off', response: 'block', appliesTo: 'all', params: { blockedTools: [] } },
];
const api = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(async () => ({ success: true })),
  create: vi.fn(),
}));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  governanceList: async () => ({ fleetId: 'f1', rules: RULES, history: [], agents: ['lead-agent', 'market-researcher'], govV1: false }),
  ruleWouldAct: async (_f: string, ruleId: string) => ({ fleetId: 'f1', ruleId, byAgent: {}, unversioned: false, since: '2026-10-21T00:00:00Z' }),
  ruleActions: async () => ({ fleetId: 'f1', totals: { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 5 }, byAgent: {}, byRule: { loop_breaker: { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 } } }),
  performanceIndex: async () => { throw new Error('no store'); },
  performanceFleetHourly: async () => { throw new Error('no store'); },
  governanceUpdateRule: api.update,
  governanceDeleteRule: api.remove,
  governanceCreateRule: api.create,
}));

const { default: ControlsPage } = await import('@/app/(citadel)/controls/page');

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(ControlsPage)); });
  await flush();
  const text = () => el.textContent ?? '';
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const row = (needle: string) => [...el.querySelectorAll('button.gov-row')].find((b) => b.textContent?.includes(needle)) as HTMLButtonElement;
  const click = async (b: Element | undefined) => { expect(b, 'button').toBeTruthy(); await act(async () => { (b as HTMLElement).click(); }); await flush(); };
  return { el, root, text, button, row, click };
}

beforeEach(() => { nav.params = new URLSearchParams(); nav.replace.mockClear(); api.update.mockReset(); api.remove.mockClear(); document.body.innerHTML = ''; });

describe('Controls page', () => {
  it('reads each rule as a sentence, grouped by what it does now, with the cards and the overlap', async () => {
    const m = await mount();
    const groups = [...m.el.querySelectorAll('.wr-panel__title')].map((t) => t.textContent);
    expect(groups).toEqual(['Enforcing', 'Watching', 'Off']);
    expect(m.text()).toContain('When an agent makes the same call 100 times in a run, block the call.');
    expect(m.text()).toContain('Only market-researcher');
    // Stat cards, as Performance counts rule actions.
    expect(m.text()).toMatch(/Enforcing2Loop breaker, Call rate/);
    expect(m.text()).toMatch(/Rule actions\s*7/);
    // The one Loop breaker gets its own count; the $200 cap never acts.
    expect(m.row('100 times').textContent).toContain('2 blocked · last 7 days');
    expect(m.row('$200').textContent).toContain('Never acts: the $190 cap acts first');
    expect(m.text()).toContain('Your $200 cap will never act.');
    expect(m.text()).toContain('Pick a rule to change it');
    m.root.unmount();
  });

  it('the Agent filter shows the rules that govern that agent: the fleet-wide ones and its own', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    const m = await mount();
    expect(m.text()).toContain('60 calls in a minute');
    expect(m.text()).not.toContain('Only allow');
    expect((m.el.querySelector('select[aria-label="Agent"]') as HTMLSelectElement).value).toBe('lead-agent');
    m.root.unmount();
  });

  it('Save sends only what changed, after the Enforce preview', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row('Only allow'));
    expect(m.button('Save')!.disabled).toBe(true);
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Enforce')));
    expect(m.button('Save')!.disabled).toBe(false);
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Enforce the Model allowlist rule?');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Enforce rule'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', { mode: 'enforce' }, 'k');
    expect(m.text()).toContain('Saved. Model allowlist now enforces.');
    m.root.unmount();
  });

  it('switching rules with unsaved changes asks first', async () => {
    const m = await mount();
    await m.click(m.row('$190'));
    const input = m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '150');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(m.button('Save')!.disabled).toBe(false);
    await m.click(m.row('100 times'));
    expect(m.text()).toContain('Discard your changes to Spend cap?');
    await m.click(m.button('Keep editing'));
    expect(input.value).toBe('150');
    m.root.unmount();
  });

  it('Remove asks first, then deletes', async () => {
    const m = await mount();
    await m.click(m.row('100 times'));
    await m.click(m.button('Remove rule'));
    expect(m.text()).toContain('Remove the Loop breaker rule?');
    expect(api.remove).not.toHaveBeenCalled();
    const dialogs = [...m.el.querySelectorAll('dialog[open]')];
    await m.click([...dialogs.at(-1)!.querySelectorAll('button')].find((b) => b.textContent === 'Remove rule'));
    expect(api.remove).toHaveBeenCalledWith('f1', 'r1', 'k');
    m.root.unmount();
  });
});
