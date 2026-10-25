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
// The Diagnosis suggestion draft, stood in for: it finishes by calling onDone, as the real one does.
vi.mock('@/app/(citadel)/controls/_components/SuggestionDraft', async () => {
  const { createElement } = await import('react');
  return {
    SuggestionDraft: ({ onDone }: { onDone: (ruleId: string, message: string) => void }) =>
      createElement('section', { 'aria-label': 'Suggestion draft' }, 'Suggestion draft', createElement('button', { type: 'button', onClick: () => onDone('r2', 'Added Model allowlist in Watch.') }, 'Finish suggestion')),
  };
});
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
  lists: 0,
  /** Rules the mocked engine created, listed after RULES. */
  created: [] as GovernanceRule[],
  govV1: false,
  history: [] as Array<{ id: string; ruleId: string; ruleType: string; description: string; by: string; time: string }>,
}));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  governanceList: async () => { api.lists++; return { fleetId: 'f1', rules: [...RULES, ...api.created], history: api.history, agents: ['lead-agent', 'market-researcher'], govV1: api.govV1 }; },
  performanceRecommendationGet: () => new Promise(() => {}),
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

beforeEach(() => {
  nav.params = new URLSearchParams(); nav.replace.mockClear(); nav.push.mockClear();
  api.update.mockReset(); api.remove.mockClear(); api.create.mockReset(); api.created = []; api.lists = 0; api.govV1 = false; api.history = [];
  document.body.innerHTML = '';
});
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};

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

