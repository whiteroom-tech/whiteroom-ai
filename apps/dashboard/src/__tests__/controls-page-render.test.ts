// @vitest-environment happy-dom
// The redesigned Controls page in a DOM (spec Rev 1, D1), with the engine
// mocked: rules as sentences in Blocking / Record only / Off, the agent filter,
// Save sending only what changed after the Enforce preview, the Discard and
// Remove dialogs.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { GovernanceRule } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import './support/dialog';

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
  { ...base, id: 'r2', ruleType: 'model_allowlist', mode: 'watch', response: 'block', appliesTo: ['market-researcher'], params: { allowedModels: ['claude-haiku-4-5-20251001'] }, sourceRecommendationId: 'rec_old' },
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
  /** Rules the mocked engine saved, listed in place of RULES' own. */
  saved: {} as Record<string, GovernanceRule>,
  /** Rules the mocked engine created, listed after RULES. */
  created: [] as GovernanceRule[],
  govV1: false,
  /** Models the fleet used lately, for the allowlist suggestion; null: no data. */
  models: null as string[] | null,
  /** Holds governance_list until resolved, to see the page before it loads. */
  listGate: null as Promise<void> | null,
  /** What Settings › Alerts has; null: an engine without alerts. */
  alerts: { slack: null, teams: null } as { slack: { ending: string } | null; teams?: { ending: string } | null } | null,
  history: [] as Array<{ id: string; ruleId: string; ruleType: string; description: string; by: string; time: string; before?: unknown; after?: unknown }>,
}));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  governanceList: async () => { api.lists++; if (api.listGate) await api.listGate; return { fleetId: 'f1', rules: [...RULES.map((r) => api.saved[r.id] ?? r), ...api.created], history: api.history, agents: ['lead-agent', 'market-researcher'], govV1: api.govV1 }; },
  performanceRecommendationGet: () => new Promise(() => {}),
  alertsGet: async () => api.alerts,
  ruleWouldAct: async (_f: string, ruleId: string) => ({ fleetId: 'f1', ruleId, byAgent: {}, unversioned: false, since: '2026-10-21T00:00:00Z' }),
  ruleActions: async () => ({ fleetId: 'f1', totals: { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 5 }, byAgent: {}, byRule: { loop_breaker: { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 } } }),
  performanceIndex: async () => { if (!api.models) throw new Error('no store'); return { summary: { models: api.models.map((model) => ({ model, calls: 3 })) } }; },
  performanceFleetHourly: async () => { if (!api.models) throw new Error('no store'); return { hourly: [] }; },
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
  api.update.mockReset(); api.remove.mockClear(); api.create.mockReset(); api.created = []; api.saved = {}; api.lists = 0; api.alerts = { slack: null, teams: null }; api.govV1 = false; api.models = null; api.listGate = null; api.history = [];
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
    expect(groups).toEqual(['Acting', 'Record only', 'Off']);
    expect(m.text()).toContain('When an agent makes the same call 100 times in a run, block the call.');
    expect(m.text()).toContain('Only market-researcher');
    // Stat cards, as Performance counts rule actions.
    expect(m.text()).toMatch(/Acting2Call rate, Loop breaker/);
    expect(m.text()).toMatch(/Rule activity\s*7/);
    const card = [...m.el.querySelectorAll('section[aria-label="Rules at a glance"] > *')].find((c) => c.textContent?.startsWith('Rule activity'))!;
    expect(card.textContent).toMatch(/· last 7 days$/);
    // The one Loop breaker gets its own count; the $200 cap never acts.
    expect(m.row('100 times').textContent).toContain('2 blocked · last 7 days');
    expect(m.row('$200').textContent).toContain('Would never act: the $190 cap would act first');
    expect(m.text()).toContain('Your $200 cap would never act. Both are in Record only');
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
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
    expect(m.button('Save')!.disabled).toBe(false);
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Turn on Block for the Model allowlist rule?');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Turn on Block'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', { mode: 'enforce', ifVersion: 1 }, 'k');
    expect(m.text()).toContain('Saved. Model allowlist now blocks.');
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

  it('on a phone, ‹ Controls shows the mode, and asks before leaving an unsaved change', async () => {
    const m = await mount();
    await m.click(m.row('Only allow'));
    const pill = () => m.el.querySelector('.gov-edhead__mode')!.textContent;
    expect(pill()).toBe('Record only');
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
    expect(pill()).toBe('Block · unsaved');
    expect(m.el.querySelector('.gov-actbar')!.classList.contains('is-dirty')).toBe(true);
    await m.click(m.button('‹ Controls'));
    expect(m.text()).toContain('Discard your changes to Model allowlist?');
    await m.click([...[...m.el.querySelectorAll('dialog[open]')].at(-1)!.querySelectorAll('button')].find((b) => b.textContent === 'Discard changes'));
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeFalsy();
    m.root.unmount();
  });

  it('Remove asks first, then deletes', async () => {
    const m = await mount();
    await m.click(m.row('100 times'));
    await m.click(m.button('Remove rule'));
    expect(m.text()).toContain('Remove the Loop breaker rule?');
    expect(m.text()).toContain('It stops right away.');
    expect(api.remove).not.toHaveBeenCalled();
    const dialogs = [...m.el.querySelectorAll('dialog[open]')];
    await m.click([...dialogs.at(-1)!.querySelectorAll('button')].find((b) => b.textContent === 'Remove rule'));
    expect(api.remove).toHaveBeenCalledWith('f1', 'r1', 'k');
    m.root.unmount();
  });
});

