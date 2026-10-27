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
  usePathname: () => '/controls',
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
  /** Hourly points the store returns (with models set). */
  hourly: [] as Array<{ hour: string; costMicros: number }>,
  /** Holds governance_list until resolved, to see the page before it loads. */
  listGate: null as Promise<void> | null,
  /** governance_list fails (an engine outage). */
  listFail: false,
  /** The fleet has no rules at all. */
  empty: false,
  /** rule_would_act's byAgent per rule id (default: none). */
  would: {} as Record<string, Record<string, number>>,
  /** Each agent's calls, as performance_agent returns them. */
  agentCalls: {} as Record<string, number>,
  /** What Settings › Alerts has; null: an engine without alerts. */
  alerts: { slack: null, teams: null } as { slack: { ending: string } | null; teams?: { ending: string } | null } | null,
  history: [] as Array<{ id: string; ruleId: string; ruleType: string; description: string; by: string; time: string; before?: unknown; after?: unknown }>,
}));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  governanceList: async () => { api.lists++; if (api.listFail) throw new Error('down'); if (api.listGate) await api.listGate; return { fleetId: 'f1', rules: api.empty ? [] : [...RULES.map((r) => api.saved[r.id] ?? r), ...api.created], history: api.history, agents: ['lead-agent', 'market-researcher'], govV1: api.govV1 }; },
  performanceRecommendationGet: () => new Promise(() => {}),
  alertsGet: async () => api.alerts,
  ruleWouldAct: async (_f: string, ruleId: string) => ({ fleetId: 'f1', ruleId, byAgent: api.would[ruleId] ?? {}, unversioned: false, since: '2026-10-21T00:00:00Z' }),
  performanceAgent: async (_f: string, agentId: string) => ({ fleetId: 'f1', agentId, hourly: [], totals: { calls: api.agentCalls[agentId] ?? 0, costMicros: 0 } }),
  auditIntegrity: async () => ({ fleetId: 'f1', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 2045, verifiedAt: new Date().toISOString(), prunedBeforeTracking: true, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } }),
  verifyAudit: async () => ({ valid: true, eventsVerified: 2045, message: '' }),
  ruleActions: async () => ({ fleetId: 'f1', totals: { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 5 }, byAgent: {}, byRule: { loop_breaker: { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 } } }),
  performanceIndex: async () => { if (!api.models) throw new Error('no store'); return { summary: { models: api.models.map((model) => ({ model, calls: 3 })) } }; },
  performanceFleetHourly: async () => { if (!api.models) throw new Error('no store'); return { hourly: api.hourly }; },
  governanceUpdateRule: api.update,
  governanceDeleteRule: api.remove,
  governanceCreateRule: api.create,
}));

const { default: ControlsPage } = await import('@/app/(citadel)/controls/page');
const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(ControlsPage)); });
  await flush();
  const text = () => el.textContent ?? '';
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const row = (needle: string) => [...el.querySelectorAll('button.ctl-row')].find((b) => b.textContent?.includes(needle)) as HTMLButtonElement;
  const click = async (b: Element | undefined) => { expect(b, 'button').toBeTruthy(); await act(async () => { (b as HTMLElement).click(); }); await flush(); };
  /** Picks a What happens option by its label. */
  const choice = (label: string) => [...el.querySelectorAll('label.ctl-choice')].find((l) => l.textContent?.startsWith(label))?.querySelector('input') as HTMLInputElement | undefined;
  /** Opens a rule, with When expanded for editing. */
  const open = async (needle: string) => { await click(row(needle)); const c = button('Change'); if (c) await click(c); };
  return { el, root, text, button, row, click, choice, open };
}