describe('Controls page, more paths', () => {
  it('switching a spend cap between dollars and tokens converts the limit', async () => {
    const m = await mount();
    await m.click(m.row('$190'));
    await choose(m.el.querySelector('select[aria-label="Limit unit"]') as HTMLSelectElement, 'tokens');
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('63333333');
    m.root.unmount();
  });

  it('retyping the same value isn’t a change', async () => {
    const m = await mount();
    await m.click(m.row('$190'));
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '190.0');
    expect(m.button('Save')!.disabled).toBe(true);
    m.root.unmount();
  });

  it('"Also send me an alert" shows for Block, is saved, and clears for other responses', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row('$190'));
    const box = () => [...m.el.querySelectorAll('label')].find((l) => l.textContent?.includes('Also send me an alert'))?.querySelector('input') as HTMLInputElement | undefined;
    await m.click(box());
    expect(m.text()).toContain('You also get a Slack message');
    await choose(m.el.querySelector('select[aria-label="What the rule does"]') as HTMLSelectElement, 'notify');
    expect(box()).toBeUndefined();
    await choose(m.el.querySelector('select[aria-label="What the rule does"]') as HTMLSelectElement, 'block');
    expect(box()!.checked).toBe(false);
    await m.click(box());
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r3', { alsoNotify: true }, 'k');
    m.root.unmount();
  });

  it('Stop needs a day in Watch first', async () => {
    api.govV1 = true;
    api.history = [{ id: 'h1', ruleId: 'r2', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'test', time: new Date(Date.now() - 60_000).toISOString() }];
    const m = await mount();
    await m.click(m.row('Only allow'));
    await choose(m.el.querySelector('select[aria-label="What the rule does"]') as HTMLSelectElement, 'stop');
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Enforce')));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Run this rule in Watch for 24 hours before it can stop agents');
    expect(api.update).not.toHaveBeenCalled();
    m.root.unmount();
  });

  it('after a day in Watch, Stop is confirmed by typing who it covers', async () => {
    api.govV1 = true;
    api.history = [{ id: 'h1', ruleId: 'r2', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'test', time: new Date(Date.now() - 2 * 86_400_000).toISOString() }];
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row('Only allow'));
    await choose(m.el.querySelector('select[aria-label="What the rule does"]') as HTMLSelectElement, 'stop');
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Enforce')));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Let this rule stop agents?');
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Stop the agent') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await type(dialog.querySelector('input') as HTMLInputElement, 'market-researcher');
    expect(confirm.disabled).toBe(false);
    await m.click(confirm);
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', { mode: 'enforce', response: 'stop' }, 'k');
    m.root.unmount();
  });

  it('Add rule starts the rule in Watch, for the agent being viewed', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    api.create.mockImplementation(async (_f: string, r: { ruleType: GovernanceRule['ruleType']; mode: GovernanceRule['mode']; appliesTo?: GovernanceRule['appliesTo'] }) => {
      const rule: GovernanceRule = { ...base, id: 'new', ruleType: r.ruleType, mode: r.mode, response: 'block', appliesTo: r.appliesTo ?? 'all', params: { maxCalls: 60 } };
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add rule'));
    await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Limit calls per minute')));
    expect(api.create).toHaveBeenCalledWith('f1', { ruleType: 'call_rate', mode: 'watch', appliesTo: ['lead-agent'] }, 'k');
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeTruthy();
    m.root.unmount();
  });

  it('a failed save says so, keeps the edit, and reloads the rules', async () => {
    api.update.mockRejectedValue(new Error('network down'));
    const m = await mount();
    await m.click(m.row('$190'));
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    const before = api.lists;
    await m.click(m.button('Save'));
    expect(m.text()).toMatch(/Couldn’t save the rule/);
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('150');
    expect(api.lists).toBeGreaterThan(before);
    m.root.unmount();
  });

  it('a link elsewhere asks before throwing away an edit, and goes there on Discard', async () => {
    const m = await mount();
    await m.click(m.row('$190'));
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    const a = document.createElement('a');
    a.href = '/runs';
    a.textContent = 'Runs';
    document.body.appendChild(a);
    await m.click(a);
    expect(m.text()).toContain('Discard your changes to Spend cap?');
    expect(nav.push).not.toHaveBeenCalled();
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    await m.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Discard changes'));
    expect(nav.push).toHaveBeenCalledWith('/runs');
    m.root.unmount();
  });

  it('a Diagnosis suggestion (?rec=) takes the right column; picking a rule closes it', async () => {
    nav.params = new URLSearchParams('rec=rec_123');
    const m = await mount();
    expect(m.text()).toContain('Suggestion draft');
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeNull();
    await m.click(m.row('100 times'));
    expect(nav.replace).toHaveBeenCalledWith('/controls');
    m.root.unmount();
  });
});

describe('Controls page, review round 2', () => {
  it('finishing a Diagnosis suggestion opens the new rule in the editor', async () => {
    nav.params = new URLSearchParams('rec=rec_123');
    const m = await mount();
    await m.click(m.button('Finish suggestion'));
    nav.params = new URLSearchParams(); // the page replaced ?rec= away
    await act(async () => { m.root.render(h(ControlsPage)); });
    await flush();
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeTruthy();
    expect(m.text()).toContain('Only allow these models:');
    expect(m.text()).toContain('Added Model allowlist in Watch.');
    m.root.unmount();
  });

  it('the overlap banner removes the cap that never acts, after asking', async () => {
    const m = await mount();
    await m.click(m.button('Remove the $200 cap'));
    expect(m.text()).toContain('Remove the Spend cap rule?');
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    expect(dialog.textContent).toContain('$200');
    await m.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Remove rule'));
    expect(api.remove).toHaveBeenCalledWith('f1', 'r4', 'k');
    m.root.unmount();
  });

  it('a failed remove keeps the rule and the editor open, and says so', async () => {
    api.remove.mockRejectedValueOnce(new Error('network down'));
    const m = await mount();
    await m.click(m.row('100 times'));
    await m.click(m.button('Remove rule'));
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    await m.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Remove rule'));
    expect(m.text()).toMatch(/Couldn’t remove the rule/);
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeTruthy();
    expect(m.row('100 times')).toBeTruthy();
    m.root.unmount();
  });
});