describe('Controls page, editing', () => {
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
    expect(m.text()).toContain('You also get an alert in your alert channel');
    await choose(m.el.querySelector('select[aria-label="What the rule does"]') as HTMLSelectElement, 'notify');
    expect(box()).toBeUndefined();
    await choose(m.el.querySelector('select[aria-label="What the rule does"]') as HTMLSelectElement, 'block');
    expect(box()!.checked).toBe(false);
    await m.click(box());
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r3', { alsoNotify: true, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('Stop needs a day in Watch first', async () => {
    api.govV1 = true;
    api.history = [{ id: 'h1', ruleId: 'r2', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'test', time: new Date(Date.now() - 60_000).toISOString() }];
    const m = await mount();
    await m.click(m.row('Only allow'));
    await choose(m.el.querySelector('select[aria-label="What the rule does"]') as HTMLSelectElement, 'stop');
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Run this rule in Record only for 24 hours before it can stop agents');
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
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Let this rule stop agents?');
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Stop the agent') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await type(dialog.querySelector('input') as HTMLInputElement, 'market-researcher');
    expect(confirm.disabled).toBe(false);
    await m.click(confirm);
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', { mode: 'enforce', response: 'stop', ifVersion: 1 }, 'k');
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

  it('a rule that can’t be added closes the dialog and says so', async () => {
    api.create.mockRejectedValueOnce(new Error('network down'));
    const m = await mount();
    await m.click(m.button('Add rule'));
    await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Limit calls per minute')));
    expect(m.el.querySelector('dialog[open] #add-rule-title')).toBeNull();
    expect(m.text()).toMatch(/Couldn’t add the rule/);
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeFalsy();
    m.root.unmount();
  });

  it('a save the engine refuses because the rule changed elsewhere says so and reloads', async () => {
    const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
    api.update.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 409', 409));
    const m = await mount();
    await m.click(m.row('$190'));
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    const before = api.lists;
    await m.click(m.button('Save'));
    expect(m.text()).toContain('This rule changed somewhere else, so your edit wasn’t saved.');
    expect(api.lists).toBeGreaterThan(before);
    // The stale edit is gone, so a second Save can't overwrite the other change.
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('190');
    expect(m.button('Save')!.disabled).toBe(true);
    m.root.unmount();
  });

  it('a save the engine refuses says why, so the person knows what to change', async () => {
    const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
    api.update.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 400', 400, 'keywords entries must be 1-50 characters.'));
    const m = await mount();
    await m.click(m.row('$190'));
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Couldn’t save the rule. Keywords entries must be 1-50 characters.');
    expect(m.text()).not.toContain('may not have been saved');
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

describe('Controls page, suggestions, removing and filtering', () => {
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
    // The rule came from the suggestion, and says so.
    expect(m.text()).toContain('From a Diagnosis suggestion');
    m.root.unmount();
  });

  it('the overlap banner removes the cap that never acts, after asking', async () => {
    const m = await mount();
    await m.click(m.button('Remove the $200 cap'));
    expect(m.text()).toContain('Remove the Spend cap rule?');
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    expect(dialog.textContent).toContain('$200');
    // A cap in Watch isn't acting, so removing it stops only the watching.
    expect(dialog.textContent).toContain('It stops recording right away.');
    await m.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Remove rule'));
    expect(api.remove).toHaveBeenCalledWith('f1', 'r4', 'k');
    m.root.unmount();
  });

  it('"Add to your allowlist" asks before throwing away an edit to the allowlist, then reopens it from the saved rule', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all' }; // a fleet-wide allowlist in Watch takes the models
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.saved[id], ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row('Only allow'));
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
    expect(m.button('Save')!.disabled).toBe(false);
    await m.click(m.button('Add to your allowlist'));
    expect(m.text()).toContain('Discard your changes to Model allowlist?');
    expect(api.update).not.toHaveBeenCalled();
    await m.click([...[...m.el.querySelectorAll('dialog[open]')].at(-1)!.querySelectorAll('button')].find((b) => b.textContent === 'Discard changes'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', expect.objectContaining({ mode: 'watch', params: { allowedModels: ['gpt-4o', 'claude-haiku-4-5-20251001'] } }), 'k');
    // The editor is open on the rule as saved: nothing to save.
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeTruthy();
    expect(m.button('Save')!.disabled).toBe(true);
    m.root.unmount();
  });

  it('"Add to your allowlist" names what the allowlist leaves out, is busy until the list reloads, then says what it did', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all' }; // a fleet-wide allowlist in Watch takes the models
    let finish!: () => void;
    api.update.mockImplementation((_f: string, id: string, ch: Partial<GovernanceRule>) => new Promise((resolve) => {
      const rule = { ...api.saved[id], ...ch, version: 2 } as GovernanceRule;
      finish = () => { api.saved[id] = rule; resolve({ rule }); };
    }));
    const m = await mount();
    expect(m.text()).toContain('Your Model allowlist leaves out gpt-4o, which your fleet used in the last 14 days. With it added, the allowlist would have stopped 0 calls.');
    expect(m.button('Add in Record only')).toBeUndefined();
    await m.click(m.button('Add to your allowlist'));
    const busy = [...m.el.querySelectorAll('button')].find((b) => b.textContent?.includes('Adding…')) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await act(async () => { busy.click(); });
    await act(async () => { finish(); });
    await flush();
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(m.text()).toContain('Added the models to your Model allowlist, in Record only.');
    expect(m.button('Add to your allowlist')).toBeUndefined();
    m.root.unmount();
  });

  it('an empty Tool list in Watch says it does nothing yet, in the warning colour', async () => {
    api.saved.r6 = { ...RULES[5], mode: 'watch' };
    const m = await mount();
    const stat = [...m.row('No tools picked yet.').querySelectorAll('span')].find((s) => s.textContent === 'Does nothing until you add a tool') as HTMLElement;
    expect(stat.style.color).toBe('var(--warn-tx)');
    m.root.unmount();
  });

  it('an Off allowlist that already has the models: "Turn on in Watch" puts it in Watch', async () => {
    api.models = ['claude-haiku-4-5-20251001'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all', mode: 'off' };
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.saved[id], ...ch, version: 2 } }));
    const m = await mount();
    expect(m.text()).toContain('Your Model allowlist is Off. In Record only, it would have stopped 0 calls in the last 14 days.');
    await m.click(m.button('Turn on in Record only'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', expect.objectContaining({ mode: 'watch', params: { allowedModels: ['claude-haiku-4-5-20251001'] } }), 'k');
    expect(m.text()).toContain('Turned your Model allowlist on in Record only.');
    m.root.unmount();
  });

  it('an Off allowlist missing a model: names it, says it goes to Watch, and adds it', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all', mode: 'off' };
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.saved[id], ...ch, version: 2 } }));
    const m = await mount();
    expect(m.text()).toContain('Your Model allowlist leaves out gpt-4o, which your fleet used in the last 14 days. With it added, the allowlist would have stopped 0 calls. It goes to Record only.');
    await m.click(m.button('Add to your allowlist'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', expect.objectContaining({ mode: 'watch', params: { allowedModels: ['gpt-4o', 'claude-haiku-4-5-20251001'] } }), 'k');
    expect(m.text()).toContain('Added the models to your Model allowlist, in Record only.');
    m.root.unmount();
  });

  it('"Add in Watch" leaves an enforcing allowlist and one for some agents as they are, and adds a new rule', async () => {
    api.models = ['gpt-4o'];
    api.created.push({ ...base, id: 'r7', ruleType: 'model_allowlist', mode: 'enforce', response: 'block', appliesTo: 'all', params: { allowedModels: ['claude-sonnet-4-5'] } });
    api.create.mockImplementation(async (_f: string, r: Partial<GovernanceRule>) => {
      const rule = { ...base, id: 'r8', response: 'block', appliesTo: 'all', ...r } as GovernanceRule;
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add in Record only'));
    expect(api.update).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledWith('f1', expect.objectContaining({ ruleType: 'model_allowlist', mode: 'watch', params: { allowedModels: ['gpt-4o'] } }), 'k');
    expect(m.text()).toContain('Added a Model allowlist in Record only.');
    m.root.unmount();
  });

  it('?agent= holds before the agents load, so Add rule starts the rule for that agent', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    let open!: () => void;
    api.listGate = new Promise<void>((r) => { open = r; });
    api.create.mockImplementation(async (_f: string, r: Partial<GovernanceRule>) => ({ rule: { ...base, id: 'n1', response: 'block', params: { maxCalls: 60 }, ...r } as GovernanceRule }));
    const m = await mount();
    expect((m.el.querySelector('select[aria-label="Agent"]') as HTMLSelectElement).value).toBe('lead-agent');
    await m.click(m.button('Add rule'));
    await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Limit calls per minute')));
    expect(api.create).toHaveBeenCalledWith('f1', { ruleType: 'call_rate', mode: 'watch', appliesTo: ['lead-agent'] }, 'k');
    await act(async () => { open(); });
    await flush();
    m.root.unmount();
  });

  it('while a save is in flight, the editor and the list wait; then the editor shows the saved rule', async () => {
    let finish!: () => void;
    api.update.mockImplementation((_f: string, id: string, ch: Partial<GovernanceRule>) => new Promise((resolve) => {
      const rule = { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 };
      finish = () => { api.saved[id] = rule; resolve({ rule }); };
    }));
    const m = await mount();
    await m.click(m.row('$190'));
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r3', { params: { dailyCap: 150, scope: 'day', unit: 'dollars' }, ifVersion: 1 }, 'k');
    expect((m.el.querySelector('aside[aria-label="Edit rule"] fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    // Picking another rule mid-save does nothing.
    await m.click(m.row('100 times'));
    expect(m.el.querySelector('input[aria-label="Spend limit"]')).toBeTruthy();
    await act(async () => { finish(); });
    await flush();
    expect(m.text()).toContain('Saved. Spend cap is in Record only.');
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('150');
    expect(m.button('Save')!.disabled).toBe(true);
    expect(m.text()).not.toContain('From a Diagnosis suggestion');
    m.root.unmount();
  });

  it('viewing one agent, Rule activity counts that agent’s', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    const m = await mount();
    const card = [...m.el.querySelectorAll('section[aria-label="Rules at a glance"] > *')].find((c) => c.textContent?.includes('Rule activity'))!;
    // The mocked engine's 2 blocks are fleet-wide, none of them lead-agent's.
    expect(card.textContent).toMatch(/^Rule activity\S*0none in the last 7 days$/);
    m.root.unmount();
  });

  it('changing the Agent filter asks about unsaved edits, and closes a rule the new filter hides', async () => {
    const m = await mount();
    const agent = () => m.el.querySelector('select[aria-label="Agent"]') as HTMLSelectElement;
    await m.click(m.row('Only allow'));
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
    await choose(agent(), 'lead-agent');
    expect(m.text()).toContain('Discard your changes to Model allowlist?');
    expect(nav.replace).not.toHaveBeenCalled();
    await m.click([...[...m.el.querySelectorAll('dialog[open]')].at(-1)!.querySelectorAll('button')].find((b) => b.textContent === 'Discard changes'));
    expect(nav.replace).toHaveBeenCalledWith('/controls?agent=lead-agent');
    // The allowlist covers market-researcher only, so its editor closes.
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeFalsy();
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

describe('Controls page, change log', () => {
  const snap = (dailyCap: number, mode = 'watch') => ({ mode, response: 'block', alsoNotify: false, appliesTo: 'all', params: { dailyCap, scope: 'day', unit: 'dollars' } });
  const when = new Date(Date.now() - 60_000).toISOString();

  it('shows old and new for a settings change, and Undo fills in the old settings to save as a new change', async () => {
    api.history = [{ id: 'h1', ruleId: 'r3', ruleType: 'spend_cap', description: 'Settings updated', by: 'test', time: when, before: snap(150), after: snap(190) }];
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    expect(m.text()).toContain('Was: When an agent spends more than $150 in a day, it would block the call.');
    expect(m.text()).toContain('Now: When an agent spends more than $190 in a day, it would block the call.');
    await m.click(m.button('Undo this change'));
    expect(m.text()).toContain('The settings from before that change are filled in. Check them, then Save.');
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('150');
    // Nothing is sent until Save, and then it's an ordinary update over the current version.
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r3', expect.objectContaining({ params: { dailyCap: 150, scope: 'day', unit: 'dollars' }, ifVersion: 1 }), 'k');
    m.root.unmount();
  });

  it('offers no undo once the rule has changed again', async () => {
    api.history = [{ id: 'h1', ruleId: 'r3', ruleType: 'spend_cap', description: 'Settings updated', by: 'test', time: when, before: snap(150), after: snap(170) }];
    const m = await mount();
    expect(m.text()).toContain('Was: When an agent spends more than $150');
    expect(m.button('Undo this change')).toBeUndefined();
    m.root.unmount();
  });

  it('adds a removed rule back as a new rule in Record only', async () => {
    api.history = [{ id: 'h2', ruleId: 'gone', ruleType: 'spend_cap', description: 'Removed Spend cap rule', by: 'test', time: when, before: snap(500, 'enforce'), after: null }];
    api.create.mockImplementation(async (_f: string, r: Record<string, unknown>) => { const rule = { ...base, id: 'r9', ...r }; api.created.push(rule as GovernanceRule); return { rule }; });
    const m = await mount();
    await m.click(m.button('Add it back'));
    expect(api.create).toHaveBeenCalledWith('f1', expect.objectContaining({ ruleType: 'spend_cap', mode: 'watch', response: 'block', params: { dailyCap: 500, scope: 'day', unit: 'dollars' }, appliesTo: 'all' }), 'k');
    expect(m.text()).toContain('Spend cap is back, in Record only. Turn on Block when you’re ready.');
    m.root.unmount();
  });
});

describe('Keywords in the editor', () => {
  const keywordRule = (over: Partial<GovernanceRule> = {}): GovernanceRule => ({
    ...base, id: 'k1', ruleType: 'keyword', mode: 'watch', response: 'notify', appliesTo: 'all',
    params: { keywords: ['Project Falcon'], where: 'incoming', wholeWord: true }, ...over,
  });

  it('turning on an alert-only rule asks to turn it on, not to block', async () => {
    api.created.push(keywordRule());
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule(), ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row('“Project Falcon”'));
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Turn on the Keywords rule?');
    expect(m.button('Turn on Block')).toBeUndefined();
    await m.click(m.button('Turn it on'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', expect.objectContaining({ mode: 'enforce' }), 'k');
    expect(m.text()).toContain('Saved. Keywords is now on.');
    m.root.unmount();
  });

  it('changes where it looks, removes a keyword, and won’t add a blank or a repeat in any case', async () => {
    api.created.push(keywordRule({ params: { keywords: ['Project Falcon', 'Orion'], where: 'incoming', wholeWord: true } }));
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule(), ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row('“Project Falcon”'));
    const where = m.el.querySelector('select[aria-label="Where to look"]') as HTMLSelectElement;
    expect([...where.options].map((o) => o.textContent)).toEqual(['Incoming data', 'A model reply', 'Incoming data or a reply']);
    expect(m.text()).not.toContain('Replies on Bedrock can’t be checked yet.');
    await choose(where, 'both');
    expect(m.text()).toContain('Replies on Bedrock can’t be checked yet.');
    await m.click(m.el.querySelector('button[aria-label="Remove Orion"]')!);
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')!.textContent).not.toContain('“Orion”');
    const input = m.el.querySelector('input[aria-label="Keyword or phrase"]') as HTMLInputElement;
    await type(input, '   ');
    expect(m.button('Add')!.disabled).toBe(true);
    await type(input, 'project FALCON');
    expect(m.button('Add')!.disabled).toBe(true);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(m.el.querySelectorAll('button[aria-label^="Remove "]').length).toBe(1);
    // The text stays, and says why it wasn't added.
    expect(input.value).toBe('project FALCON');
    expect(m.text()).toContain('That keyword is already in the list.');
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', { params: { keywords: ['Project Falcon'], where: 'both', wholeWord: true }, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('a list the engine hid can’t be edited here, but the rule can still be turned off', async () => {
    api.created.push(keywordRule({ mode: 'watch', params: { keywords: [], where: 'incoming', wholeWord: true, keywordCount: 3 } }));
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule(), ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row('3 hidden keywords'));
    expect(m.text()).toContain('3 keywords are hidden here. Reload the page to see and change them.');
    expect(m.el.querySelector('input[aria-label="Keyword or phrase"]')).toBeNull();
    expect((m.el.querySelector('select[aria-label="Where to look"]') as HTMLSelectElement).disabled).toBe(true);
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.trim() === 'Off'));
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', { mode: 'off', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('adds a keyword with Enter and saves the list', async () => {
    api.created.push(keywordRule());
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule(), ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row('“Project Falcon”'));
    const input = m.el.querySelector('input[aria-label="Keyword or phrase"]') as HTMLInputElement;
    await type(input, 'Orion');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(m.text()).toContain('“Orion”');
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', { params: { keywords: ['Project Falcon', 'Orion'], where: 'incoming', wholeWord: true }, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('says when an alerting rule has nowhere to send alerts: not with Slack or Teams, nor on an engine without alerts', async () => {
    const warns = async () => {
      const m = await mount();
      await m.click(m.row('“Project Falcon”'));
      await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
      const said = m.text().includes('No alert channel is connected');
      m.root.unmount();
      return said;
    };
    api.created.push(keywordRule());
    expect(await warns()).toBe(true);
    api.alerts = { slack: { ending: 'mnop' }, teams: null };
    expect(await warns()).toBe(false);
    api.alerts = { slack: null, teams: { ending: '2345' } };
    expect(await warns()).toBe(false);
    // An engine without alerts: nothing to say either way.
    api.alerts = null;
    expect(await warns()).toBe(false);
  });

  it('blocking incoming data needs a day in Watch first', async () => {
    api.created.push(keywordRule({ response: 'block' }));
    api.history = [{ id: 'h1', ruleId: 'k1', ruleType: 'keyword', description: 'Added new Keywords rule', by: 'test', time: new Date(Date.now() - 60_000).toISOString() }];
    const m = await mount();
    await m.click(m.row('“Project Falcon”'));
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('before it can block calls on incoming data');
    expect(api.update).not.toHaveBeenCalled();
    m.root.unmount();
  });

  it('after a day, blocking incoming data is confirmed by typing who it covers', async () => {
    api.created.push(keywordRule({ response: 'block' }));
    api.history = [{ id: 'h1', ruleId: 'k1', ruleType: 'keyword', description: 'Added new Keywords rule', by: 'test', time: new Date(Date.now() - 2 * 86_400_000).toISOString() }];
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule({ response: 'block' }), ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row('“Project Falcon”'));
    await m.click([...m.el.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Block')));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Let this rule block calls on incoming data?');
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    await type(dialog.querySelector('input') as HTMLInputElement, 'block all agents');
    await m.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Block on incoming data'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', { mode: 'enforce', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('Add a rule offers Flag keywords, marked New', async () => {
    const m = await mount();
    const option = [...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Flag keywords'));
    expect(option?.textContent).toContain('Keywords');
    expect(option?.querySelector('.wr-tag')?.textContent).toBe('New');
    m.root.unmount();
  });
});