beforeEach(() => {
  nav.params = new URLSearchParams(); nav.replace.mockClear(); nav.push.mockClear();
  api.update.mockReset(); api.remove.mockClear(); api.create.mockReset(); api.created = []; api.saved = {}; api.lists = 0; api.alerts = { slack: null, teams: null }; api.govV1 = false; api.models = null; api.hourly = []; api.listGate = null; api.listFail = false; api.empty = false; api.would = {}; api.agentCalls = {}; api.history = [];
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
  it('reads each rule as its kind and condition, in cards by who it covers, with counts, mode tags and the overlap', async () => {
    const m = await mount();
    const titles = [...m.el.querySelectorAll('.ctl-card__title')].map((t) => t.textContent);
    expect(titles).toEqual(['Rules for all agents', 'Rules for specific agents', 'Off and not set up 1']);
    // Block rules come first in a card, with the one filled tag and the accent; Record only is a hollow dot.
    const all = [...m.el.querySelectorAll('.ctl-card')].find((p) => p.querySelector('.ctl-card__title')?.textContent === 'Rules for all agents')!;
    expect([...all.querySelectorAll('.ctl-row .ctl-mtag')].map((t) => t.textContent)).toEqual(['Block', 'Record only', 'Record only']);
    expect(all.querySelector('.ctl-mtag.is-block')?.textContent).toBe('Block');
    expect(all.querySelector('.ctl-row.is-block')?.textContent).toContain('Same call 100× in a run');
    expect(all.textContent).toContain('1 Block · 2 Record only · new agents get these too');
    // Specific agents are grouped under each agent's name.
    expect(m.text()).toContain('Only lead-agent, market-researcher have extra rules');
    expect([...m.el.querySelectorAll('.ctl-owner')].map((o) => o.textContent)).toEqual(['lead-agent1 rule', 'market-researcher1 rule']);
    // The lead line counts rules that are set up, and the week's rule activity; no number cards.
    expect(m.text()).toContain('5 rules · 2 Block · 3 Record only · 7 caught this week, 2 blocked');
    expect(m.el.querySelector('.wr-stat-card')).toBeNull();
    // The one Loop breaker gets its own count. Two caps in Record only don't overlap: neither acts.
    expect(m.row('100×').textContent).toContain('2 blocked · 7 days');
    expect(m.row('$200').textContent).not.toContain('Never triggers');
    expect(m.text()).toContain('Select a rule to edit it');
    expect(m.text()).toContain('New rules start as Record only.');
    m.root.unmount();
  });

  it('shows nothing that counts until the rules are read: no 0s while loading', async () => {
    let open!: () => void;
    api.listGate = new Promise<void>((r) => { open = r; });
    const m = await mount();
    expect(m.text()).toContain('Loading your rules…');
    expect(m.text()).not.toMatch(/\d+ rules ·/);
    expect(m.el.querySelector('.ctl-card')).toBeNull();
    await act(async () => { open(); });
    await flush();
    expect(m.text()).toContain('5 rules ·');
    m.root.unmount();
  });

  it('a failed load says so with Try again, not empty cards', async () => {
    api.listFail = true;
    const m = await mount();
    expect(m.text()).toContain('Couldn’t load your rules.');
    expect(m.text()).not.toContain('No rules cover every agent');
    expect(m.el.querySelector('.ctl-card__title')).toBeNull();
    api.listFail = false;
    await m.click(m.button('Try again'));
    expect(m.text()).toContain('Rules for all agents');
    m.root.unmount();
  });

  it('a fleet with no rules gets one empty state with Add rule', async () => {
    api.empty = true;
    const m = await mount();
    expect(m.text()).toContain('No rules yet');
    expect(m.el.querySelector('.ctl-lead')).toBeNull();
    expect(m.text()).not.toContain('Rules for all agents');
    await m.click([...m.el.querySelectorAll('.ctl-state button')][0]);
    expect(m.text()).toContain('Cap spending');
    m.root.unmount();
  });

  it('gathers the tips under Suggestions, and shows no card when there are none', async () => {
    // Two caps in Block for the same agents: the higher one never triggers.
    api.saved.r3 = { ...RULES[2], mode: 'enforce' };
    api.saved.r4 = { ...RULES[3], mode: 'enforce' };
    const m = await mount();
    expect(m.row('$200').textContent).toContain('Never triggers ($190 cap first)');
    const section = m.el.querySelector('section[aria-labelledby="gov-suggestions"]')!;
    expect(section.querySelector('h2')!.textContent).toBe('Suggestions 1');
    expect(section.textContent).toContain('$200 cap never triggers.');
    m.root.unmount();
    api.saved.r4 = { ...RULES[3], mode: 'off' };
    delete api.saved.r3;
    const none = await mount();
    expect(none.el.querySelector('section[aria-labelledby="gov-suggestions"]')).toBeNull();
    none.root.unmount();
  });

  it('says when no rule blocks, and says nothing when every rule is off', async () => {
    api.saved.r1 = { ...RULES[0], mode: 'watch' };
    api.saved.r5 = { ...RULES[4], response: 'notify' };
    const m = await mount();
    expect(m.el.querySelector('.ctl-amber')!.textContent).toBe('No rule blocks yet, so every call goes through.');
    m.root.unmount();
    for (const r of RULES) api.saved[r.id] = { ...r, mode: 'off' };
    const off = await mount();
    expect(off.el.querySelector('.ctl-amber')).toBeNull();
    off.root.unmount();
    // One active rule, and it stops calls: nothing to warn about.
    for (const r of RULES) api.saved[r.id] = r.id === 'r1' ? r : { ...r, mode: 'off' };
    const one = await mount();
    expect(one.el.querySelector('.ctl-amber')).toBeNull();
    one.root.unmount();
  });

  it('tags a Block-mode rule by what it does: an alert-only rule is never a filled Block', async () => {
    api.saved.r1 = { ...RULES[0], response: 'notify' };
    const m = await mount();
    const tag = m.row('100×').querySelector('.ctl-mtag')!;
    expect(tag.textContent).toBe('Alerts');
    expect(tag.className).not.toContain('is-block');
    m.root.unmount();
  });

  it('a rule with nothing picked yet sits in "Off and not set up", tagged Not set up', async () => {
    api.saved.r6 = { ...RULES[5], mode: 'enforce' };
    const m = await mount();
    expect(m.text()).toContain('1 not set up: tool list');
    await m.click(m.button('Show'));
    const row = m.row('No tools picked yet');
    expect(row.querySelector('.ctl-mtag')!.className).not.toContain('is-block');
    expect(row.querySelector('.ctl-mtag')!.textContent).toBe('Not set up');
    m.root.unmount();
  });

  it('picking an agent shows its own rules first, then the rules for all agents folded', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    const m = await mount();
    const titles = [...m.el.querySelectorAll('.ctl-card__title')].map((t) => t.textContent);
    expect(titles).toContain('Only for lead-agent');
    expect(m.text()).toContain('Also covered by 3 rules for all agents');
    expect(m.text()).not.toContain('Same call 100×');
    await m.click([...m.el.querySelectorAll('button.ctl-disc')][0]);
    expect(m.text()).toContain('Same call 100×');
    nav.params = new URLSearchParams();
    m.root.unmount();
  });

  it('an agent with no rules of its own offers to add one', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    api.saved.r5 = { ...RULES[4], appliesTo: ['market-researcher'] };
    const m = await mount();
    expect(m.text()).toContain('This agent follows the rules for all agents below.');
    await m.click(m.button('Add a rule for lead-agent'));
    expect(m.text()).toContain('Add a rule');
    nav.params = new URLSearchParams();
    m.root.unmount();
  });

  it('warns when at most one rule can actually stop calls, and when it acts', async () => {
    api.saved.r5 = { ...RULES[4], mode: 'watch' };
    const m = await mount();
    expect(m.el.querySelector('.ctl-amber')!.textContent).toBe('Only 1 rule blocks, and only after 100 repeated calls.');
    m.root.unmount();
  });

  it('the Agent filter shows the rules that govern that agent: the fleet-wide ones and its own', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    const m = await mount();
    expect(m.text()).toContain('Over 60 calls a minute');
    expect(m.text()).not.toContain('Only claude');
    expect((m.el.querySelector('select#ctl-cover') as HTMLSelectElement).value).toBe('lead-agent');
    m.root.unmount();
  });

  it('Save sends only what changed, after the Enforce preview, and Undo reverts it at once', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule> & { ifVersion: number }) => {
      const { ifVersion, ...rest } = ch;
      const rule = { ...(api.saved[id] ?? RULES.find((r) => r.id === id)!), ...rest, version: ifVersion + 1 } as GovernanceRule;
      api.saved[id] = rule;
      return { rule };
    });
    const m = await mount();
    await m.open('Only claude');
    expect(m.button('Save')!.disabled).toBe(true);
    await m.click(m.choice('Block the call'));
    expect(m.button('Save')!.disabled).toBe(false);
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Start blocking with this rule?');
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    expect(dialog.textContent).toContain('Would have blocked');
    expect(dialog.textContent).toContain('Recording since');
    expect(dialog.textContent).toContain('Applies to market-researcher');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Start blocking'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', { mode: 'enforce', ifVersion: 1 }, 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Saved. Model allowlist is blocking for market-researcher.');
    // Undo puts the settings from before straight back, over the version the save made: no second confirm.
    await m.click(m.button('Undo'));
    expect(m.el.querySelector('dialog[open]')).toBeNull();
    // Only what the save changed goes back, over the version it made.
    expect(api.update).toHaveBeenLastCalledWith('f1', 'r2', { mode: 'watch', ifVersion: 2, description: 'Undid the last change' }, 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Undone. Model allowlist is record only again.');
    expect(m.row('Only claude').querySelector('.ctl-mtag')!.textContent).toBe('Record only');
    m.root.unmount();
  });

  it('switching rules with unsaved changes asks first', async () => {
    const m = await mount();
    await m.open('$190');
    const input = m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '150');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(m.button('Save')!.disabled).toBe(false);
    await m.open('100×');
    expect(m.text()).toContain('Discard your changes to Spend cap?');
    await m.click(m.button('Keep editing'));
    expect(input.value).toBe('150');
    m.root.unmount();
  });

  it('on a phone, ‹ Controls shows the mode, and asks before leaving an unsaved change', async () => {
    const m = await mount();
    await m.open('Only claude');
    const pill = () => m.el.querySelector('.gov-edhead__mode')!.textContent;
    expect(pill()).toBe('Record only');
    await m.click(m.choice('Block the call'));
    expect(pill()).toBe('Blocks · unsaved');
    expect(m.el.querySelector('.gov-actbar')!.classList.contains('is-dirty')).toBe(true);
    await m.click(m.button('‹ Controls'));
    expect(m.text()).toContain('Discard your changes to Model allowlist?');
    await m.click([...[...m.el.querySelectorAll('dialog[open]')].at(-1)!.querySelectorAll('button')].find((b) => b.textContent === 'Discard changes'));
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeFalsy();
    m.root.unmount();
  });

  it('on a phone, Escape or the dimmed list closes the editor sheet; never on a desktop or under a dialog', async () => {
    const phone = { matches: true };
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-width: 720px)' && phone.matches, media: q, addEventListener() {}, removeEventListener() {} }));
    const escape = async () => { await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); await flush(); };
    const sheet = () => m.el.querySelector('aside[aria-label="Edit rule"]');
    const m = await mount();
    try {
      // A desktop: the editor is a side panel, and Escape leaves it alone.
      phone.matches = false;
      await m.open('Only claude');
      await escape();
      expect(sheet()).toBeTruthy();
      // A phone, nothing changed: Escape goes back.
      phone.matches = true;
      await escape();
      expect(sheet()).toBeFalsy();
      // An unsaved change: the dimmed list asks first, and Escape doesn't close the sheet under that dialog.
      await m.open('Only claude');
      await m.click(m.choice('Block the call'));
      await m.click(m.el.querySelector('.gov-scrim')!);
      expect(m.text()).toContain('Discard your changes to Model allowlist?');
      await escape();
      expect(sheet()).toBeTruthy();
      await m.click([...[...m.el.querySelectorAll('dialog[open]')].at(-1)!.querySelectorAll('button')].find((b) => b.textContent === 'Discard changes'));
      expect(sheet()).toBeFalsy();
    } finally {
      vi.unstubAllGlobals();
      m.root.unmount();
    }
  });

  it('on a phone the sheet is modal: the list behind is inert, focus starts on ‹ Controls and goes back on close', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-width: 720px)', media: q, addEventListener() {}, removeEventListener() {} }));
    const m = await mount();
    try {
      const list = m.el.querySelector('.ctl-main') as HTMLElement;
      const row = m.row('Only claude');
      row.focus();
      await m.click(row);
      expect(list.inert).toBe(true);
      expect(document.activeElement?.textContent).toBe('‹ Controls');
      await m.click(m.button('‹ Controls'));
      expect(list.inert).toBe(false);
      expect(document.activeElement?.textContent).toContain('Only claude');
    } finally {
      vi.unstubAllGlobals();
      m.root.unmount();
    }
  });

  it('Remove asks first, then deletes', async () => {
    const m = await mount();
    await m.open('100×');
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
    await m.open('$190');
    await choose(m.el.querySelector('select[aria-label="Limit unit"]') as HTMLSelectElement, 'tokens');
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('63333333');
    m.root.unmount();
  });

  it('retyping the same value isn’t a change', async () => {
    const m = await mount();
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '190.0');
    expect(m.button('Save')!.disabled).toBe(true);
    m.root.unmount();
  });

  it('"Also send me an alert" shows for Block, clears for Alert me, and leaving the actions puts the saved setting back', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.open('$190');
    const box = () => [...m.el.querySelectorAll('label')].find((l) => l.textContent?.includes('Also send me an alert'))?.querySelector('input') as HTMLInputElement | undefined;
    await m.click(m.choice('Block the call'));
    await m.click(box());
    await m.click(m.choice('Alert me'));
    expect(box()).toBeUndefined();
    await m.click(m.choice('Block the call'));
    expect(box()!.checked).toBe(false);
    await m.click(box());
    // Back to Record only: the saved settings return (nothing set while trying actions sticks)…
    await m.click(m.choice('Record only'));
    expect(box()!.checked).toBe(false);
    expect(m.button('Save')!.disabled).toBe(true);
    // …and the alert for when it blocks can be set in Record only too.
    await m.click(box());
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r3', { alsoNotify: true, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('Stop needs a day in Watch first', async () => {
    api.govV1 = true;
    api.history = [{ id: 'h1', ruleId: 'r2', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'test', time: new Date(Date.now() - 60_000).toISOString() }];
    const m = await mount();
    await m.open('Only claude');
    // Not an error after the fact: Stop can't be picked yet, and says from when.
    const stop = m.choice('Stop the agent')!;
    expect(stop.disabled).toBe(true);
    expect(stop.closest('label')!.textContent).toMatch(/Stop the agent · available from \d{1,2}:\d{2} [ap]m tomorrow \(needs 24 hours in Record only first\)/);
    expect(m.choice('Pause the agent')!.disabled).toBe(false);
    expect(api.update).not.toHaveBeenCalled();
    m.root.unmount();
  });

  it('after a day in Watch, Stop is confirmed by typing who it covers', async () => {
    api.govV1 = true;
    api.history = [{ id: 'h1', ruleId: 'r2', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'test', time: new Date(Date.now() - 2 * 86_400_000).toISOString() }];
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.open('Only claude');
    await m.click(m.choice('Stop the agent'));
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
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    const before = api.lists;
    await m.click(m.button('Save'));
    expect(m.text()).toContain('This rule changed somewhere else, so your edit wasn’t saved.');
    expect(api.lists).toBeGreaterThan(before);
    // The stale edit is gone, so a second Save can't overwrite the other change.
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')!.textContent).toContain('Spends more than $190 in a day');
    expect(m.button('Save')!.disabled).toBe(true);
    m.root.unmount();
  });

  it('a save the engine refuses says why, so the person knows what to change', async () => {
    const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
    api.update.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 400', 400, 'keywords entries must be 1-50 characters.'));
    const m = await mount();
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Couldn’t save the rule. Keywords entries must be 1-50 characters.');
    expect(m.text()).not.toContain('may not have been saved');
    m.root.unmount();
  });

  it('a failed save says so, keeps the edit, and reloads the rules', async () => {
    api.update.mockRejectedValue(new Error('network down'));
    const m = await mount();
    await m.open('$190');
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
    await m.open('$190');
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
    await m.open('100×');
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
    expect(m.text()).toContain('Uses a model other than claude-haiku-4-5-20251001');
    expect(m.text()).toContain('Added Model allowlist in Watch.');
    // The rule came from the suggestion, and says so.
    expect(m.text()).toContain('From a Diagnosis suggestion');
    m.root.unmount();
  });

  it('the overlap banner removes the cap that never acts, after asking', async () => {
    api.saved.r3 = { ...RULES[2], mode: 'enforce' };
    api.saved.r4 = { ...RULES[3], mode: 'enforce' };
    const m = await mount();
    await m.click(m.button('Remove $200 cap'));
    expect(m.text()).toContain('Remove the Spend cap rule?');
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    expect(dialog.textContent).toContain('$200');
    expect(dialog.textContent).toContain('It stops right away.');
    await m.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Remove rule'));
    expect(api.remove).toHaveBeenCalledWith('f1', 'r4', 'k');
    m.root.unmount();
  });

  it('"Add to your allowlist" asks before throwing away an edit to the allowlist, then reopens it from the saved rule', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all' }; // a fleet-wide allowlist in Watch takes the models
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.saved[id], ...ch, version: 2 } }));
    const m = await mount();
    await m.open('Only claude');
    await m.click(m.choice('Block the call'));
    expect(m.button('Save')!.disabled).toBe(false);
    await m.click(m.button('Add to allowlist…'));
    expect(m.text()).toContain('Discard your changes to Model allowlist?');
    expect(api.update).not.toHaveBeenCalled();
    await m.click([...[...m.el.querySelectorAll('dialog[open]')].at(-1)!.querySelectorAll('button')].find((b) => b.textContent === 'Discard changes'));
    // Then it confirms first, with what the change means.
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Allow for all agents'));
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
    expect(m.text()).toContain('Allowlist is missing gpt-4o, used in the last 14 days.');
    expect(m.button('Add allowlist…')).toBeUndefined();
    await m.click(m.button('Add to allowlist…'));
    expect([...m.el.querySelectorAll('dialog[open]')].at(-1)!.textContent).toContain('Allow gpt-4o?');
    expect([...m.el.querySelectorAll('dialog[open]')].at(-1)!.textContent).toContain('Calls to gpt-4o won’t be caught once it’s allowed.');
    await m.click(m.button('Allow for all agents'));
    const busy = [...m.el.querySelectorAll('button')].find((b) => b.textContent?.includes('Adding…')) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await act(async () => { busy.click(); });
    await act(async () => { finish(); });
    await flush();
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('gpt-4o allowed for all agents.');
    expect(m.button('Add to allowlist…')).toBeUndefined();
    m.root.unmount();
  });

  it('an empty Tool list in Watch says it does nothing yet, in the warning colour', async () => {
    api.saved.r6 = { ...RULES[5], mode: 'watch' };
    const m = await mount();
    await m.click(m.button('Show'));
    const stat = m.row('No tools picked yet').querySelector('.ctl-row__count')!;
    expect(stat.textContent).toBe('Does nothing until you add a tool');
    expect(stat.className).toContain('is-warn');
    m.root.unmount();
  });

  it('an Off allowlist that already has the models: "Turn on in Watch" puts it in Watch', async () => {
    api.models = ['claude-haiku-4-5-20251001'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all', mode: 'off' };
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.saved[id], ...ch, version: 2 } }));
    const m = await mount();
    expect(m.text()).toContain('Your Model allowlist is off. It has every model your fleet used in the last 14 days.');
    await m.click(m.button('Turn on in Record only…'));
    await m.click(m.button('Turn on in Record only'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', expect.objectContaining({ mode: 'watch', params: { allowedModels: ['claude-haiku-4-5-20251001'] } }), 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Turned your Model allowlist on in Record only.');
    m.root.unmount();
  });

  it('an Off allowlist missing a model: names it, says it goes to Watch, and adds it', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all', mode: 'off' };
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.saved[id], ...ch, version: 2 } }));
    const m = await mount();
    expect(m.text()).toContain('Allowlist is missing gpt-4o, used in the last 14 days.');
    await m.click(m.button('Add to allowlist…'));
    expect([...m.el.querySelectorAll('dialog[open]')].at(-1)!.textContent).toContain('Applies to all agents, in Record only.');
    await m.click(m.button('Allow for all agents'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', expect.objectContaining({ mode: 'watch', params: { allowedModels: ['gpt-4o', 'claude-haiku-4-5-20251001'] } }), 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('gpt-4o allowed for all agents.');
    m.root.unmount();
  });

  it('an allowlist in Block takes the model through the editor, where Save asks first; no second allowlist', async () => {
    api.models = ['gpt-4o'];
    api.created.push({ ...base, id: 'r7', ruleType: 'model_allowlist', mode: 'enforce', response: 'block', appliesTo: 'all', params: { allowedModels: ['claude-sonnet-4-5'] } });
    api.create.mockImplementation(async (_f: string, r: Partial<GovernanceRule>) => {
      const rule = { ...base, id: 'r8', response: 'block', appliesTo: 'all', ...r } as GovernanceRule;
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add to allowlist…'));
    expect(m.el.querySelector('dialog[open]')).toBeNull();
    expect(m.text()).toContain('gpt-4o is added below. Save to allow it; you’ll confirm first.');
    await m.click(m.button('Save'));
    expect([...m.el.querySelectorAll('dialog[open]')].at(-1)!.textContent).toContain('Also allows gpt-4o');
    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
    m.root.unmount();
  });

  it('?agent= holds before the agents load, so Add rule starts the rule for that agent', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    let open!: () => void;
    api.listGate = new Promise<void>((r) => { open = r; });
    api.create.mockImplementation(async (_f: string, r: Partial<GovernanceRule>) => ({ rule: { ...base, id: 'n1', response: 'block', params: { maxCalls: 60 }, ...r } as GovernanceRule }));
    const m = await mount();
    expect((m.el.querySelector('select#ctl-cover') as HTMLSelectElement).value).toBe('lead-agent');
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
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r3', { params: { dailyCap: 150, scope: 'day', unit: 'dollars' }, ifVersion: 1 }, 'k');
    expect((m.el.querySelector('aside[aria-label="Edit rule"] fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    // Picking another rule mid-save does nothing.
    await m.open('100×');
    expect(m.el.querySelector('input[aria-label="Spend limit"]')).toBeTruthy();
    await act(async () => { finish(); });
    await flush();
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Saved. Spend cap is record only for all agents.');
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('150');
    expect(m.button('Save')!.disabled).toBe(true);
    expect(m.text()).not.toContain('From a Diagnosis suggestion');
    m.root.unmount();
  });

  it('viewing one agent, the lead line counts that agent’s rules and rule activity', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    const m = await mount();
    // The mocked engine's 2 blocks are fleet-wide, none of them lead-agent's.
    expect(m.el.querySelector('.ctl-lead')!.textContent).toBe('4 rules · 2 Block · 2 Record only · 0 caught this week, 0 blocked');
    m.root.unmount();
  });

  it('changing the Agent filter asks about unsaved edits, and closes a rule the new filter hides', async () => {
    const m = await mount();
    const agent = () => m.el.querySelector('select#ctl-cover') as HTMLSelectElement;
    await m.open('Only claude');
    await m.click(m.choice('Block the call'));
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
    await m.open('100×');
    await m.click(m.button('Remove rule'));
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    await m.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Remove rule'));
    expect(m.text()).toMatch(/Couldn’t remove the rule/);
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeTruthy();
    expect(m.row('100×')).toBeTruthy();
    m.root.unmount();
  });
});

describe('Controls page, links in', () => {
  it('opens the rule a link names (?rule=), e.g. from a run’s Rule activity', async () => {
    nav.params = new URLSearchParams('rule=r3');
    const m = await mount();
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeTruthy();
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')!.textContent).toContain('Spends more than $190 in a day');
    nav.params = new URLSearchParams();
    m.root.unmount();
  });

  it('claims nothing about a linked rule when the rules couldn’t be read', async () => {
    api.listFail = true;
    nav.params = new URLSearchParams('rule=r3');
    const m = await mount();
    expect(m.text()).toContain('Couldn’t load your rules.');
    expect(m.text()).not.toContain('isn’t here any more');
    nav.params = new URLSearchParams();
    m.root.unmount();
  });

  it('opens a different rule when the link changes', async () => {
    nav.params = new URLSearchParams('rule=r3');
    const m = await mount();
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')!.textContent).toContain('$190 in a day');
    nav.params = new URLSearchParams('rule=r4');
    await act(async () => { m.root.render(h(ControlsPage)); });
    await flush();
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')!.textContent).toContain('$200 in a day');
    // Leaving the link and following the first one again opens it again.
    nav.params = new URLSearchParams();
    await act(async () => { m.root.render(h(ControlsPage)); });
    await flush();
    nav.params = new URLSearchParams('rule=r3');
    await act(async () => { m.root.render(h(ControlsPage)); });
    await flush();
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')!.textContent).toContain('$190 in a day');
    nav.params = new URLSearchParams();
    m.root.unmount();
  });

  it('asks before a new link throws away an unsaved edit', async () => {
    nav.params = new URLSearchParams('rule=r3');
    const m = await mount();
    await m.click(m.button('Change'));
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    nav.params = new URLSearchParams('rule=r4');
    await act(async () => { m.root.render(h(ControlsPage)); });
    await flush();
    expect(m.text()).toContain('Discard your changes to Spend cap?');
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('150');
    nav.params = new URLSearchParams();
    m.root.unmount();
  });

  it('says so when the linked rule has been removed', async () => {
    nav.params = new URLSearchParams('rule=gr_gone');
    const m = await mount();
    expect(m.text()).toContain('That rule isn’t here any more; it may have been removed.');
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeNull();
    nav.params = new URLSearchParams();
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
    // Recent changes is one line each, with who; the old and new sentences are in the rule's History.
    expect(m.text()).toContain('Spend cap · Settings updated · test');
    expect(m.text()).not.toContain('Was: When');
    await m.open('$190');
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
    await m.open('$190');
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
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Spend cap is back, in Record only. Turn on Block when you’re ready.');
    // Gone at once, before the log's own "added" line arrives: it can't be added twice.
    expect(m.button('Add it back')).toBeUndefined();
    m.root.unmount();
  });

  it('a failed Add it back says so and keeps offering it', async () => {
    api.history = [{ id: 'h3', ruleId: 'gone', ruleType: 'spend_cap', description: 'Removed Spend cap rule', by: 'test', time: when, before: snap(500, 'enforce'), after: null }];
    api.create.mockRejectedValue(new Error('boom'));
    const m = await mount();
    await m.click(m.button('Add it back'));
    expect(m.text()).toMatch(/add the rule back/i);
    expect(m.button('Add it back')).toBeTruthy();
    m.root.unmount();
  });

  it('What happens is one choice, with one line saying what the chosen option does', async () => {
    const m = await mount();
    await m.open('$190');
    const editor = () => m.el.querySelector('aside[aria-label="Edit rule"]')!.textContent ?? '';
    expect(editor()).toContain('Records what it would do and lets every call through.');
    expect((m.el.querySelector('select[aria-label="What Record only records"]') as HTMLSelectElement).value).toBe('block');
    await m.click(m.choice('Off'));
    expect(editor()).toContain('Does nothing and records nothing.');
    await m.click(m.choice('Block the call'));
    expect(editor()).toContain('That one call fails with a plain reason. The agent keeps going. You’ll confirm before it starts.');
    // No paragraphs: the fine print is behind When's ⓘ.
    expect(editor()).not.toContain('doesn’t happen yet');
    expect(m.el.querySelector('aside [aria-label^="What is this? Acts before the next call. Dollar limits are estimates."]')).toBeTruthy();
    m.root.unmount();
  });

  it('When is a sentence until Change, and a new rule opens with it expanded', async () => {
    api.create.mockImplementation(async (_f: string, r: Record<string, unknown>) => { const rule = { ...base, id: 'n1', response: 'block', appliesTo: 'all', params: { maxCalls: 60 }, ...r } as GovernanceRule; api.created.push(rule); return { rule }; });
    const m = await mount();
    await m.click(m.row('$190'));
    expect(m.el.querySelector('input[aria-label="Spend limit"]')).toBeNull();
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')!.textContent).toContain('Spends more than $190 in a day');
    await m.click(m.button('Change'));
    expect(m.el.querySelector('input[aria-label="Spend limit"]')).toBeTruthy();
    await m.click(m.button('Done'));
    expect(m.el.querySelector('input[aria-label="Spend limit"]')).toBeNull();
    await m.click(m.button('Close'));
    await m.click(m.button('Add rule'));
    await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Limit calls per minute')));
    expect(m.el.querySelector('input[aria-label="Calls per minute limit"]')).toBeTruthy();
    m.root.unmount();
  });

});

describe('Controls page, weakening a rule', () => {
  it('asks before it stops blocking, with keeping it as the main choice', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.open('100×');
    await m.click(m.choice('Record only'));
    await m.click(m.button('Save'));
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    expect(dialog.textContent).toContain('Stop blocking with this rule?');
    expect(dialog.textContent).toContain('Calls that match will go through for all agents. WhiteRoom will still record them.');
    expect(m.button('Keep blocking')!.className).toContain('wr-btn--primary');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Keep blocking'));
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Save'));
    await m.click(m.button('Switch to Record only'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r1', { mode: 'watch', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('says what a change weakens before saving it', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '500');
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Make the Spend cap rule weaker?');
    expect(m.text()).toContain('Limit: $190 → $500');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Keep it as it is'));
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Save'));
    await m.click(m.button('Save the change'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r3', { params: { dailyCap: 500, scope: 'day', unit: 'dollars' }, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('shows what the fleet really spends a day beside a dollars-a-day cap', async () => {
    api.models = ['claude-haiku-4-5-20251001'];
    const m = await mount();
    await m.open('$190');
    // The mocked store has no hourly points: the line stays out rather than claim $0.
    expect(m.text()).not.toContain('Your fleet spends about');
    m.root.unmount();
    // With 14 days of spend: about $12.50 a day; above $10 it's rounded.
    // Hours counted back from now, as the store returns them.
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    api.hourly = [{ hour: ago(13.5), costMicros: 100_000_000 }, { hour: ago(1), costMicros: 75_000_000 }];
    const m2 = await mount();
    await m2.open('$190');
    expect(m2.text()).toContain('Your fleet spends about $13 a day, all agents together (last 14 days).');
    m2.root.unmount();
    api.hourly = [{ hour: ago(1.5), costMicros: 4_000_000 }, { hour: ago(0.5), costMicros: 3_000_000 }];
    const m3 = await mount();
    await m3.open('$190');
    expect(m3.text()).toContain('Your fleet spends about $3.50 a day, all agents together (last 2 days).');
    m3.root.unmount();
    // Only beside a dollars-a-day cap: not per run, not in tokens.
    const m4 = await mount();
    await m4.open('$190');
    await choose(m4.el.querySelector('select[aria-label="Limit period"]') as HTMLSelectElement, 'run');
    expect(m4.text()).not.toContain('Your fleet spends about');
    await choose(m4.el.querySelector('select[aria-label="Limit period"]') as HTMLSelectElement, 'day');
    await choose(m4.el.querySelector('select[aria-label="Limit unit"]') as HTMLSelectElement, 'tokens');
    expect(m4.text()).not.toContain('Your fleet spends about');
    m4.root.unmount();
  });

  it('narrowing a rule for all agents can keep it and add a copy just for them', async () => {
    api.create.mockImplementation(async (_f: string, r: Record<string, unknown>) => { const rule = { ...base, id: 'r9', ...r }; api.created.push(rule as GovernanceRule); return { rule }; });
    const m = await mount();
    await m.open('$190');
    await choose(m.el.querySelector('select[aria-label="Which agents this rule applies to"]') as HTMLSelectElement, 'some');
    await choose(m.el.querySelector('select[aria-label="Add an agent"]') as HTMLSelectElement, 'lead-agent');
    // Another edit in the same draft (a higher limit) stays out of the copy.
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '500');
    await m.click(m.button('Save'));
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    expect(dialog.textContent).toContain('Who should this rule cover?');
    expect(dialog.textContent).toContain('Today it covers all 2 agents, and new agents get it too.');
    expect(dialog.textContent).toContain('Limit: $190 → $500');
    // Copy is the main choice; moving is the risky one and says who loses the rule.
    const copy = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Keep it for everyone, and add a copy just for lead-agent'))!;
    expect(copy.className).toContain('wr-btn--primary');
    expect([...dialog.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move it to lead-agent only'))!.textContent).toContain('1 agent will lose this rule');
    await m.click(copy);
    expect(api.create).toHaveBeenCalledWith('f1', expect.objectContaining({ ruleType: 'spend_cap', mode: 'watch', appliesTo: ['lead-agent'], params: { dailyCap: 190, scope: 'day', unit: 'dollars' } }), 'k');
    expect(api.update).not.toHaveBeenCalled();
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Added a Spend cap rule just for lead-agent, in Record only. Everyone else keeps the original.');
    // Copying again doesn't add a second, identical rule.
    await choose(m.el.querySelector('select[aria-label="Which agents this rule applies to"]') as HTMLSelectElement, 'some');
    await choose(m.el.querySelector('select[aria-label="Add an agent"]') as HTMLSelectElement, 'lead-agent');
    await m.click(m.button('Save'));
    await m.click([...m.el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Keep it for everyone, and add a copy')));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(m.text()).toContain('There’s already a copy for lead-agent.'.replace('’', "'"));
    // The limit edit is kept; only the narrowing is undone in the editor.
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('500');
    expect((m.el.querySelector('select[aria-label="Which agents this rule applies to"]') as HTMLSelectElement).value).toBe('all');
    m.root.unmount();
  });

  it('a failed copy says so and leaves the rule and the edit as they were', async () => {
    api.create.mockRejectedValue(new Error('down'));
    const m = await mount();
    await m.open('$190');
    await choose(m.el.querySelector('select[aria-label="Which agents this rule applies to"]') as HTMLSelectElement, 'some');
    await choose(m.el.querySelector('select[aria-label="Add an agent"]') as HTMLSelectElement, 'lead-agent');
    await m.click(m.button('Save'));
    await m.click([...m.el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Keep it for everyone, and add a copy')));
    expect(m.text()).toMatch(/add the copy/i);
    expect(api.update).not.toHaveBeenCalled();
    // The narrowed edit is still there to save or discard.
    expect(m.button('Save')!.disabled).toBe(false);
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
    await m.open('"Project Falcon"');
    await m.click(m.choice('Alert me'));
    await m.click(m.button('Save'));
    expect([...m.el.querySelectorAll('dialog[open]')].at(-1)!.textContent).toContain('Turn on alerts for this rule?');
    expect(m.button('Start blocking')).toBeUndefined();
    await m.click(m.button('Turn on alerts'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', expect.objectContaining({ mode: 'enforce' }), 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Saved. Keywords is on for all agents.');
    m.root.unmount();
  });

  it('changes where it looks, removes a keyword, and won’t add a blank or a repeat in any case', async () => {
    api.created.push(keywordRule({ params: { keywords: ['Project Falcon', 'Orion'], where: 'incoming', wholeWord: true } }));
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule(), ...ch, version: 2 } }));
    const m = await mount();
    await m.open('"Project Falcon"');
    const where = m.el.querySelector('select[aria-label="Where to look"]') as HTMLSelectElement;
    expect([...where.options].map((o) => o.textContent)).toEqual(['Incoming data', 'A model reply', 'Incoming data or a reply']);
    const hint = () => m.el.querySelector('aside .ctl-q [aria-label^="What is this?"]')?.getAttribute('aria-label') ?? '';
    expect(hint()).not.toContain('Replies on Bedrock can’t be checked yet.');
    await choose(where, 'both');
    expect(hint()).toContain('Replies on Bedrock can’t be checked yet.');
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
    // Removing a keyword weakens the rule: it says so first.
    expect(m.text()).toContain('Make the Keywords rule weaker?');
    expect(m.text()).toContain('No longer looks for “Orion”');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Save the change'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', { params: { keywords: ['Project Falcon'], where: 'both', wholeWord: true }, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('a list the engine hid can’t be edited here, but the rule can still be turned off', async () => {
    api.created.push(keywordRule({ mode: 'watch', params: { keywords: [], where: 'incoming', wholeWord: true, keywordCount: 3 } }));
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule(), ...ch, version: 2 } }));
    const m = await mount();
    await m.open('3 hidden keywords');
    expect(m.text()).toContain('3 keywords are hidden here. Reload the page to see and change them.');
    expect(m.el.querySelector('input[aria-label="Keyword or phrase"]')).toBeNull();
    expect((m.el.querySelector('select[aria-label="Where to look"]') as HTMLSelectElement).disabled).toBe(true);
    await m.click(m.choice('Off'));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Mode: Record only → Off');
    await m.click(m.button('Save the change'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', { mode: 'off', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('adds a keyword with Enter and saves the list', async () => {
    api.created.push(keywordRule());
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule(), ...ch, version: 2 } }));
    const m = await mount();
    await m.open('"Project Falcon"');
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
      await m.open('"Project Falcon"');
      await m.click(m.choice('Alert me'));
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
    await m.open('"Project Falcon"');
    // Block and Pause on incoming data wait a day; Alert me and Stop's own rule aside, the rest can be picked.
    expect(m.choice('Block the call')!.disabled).toBe(true);
    expect(m.choice('Block the call')!.closest('label')!.textContent).toContain('needs 24 hours in Record only first');
    expect(m.choice('Alert me')!.disabled).toBe(false);
    // Looking only at replies, Block doesn't wait.
    await choose(m.el.querySelector('select[aria-label="Where to look"]') as HTMLSelectElement, 'replies');
    expect(m.choice('Block the call')!.disabled).toBe(false);
    expect(api.update).not.toHaveBeenCalled();
    m.root.unmount();
  });

  it('after a day, blocking incoming data is confirmed by typing who it covers', async () => {
    api.created.push(keywordRule({ response: 'block' }));
    api.history = [{ id: 'h1', ruleId: 'k1', ruleType: 'keyword', description: 'Added new Keywords rule', by: 'test', time: new Date(Date.now() - 2 * 86_400_000).toISOString() }];
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule({ response: 'block' }), ...ch, version: 2 } }));
    const m = await mount();
    await m.open('"Project Falcon"');
    await m.click(m.choice('Block the call'));
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

describe('Controls page, mockup suggestions and toasts', () => {
  const dlg = (m: Awaited<ReturnType<typeof mount>>) => [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
  const created = () => api.create.mockImplementation(async (_f: string, r: Record<string, unknown>) => { const rule = { ...base, id: `c${api.created.length}`, response: 'block', ...r } as GovernanceRule; api.created.push(rule); return { rule }; });

  it('two identical rules: Remove one takes the extra away at once, and Undo adds it back in Record only', async () => {
    api.created.push({ ...RULES[2], id: 'r3b' });
    created();
    const m = await mount();
    expect(m.text()).toContain('Two identical spend caps (over $190 a day).');
    await m.click(m.button('Remove one'));
    expect(api.remove).toHaveBeenCalledWith('f1', 'r3b', 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Duplicate Spend cap rule removed.');
    await m.click(m.button('Undo'));
    expect(api.create).toHaveBeenCalledWith('f1', expect.objectContaining({ ruleType: 'spend_cap', mode: 'watch', params: { dailyCap: 190, scope: 'day', unit: 'dollars' } }), 'k');
    m.root.unmount();
  });

  it('a Keywords rule for one agent: Cover all agents confirms, adds a copy for everyone in Record only, and Undo removes it', async () => {
    api.created.push({ ...base, id: 'kw', ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: ['lead-agent'], params: { keywords: ['password'], where: 'incoming', wholeWord: true } });
    created();
    const m = await mount();
    expect(m.text()).toContain('"password" rule covers only lead-agent (1 of 2).');
    await m.click(m.button('Cover all agents…'));
    expect(dlg(m).textContent).toContain('Cover all agents with the "password" rule?');
    expect(dlg(m).textContent).toContain('lead-agent keeps its own copy, so nothing changes for it.');
    expect(api.create).not.toHaveBeenCalled();
    await m.click(m.button('Cover all agents'));
    expect(api.create).toHaveBeenCalledWith('f1', expect.objectContaining({ ruleType: 'keyword', mode: 'watch', appliesTo: 'all', params: { keywords: ['password'], where: 'incoming', wholeWord: true } }), 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('"password" rule now covers all agents (Record only).');
    await m.click(m.button('Undo'));
    expect(api.remove).toHaveBeenCalledWith('f1', 'c1', 'k');
    m.root.unmount();
  });

  it('the allowlist confirm shows who it caught and offers no one-agent exception (the engine has none)', async () => {
    api.models = ['claude-sonnet-4-5'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all' };
    api.would = { r2: { 'lead-agent': 44 } };
    const m = await mount();
    await m.click(m.button('Add to allowlist…'));
    expect(dlg(m).textContent).toContain('the allowlist caught 44 calls from lead-agent');
    expect(dlg(m).textContent).toContain('An allowlist can’t make an exception for one agent yet.');
    expect([...dlg(m).querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Cancel', 'Allow for all agents']);
    m.root.unmount();
  });

  it('a toast Undo asks before throwing away an unsaved edit to another rule', async () => {
    created();
    const m = await mount();
    await m.open('$200');
    await m.click(m.button('Remove rule'));
    await m.click([...dlg(m).querySelectorAll('button')].find((b) => b.textContent === 'Remove rule'));
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    await m.click(m.button('Undo'));
    expect(dlg(m).textContent).toContain('Discard your changes to Spend cap?');
    expect(api.create).not.toHaveBeenCalled();
    await m.click([...dlg(m).querySelectorAll('button')].find((b) => b.textContent === 'Discard changes'));
    expect(api.create).toHaveBeenCalledWith('f1', expect.objectContaining({ ruleType: 'spend_cap', mode: 'watch', params: { dailyCap: 200, scope: 'day', unit: 'dollars' } }), 'k');
    m.root.unmount();
  });

  it('an Undo the engine refuses (changed meanwhile) leaves the rule and says so', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule> & { ifVersion: number }) => {
      if (api.update.mock.calls.length > 1) throw new WhiteRoomApiError('changed', 409);
      const { ifVersion, ...rest } = ch;
      const rule = { ...RULES.find((r) => r.id === id)!, ...rest, version: ifVersion + 1 } as GovernanceRule;
      api.saved[id] = rule;
      return { rule };
    });
    const m = await mount();
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    await m.click(m.button('Save'));
    await m.click(m.button('Undo'));
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('This rule changed again since, so Undo left it as it is.');
    m.root.unmount();
  });

  it('an Undo for a rule removed meanwhile says there is nothing to undo', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule> & { ifVersion: number }) => {
      const { ifVersion, ...rest } = ch;
      // Removed somewhere else straight after the save: the reload no longer has it.
      api.empty = true;
      return { rule: { ...RULES.find((r) => r.id === id)!, ...rest, version: ifVersion + 1 } as GovernanceRule };
    });
    const m = await mount();
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    await m.click(m.button('Save'));
    await m.click(m.button('Undo'));
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('That rule isn’t here any more, so there’s nothing to undo.');
    m.root.unmount();
  });

  it('the allowlist toast Undo puts the old list back over the version it made', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all' };
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.saved[id], ...ch, version: 5 } }));
    const m = await mount();
    await m.click(m.button('Add to allowlist…'));
    await m.click(m.button('Allow for all agents'));
    await m.click(m.button('Undo'));
    expect(api.update).toHaveBeenLastCalledWith('f1', 'r2', { mode: 'watch', params: { allowedModels: ['claude-haiku-4-5-20251001'] }, ifVersion: 5, description: 'Undid the last change' }, 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Change undone.');
    m.root.unmount();
  });

  it('Undo of an added copy leaves it alone when it changed since', async () => {
    api.created.push({ ...base, id: 'kw', ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: ['lead-agent'], params: { keywords: ['password'], where: 'incoming', wholeWord: true } });
    api.create.mockImplementation(async (_f: string, r: Record<string, unknown>) => {
      const rule = { ...base, id: 'c0', response: 'block', ...r } as GovernanceRule;
      // Someone changes the copy straight after: the reload brings version 2.
      api.created.push({ ...rule, version: 2 });
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Cover all agents…'));
    await m.click(m.button('Cover all agents'));
    await m.click(m.button('Undo'));
    expect(api.remove).not.toHaveBeenCalled();
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('This rule changed again since, so Undo left it as it is.');
    m.root.unmount();
  });

  it('the allowlist toast Undo, refused because the rule changed again, says so', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all' };
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => {
      if (api.update.mock.calls.length > 1) throw new WhiteRoomApiError('changed', 409);
      return { rule: { ...api.saved[id], ...ch, version: 5 } };
    });
    const m = await mount();
    await m.click(m.button('Add to allowlist…'));
    await m.click(m.button('Allow for all agents'));
    await m.click(m.button('Undo'));
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('This rule changed again since, so Undo left it as it is.');
    m.root.unmount();
  });

  it('narrowing: Move it saves the narrowed rule, with what else the edit weakens', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.open('$190');
    await choose(m.el.querySelector('select[aria-label="Which agents this rule applies to"]') as HTMLSelectElement, 'some');
    await choose(m.el.querySelector('select[aria-label="Add an agent"]') as HTMLSelectElement, 'lead-agent');
    await m.click(m.button('Save'));
    await m.click([...dlg(m).querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move it to lead-agent only')));
    expect(api.update).toHaveBeenCalledWith('f1', 'r3', { appliesTo: ['lead-agent'], ifVersion: 1 }, 'k');
    expect(api.create).not.toHaveBeenCalled();
    m.root.unmount();
  });

  it('during the wait, Record only can still record what Stop would do', async () => {
    api.govV1 = true;
    api.history = [{ id: 'h1', ruleId: 'r2', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'test', time: new Date(Date.now() - 60_000).toISOString() }];
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.open('Only claude');
    expect(m.choice('Stop the agent')!.disabled).toBe(true);
    await choose(m.el.querySelector('select[aria-label="What Record only records"]') as HTMLSelectElement, 'stop');
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', { response: 'stop', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('words the Start confirm by what the rule does: Pause ends the run', async () => {
    api.govV1 = true;
    const m = await mount();
    await m.open('Only claude');
    await m.click(m.choice('Pause the agent'));
    await m.click(m.button('Save'));
    expect(dlg(m).textContent).toContain('Start pausing agents with this rule?');
    expect(dlg(m).textContent).toContain('Would have paused');
    expect(dlg(m).textContent).toContain('ends the agent’s run');
    expect(dlg(m).textContent).not.toContain('keeps going');
    m.root.unmount();
  });

  it('a Keywords rule whose list is hidden: Remove has no Undo, and it can’t be copied', async () => {
    api.created.push({ ...base, id: 'kh', ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: 'all', params: { keywords: [], where: 'incoming', wholeWord: true, keywordCount: 2 } });
    const m = await mount();
    await m.open('2 hidden keywords');
    await m.click(m.button('Remove rule'));
    await m.click([...dlg(m).querySelectorAll('button')].find((b) => b.textContent === 'Remove rule'));
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Removed the Keywords rule.');
    expect(m.button('Undo')).toBeUndefined();
    m.root.unmount();
  });

  it('a second click on Undo sends it once', async () => {
    let finish!: () => void;
    let calls = 0;
    api.update.mockImplementation((_f: string, id: string, ch: Partial<GovernanceRule> & { ifVersion: number }) => {
      calls++;
      const { ifVersion, ...rest } = ch;
      const rule = { ...RULES.find((r) => r.id === id)!, ...rest, version: ifVersion + 1 } as GovernanceRule;
      api.saved[id] = rule;
      if (calls === 1) return Promise.resolve({ rule });
      return new Promise((resolve) => { finish = () => resolve({ rule }); });
    });
    const m = await mount();
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    await m.click(m.button('Save'));
    const undo = m.button('Undo')!;
    // Two clicks before the page re-renders (a double click): one Undo.
    await act(async () => { undo.click(); undo.click(); });
    expect(calls).toBe(2);
    await act(async () => { finish(); });
    await flush();
    m.root.unmount();
  });

  it('before Block, warns when an allowlist would block every call an agent makes', async () => {
    api.would = { r2: { 'market-researcher': 12 } };
    api.agentCalls = { 'market-researcher': 12 };
    const m = await mount();
    await m.open('Only claude');
    await m.click(m.choice('Block the call'));
    await m.click(m.button('Save'));
    await flush();
    expect(dlg(m).textContent).toContain('This would block every call market-researcher makes.');
    m.root.unmount();
  });

  it('Check audit trail runs the check and says what it covered', async () => {
    const m = await mount();
    await m.click(m.button('Check audit trail'));
    await flush();
    expect(dlg(m).textContent).toContain('Nothing changed or missing');
    expect(dlg(m).textContent).toContain('All 2,045 events checked · just now. Events before tracking started aren’t covered.');
    m.root.unmount();
  });

  it('Check audit trail says when tracking hasn’t started, and when the check didn’t run', async () => {
    const client = await import('@/lib/whiteroom/client');
    const integrity = vi.spyOn(client, 'auditIntegrity');
    integrity.mockResolvedValueOnce({ fleetId: 'f1', mode: 'legacy', headSeq: 0, verifiedThroughSeq: 0, verifiedAt: null, prunedBeforeTracking: false, legacyEvents: 3, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } });
    const m = await mount();
    await m.click(m.button('Check audit trail'));
    await flush();
    expect(dlg(m).textContent).toContain('History tracking hasn’t started for this fleet yet.');
    await m.click(m.button('Done'));
    integrity.mockRejectedValueOnce(new Error('down'));
    await m.click(m.button('Check audit trail'));
    await flush();
    expect(dlg(m).textContent).toContain('The check didn’t run. Try again.');
    await m.click(m.button('Check again'));
    await flush();
    expect(dlg(m).textContent).toContain('Nothing changed or missing');
    integrity.mockRestore();
    m.root.unmount();
  });

  it('opening a rule on a wide screen moves focus into the editor', async () => {
    const m = await mount();
    await m.open('$190');
    expect(document.activeElement?.id).toBe('ctl-ed-title');
    m.root.unmount();
  });

  it('recent changes say who made each one', async () => {
    api.history = [{ id: 'h1', ruleId: 'r1', ruleType: 'loop_breaker', description: 'Added new Loop breaker rule', by: 'R Haque', time: new Date().toISOString() }];
    const m = await mount();
    expect(m.text()).toContain('Loop breaker added · R Haque');
    m.root.unmount();
  });
});
