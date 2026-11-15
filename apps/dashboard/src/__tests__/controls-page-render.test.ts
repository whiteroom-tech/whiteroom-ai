// @vitest-environment happy-dom
// The redesigned Controls page in a DOM (spec Rev 1, D1), with the engine
// mocked: rules as sentences in Blocking / Watch / Off, the agent filter,
// Save sending only what changed after the Enforce preview, the Discard and
// Remove dialogs.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { GovernanceListResult, GovernanceRule } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import './support/dialog';

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  useSearchParams: () => nav.params,
  usePathname: () => '/controls',
}));
const session = vi.hoisted(() => ({ key: 'k' }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'f1', authKey: session.key, resetSession: vi.fn() }) }));
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
  /** An engine from before engine PR 345: no rule_would_act batch. */
  oldEngine: false,
  /** Rules per rule_would_act batch read, and single reads made. */
  wouldBatches: [] as number[],
  wouldSingle: 0,
  /** Each agent's calls, as performance_agent returns them. */
  agentCalls: {} as Record<string, number>,
  /** What Settings › Alerts has; null: an engine without alerts. */
  alerts: { slack: null, teams: null } as { slack: { ending: string } | null; teams?: { ending: string } | null } | null,
  history: [] as Array<{ id: string; ruleId: string; ruleType: string; description: string; by: string; time: string; before?: unknown; after?: unknown }>,
  /** Rules of a type this build doesn't know, as a newer engine would list them. */
  unknown: [] as Array<Record<string, unknown>>,
  /** rule_actions' fleet-wide totals this week (default: 2 blocked, 5 would have acted). */
  totals: null as { blocked: number; paused: number; stopped: number; toldYou: number; wouldAct: number; trimmed?: number } | null,
  /** rule_actions' counts for other rule types, beside the Loop breaker's. */
  byRule: {} as Record<string, { blocked: number; paused: number; stopped: number; toldYou: number; wouldAct: number; trimmed?: number }>,
  /** What tools_seen gives ([]: an older engine, a failure or no data), and how often it was asked. */
  tools: [] as string[],
  toolsAsked: 0,
  /** tools_seen fails (an engine blip). */
  toolsFail: false,
  /** tools_seen never answers (a slow engine). */
  toolsHang: false,
  /** When set, each tools_seen read waits here until the test answers it. */
  toolsReplies: null as Array<(tools: string[]) => void> | null,
  /** governance_list's ruleTypes (undefined: an older engine that doesn't say). */
  ruleTypes: undefined as string[] | undefined,
  /** send_seen_list fails (an engine blip). */
  seenFail: false,
  /** send_seen_list's rows per rule id, and the rule ids it was asked for. */
  seenRows: {} as Record<string, Array<{ tool: string; domain: string; agentId: string | null; firstSeen: string; canAdd?: boolean }>>,
  seenFull: false,
  seenAsked: [] as string[],
}));
const { knownRulesOnly } = await import('@/lib/governance');
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  // Read as the real governanceList reads the engine's reply (knownRulesOnly).
  governanceList: async () => {
    api.lists++; if (api.listFail) throw new Error('down'); if (api.listGate) await api.listGate;
    return knownRulesOnly({ fleetId: 'f1', rules: api.empty ? [] : [...RULES.map((r) => api.saved[r.id] ?? r), ...api.created, ...(api.unknown as unknown as GovernanceRule[])], history: api.history as GovernanceListResult['history'], agents: ['lead-agent', 'market-researcher'], govV1: api.govV1, ...(api.ruleTypes && { ruleTypes: api.ruleTypes }) });
  },
  performanceRecommendationGet: () => new Promise(() => {}),
  alertsGet: async () => api.alerts,
  ruleWouldAct: async (_f: string, ruleId: string) => { api.wouldSingle++; return { fleetId: 'f1', ruleId, byAgent: api.would[ruleId] ?? {}, unversioned: false, since: '2026-10-21T00:00:00Z' }; },
  // engine PR 345: the Watch rules in one read; an older engine refuses a body without rule_id.
  ruleWouldActBatch: async (_f: string, rules: Array<{ ruleId: string; ruleVersion: number }>) => {
    api.wouldBatches.push(rules.length);
    if (api.oldEngine) throw new WhiteRoomApiError('HTTP 400', 400, 'rule_id is required.');
    return { fleetId: 'f1', results: rules.map(({ ruleId, ruleVersion }) => ({ ruleId, ruleVersion, byAgent: api.would[ruleId] ?? {}, unversioned: false, since: '2026-10-21T00:00:00Z' })) };
  },
  performanceAgent: async (_f: string, agentId: string) => ({ fleetId: 'f1', agentId, hourly: [], totals: { calls: api.agentCalls[agentId] ?? 0, costMicros: 0 } }),
  auditIntegrity: async () => ({ fleetId: 'f1', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 2045, verifiedAt: new Date().toISOString(), prunedBeforeTracking: true, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } }),
  verifyAudit: async () => ({ valid: true, eventsVerified: 2045, message: '' }),
  ruleActions: async () => ({ fleetId: 'f1', totals: api.totals ?? { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 5 }, byAgent: {}, byRule: { loop_breaker: { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 }, ...api.byRule } }),
  performanceIndex: async () => { if (!api.models) throw new Error('no store'); return { summary: { models: api.models.map((model) => ({ model, calls: 3 })) } }; },
  performanceFleetHourly: async () => { if (!api.models) throw new Error('no store'); return { hourly: api.hourly }; },
  governanceUpdateRule: api.update,
  governanceDeleteRule: api.remove,
  governanceCreateRule: api.create,
  sendSeenList: async (_f: string, ruleId: string) => { api.seenAsked.push(ruleId); if (api.seenFail) throw new Error('down'); return { ruleId, rows: api.seenRows[ruleId] ?? [], full: api.seenFull }; },
  toolsSeen: async () => { api.toolsAsked++; if (api.toolsHang) await new Promise(() => {}); if (api.toolsReplies) return new Promise<string[]>((r) => api.toolsReplies!.push(r)); if (api.toolsFail) throw new Error('down'); return api.tools; },
}));

const { default: ControlsPage } = await import('@/app/(citadel)/controls/page');
const { resetBatchSupport } = await import('@/lib/batched-reads');
const { RULE_CATEGORY, RULE_LABELS } = await import('@/lib/governance');
const { RULE_TEMPLATES } = await import('@/lib/controls-view');
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
  /** A What happens mode: Off, Watch or Enforce. */
  const seg = (label: string) => [...el.querySelectorAll('[role="radiogroup"][aria-label="What happens"] button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  /** The "When enforced" dropdown, shown only in Enforce. */
  const action = () => el.querySelector('select[aria-label="When enforced"]') as HTMLSelectElement | null;
  /** A "When enforced" option by its label, picking Enforce first if needed. */
  const option = async (label: string) => {
    if (!action()) await click(seg('Enforce'));
    return [...action()!.options].find((o) => o.textContent?.startsWith(label));
  };
  /** Picks a mode, or Enforce with an action, by its label. */
  const pick = async (label: string) => {
    if (['Off', 'Watch', 'Enforce'].includes(label)) return click(seg(label));
    const o = await option(label);
    expect(o, label).toBeTruthy();
    await choose(action()!, o!.value);
  };
  /** Opens a rule, with When expanded for editing. */
  const open = async (needle: string) => { await click(row(needle)); const c = button('Change'); if (c) await click(c); };
  return { el, root, text, button, row, click, seg, action, option, pick, open };
}

beforeEach(() => {
  // An unsaved edit is kept in sessionStorage across visits (controls-draft): each test starts with none.
  sessionStorage.clear();
  nav.params = new URLSearchParams(); nav.replace.mockClear(); nav.push.mockClear();
  api.update.mockReset(); api.remove.mockClear(); api.create.mockReset(); api.created = []; api.saved = {}; api.lists = 0; api.alerts = { slack: null, teams: null }; api.govV1 = false; api.models = null; api.hourly = []; api.listGate = null; api.listFail = false; api.empty = false; api.would = {}; api.agentCalls = {}; api.history = []; api.totals = null; api.byRule = {}; api.unknown = []; api.tools = []; api.toolsAsked = 0; api.toolsFail = false; api.toolsHang = false; api.toolsReplies = null; session.key = 'k';
  api.ruleTypes = undefined; api.seenRows = {}; api.seenFull = false; api.seenAsked = []; api.seenFail = false;
  api.oldEngine = false; api.wouldBatches = []; api.wouldSingle = 0; resetBatchSupport();
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
    // Enforce rules come first in a card, with the one filled tag and the accent; Watch is a hollow dot.
    const all = [...m.el.querySelectorAll('.ctl-card')].find((p) => p.querySelector('.ctl-card__title')?.textContent === 'Rules for all agents')!;
    expect([...all.querySelectorAll('.ctl-row .ctl-mtag')].map((t) => t.textContent)).toEqual(['Enforce', 'Watch', 'Watch']);
    expect(all.querySelector('.ctl-mtag.is-block')?.textContent).toBe('Enforce');
    expect(all.querySelector('.ctl-row.is-block')?.textContent).toContain('Same call 100× in a run');
    expect(all.textContent).toContain('New agents get these too.');
    expect(all.textContent).not.toContain('1 Enforce · 2 Watch · new');
    // Specific agents are grouped under each agent's name.
    expect(m.text()).toContain('Only lead-agent, market-researcher have extra rules');
    expect([...m.el.querySelectorAll('.ctl-owner')].map((o) => o.textContent)).toEqual(['lead-agent1 rule', 'market-researcher1 rule']);
    // The lead line counts rules that are set up, and the week's rule activity; no number cards.
    expect(m.text()).toContain('5 rules · 2 Enforce · 3 Watch · 7 caught, 2 blocked this week');
    expect(m.el.querySelector('.wr-stat-card')).toBeNull();
    // The one Loop breaker gets its own count. Two caps in Watch don't overlap: neither acts.
    expect(m.row('100×').textContent).toContain('2 blocked · 7 days');
    expect(m.row('$200').textContent).not.toContain('Never triggers');
    expect(m.text()).toContain('Select a rule to edit it');
    // Every rule row ends in a chevron; the phone hint sits with the lists (CSS shows it under 720px).
    expect(m.el.querySelectorAll('button.ctl-row .ctl-row__chev')).toHaveLength(m.el.querySelectorAll('button.ctl-row').length);
    expect(m.el.querySelector('.ctl-main .ctl-phone-hint')?.textContent).toBe('Tap a rule to edit it. New rules start in Watch.');
    expect(m.text()).toContain('New rules start in Watch.');
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
    // Two caps in Enforce for the same agents: the higher one never triggers.
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

  it('tags an enforced rule by what it does: an alert-only rule is never a filled Enforce', async () => {
    api.saved.r1 = { ...RULES[0], response: 'notify' };
    const m = await mount();
    const tag = m.row('100×').querySelector('.ctl-mtag')!;
    expect(tag.textContent).toBe('Alert only');
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
    await m.pick('Block the call');
    expect(m.button('Save')!.disabled).toBe(false);
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Start blocking with this rule?');
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    expect(dialog.textContent).toContain('Would have blocked');
    expect(dialog.textContent).toContain('Watching since');
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
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Undone. Model allowlist is back to how it was (Watch).');
    expect(m.row('Only claude').querySelector('.ctl-mtag')!.textContent).toBe('Watch');
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
    expect(pill()).toBe('Watch');
    await m.pick('Block the call');
    expect(pill()).toBe('Enforce · unsaved');
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
      await m.pick('Block the call');
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

  it('lists a rule of a type it doesn’t know as a plain row: not opened, not counted, its history left out', async () => {
    api.unknown = [{ ...base, id: 'rx', ruleType: 'made_up_type', mode: 'enforce', response: 'block', appliesTo: 'all', params: { somethingNew: ['x'] } }];
    api.history = [{ id: 'hx', ruleId: 'rx', ruleType: 'made_up_type', description: 'Removed Made up rule', by: 'user:u1', time: '2026-10-20T00:00:00Z',
      before: { mode: 'enforce', response: 'block', alsoNotify: false, appliesTo: 'all', params: { somethingNew: ['x'] } }, after: null }];
    nav.params = new URLSearchParams('rule=rx');
    const m = await mount();
    const card = [...m.el.querySelectorAll('.ctl-card')].find((c) => c.querySelector('.ctl-card__title')?.textContent === 'Other rules 1')!;
    expect(card.querySelector('.ctl-row')!.textContent).toBe('A rule this version can’t showAll agentsEnforce');
    // A plain row, never a button that opens the editor; the link to it neither opens it nor calls it removed.
    expect(card.querySelector('button')).toBeNull();
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeNull();
    expect(m.text()).not.toContain('isn’t here any more');
    // Not counted as any rule this build knows, and its change isn't offered to undo.
    expect(m.text()).toContain('5 rules · 2 Enforce · 3 Watch');
    expect(m.text()).not.toContain('Removed Made up rule');
    // It covers every agent, so it shows for one agent too.
    nav.params = new URLSearchParams('agent=lead-agent');
    m.root.unmount();
    const one = await mount();
    expect(one.text()).toContain('A rule this version can’t show');
    nav.params = new URLSearchParams();
    one.root.unmount();
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

  it('"Also alert me" shows for Block in Enforce only, and leaving Enforce puts the saved setting back', async () => {
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    api.saved.r3 = { ...RULES[2], alsoNotify: true };
    const m = await mount();
    await m.open('$190');
    const box = () => [...m.el.querySelectorAll('label')].find((l) => l.textContent?.includes('Also alert me'))?.querySelector('input') as HTMLInputElement | undefined;
    // Watch sends no alerts, so the box isn't offered there; nor in Off.
    expect(box()).toBeUndefined();
    await m.pick('Off');
    expect(box()).toBeUndefined();
    // Enforce with Block: the saved alert comes along.
    await m.pick('Block the call');
    expect(box()!.checked).toBe(true);
    expect(m.text()).toContain('Enforce: blocks the call and alerts you. The agent keeps going.');
    // Only alert me is the alert itself; Pause and Stop always alert: no box.
    await m.pick('Only alert me');
    expect(box()).toBeUndefined();
    await m.pick('Block the call');
    expect(box()!.checked).toBe(false);
    await m.click(box());
    // Back to Watch: the saved settings return (nothing set while trying actions sticks).
    await m.pick('Watch');
    expect(m.button('Save')!.disabled).toBe(true);
    // Enforce + Block + Also alert me saves as one change.
    await m.pick('Block the call');
    await m.click(box());
    await m.click(m.button('Save'));
    await m.click(m.button('Start blocking'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r3', { mode: 'enforce', alsoNotify: false, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('loads every saved shape as it is: mode, action, alert, and alert-only rules, with no change to save', async () => {
    api.govV1 = true;
    const shapes: [Partial<GovernanceRule>, string, string | null, boolean | null, string][] = [
      // saved rule · mode on · action shown · Also alert me (null: not shown) · row tag
      [{ mode: 'off', response: 'stop' }, 'Off', null, null, 'Off'],
      [{ mode: 'watch', response: 'notify' }, 'Watch', null, null, 'Watch'],
      [{ mode: 'enforce', response: 'block', alsoNotify: true }, 'Enforce', 'block', true, 'Enforce'],
      [{ mode: 'enforce', response: 'block', alsoNotify: false }, 'Enforce', 'block', false, 'Enforce'],
      [{ mode: 'enforce', response: 'pause' }, 'Enforce', 'pause', null, 'Enforce · pauses'],
      [{ mode: 'enforce', response: 'stop' }, 'Enforce', 'stop', null, 'Enforce · stops'],
      [{ mode: 'enforce', response: 'notify' }, 'Enforce', 'notify', null, 'Alert only'],
    ];
    for (const [over, mode, response, alert, tag] of shapes) {
      api.saved.r1 = { ...RULES[0], ...over };
      const m = await mount();
      if (over.mode === 'off') await m.click(m.button('Show'));
      expect(m.row('100×').querySelector('.ctl-mtag')!.textContent).toBe(tag);
      await m.click(m.row('100×'));
      expect(m.seg(mode)!.getAttribute('aria-checked')).toBe('true');
      expect(m.action()?.value ?? null).toBe(response);
      const box = [...m.el.querySelectorAll('label')].find((l) => l.textContent?.includes('Also alert me'))?.querySelector('input') as HTMLInputElement | undefined;
      expect(box ? box.checked : null).toBe(alert);
      // The alert-only option is there for every rule, not just alert-only ones.
      if (response) expect((await m.option('Only alert me'))!.disabled).toBe(false);
      expect(m.button('Save')!.disabled).toBe(true);
      m.root.unmount();
    }
  });

  it('Stop needs a day in Watch first', async () => {
    api.govV1 = true;
    api.history = [{ id: 'h1', ruleId: 'r2', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'test', time: new Date(Date.now() - 60_000).toISOString() }];
    const m = await mount();
    await m.open('Only claude');
    // Not an error after the fact: Stop can't be picked yet, and says from when.
    const stop = (await m.option('Stop the agent'))!;
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toMatch(/^Stop the agent · from \d{1,2}:\d{2} [ap]m tomorrow, after 24 hours in Watch$/);
    expect((await m.option('Pause the agent'))!.disabled).toBe(false);
    // Enforce opens on the rule's own action, Block, which needs no wait.
    expect(m.action()!.value).toBe('block');
    expect(api.update).not.toHaveBeenCalled();
    m.root.unmount();
  });

  it('a rule in Watch whose history doesn’t say since when keeps Stop closed, and says why', async () => {
    api.govV1 = true;
    const m = await mount();
    await m.open('Only claude');
    const stop = (await m.option('Stop the agent'))!;
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toBe('Stop the agent · needs 24 hours in Watch first (we can’t see when it started watching)');
    m.root.unmount();
  });

  it('after a day in Watch, Stop is confirmed by typing who it covers', async () => {
    api.govV1 = true;
    api.history = [{ id: 'h1', ruleId: 'r2', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'test', time: new Date(Date.now() - 2 * 86_400_000).toISOString() }];
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.open('Only claude');
    await m.pick('Stop the agent');
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

  it('the tool pickers ask for the fleet’s tools only once shown, and list them first', async () => {
    api.tools = ['search_claims', 'update_claim'];
    const m = await mount();
    expect(api.toolsAsked).toBe(0);
    await m.click(m.button('Show'));
    await m.open('No tools picked yet');
    expect(api.toolsAsked).toBe(1);
    await flush();
    const select = m.el.querySelector('select[aria-label="Add a tool"]') as HTMLSelectElement;
    expect(select.options[0].textContent).toBe('Choose a tool…');
    expect(select.querySelector('optgroup')!.getAttribute('label')).toBe('Your fleet’s tools');
    expect(select.querySelector('optgroup')!.textContent).toBe('update_claimsearch_claims');
    // Another tool picker reuses the same read.
    await m.click(m.button('Close'));
    await m.open('Same call 100');
    expect(api.toolsAsked).toBe(1);
    expect(m.el.querySelector('select[aria-label="Add a tool"] optgroup')!.getAttribute('label')).toBe('Your fleet’s tools');
    m.root.unmount();
  });

  it('a failed read leaves the picker as it is, and the next picker shown asks again', async () => {
    api.toolsFail = true;
    api.tools = ['update_claim'];
    const m = await mount();
    await m.click(m.button('Show'));
    await m.open('No tools picked yet');
    await flush();
    expect(api.toolsAsked).toBe(1);
    expect((m.el.querySelector('select[aria-label="Add a tool"]') as HTMLSelectElement).options[0].textContent).toBe('+ Add tool');
    api.toolsFail = false;
    await m.click(m.button('Close'));
    await m.open('Same call 100');
    await flush();
    expect(api.toolsAsked).toBe(2);
    expect(m.el.querySelector('select[aria-label="Add a tool"] optgroup')!.getAttribute('label')).toBe('Your fleet’s tools');
    m.root.unmount();
  });

  it('a failed read after a good one keeps the tools already shown', async () => {
    api.tools = ['update_claim'];
    const m = await mount();
    await m.click(m.button('Show'));
    await m.open('No tools picked yet');
    await flush();
    expect(m.el.querySelector('select[aria-label="Add a tool"] optgroup')!.getAttribute('label')).toBe('Your fleet’s tools');
    // The session's key changes, so the next picker reads again, and that read fails.
    // Had a read worked, it would have shown new_tool.
    api.tools = ['new_tool'];
    api.toolsFail = true;
    session.key = 'k2';
    await act(async () => { m.root.render(h(ControlsPage)); });
    await flush();
    await m.click(m.button('Close'));
    await m.open('Same call 100');
    await flush();
    // Read again under the new key, and failed: the earlier list is still shown.
    expect(api.toolsAsked).toBeGreaterThan(1);
    const group = m.el.querySelector('select[aria-label="Add a tool"] optgroup')!;
    expect(group.getAttribute('label')).toBe('Your fleet’s tools');
    expect(group.textContent).toBe('update_claim');
    expect(m.el.textContent).not.toContain('new_tool');
    m.root.unmount();
  });

  it('a read that answers late, after the session key changed, doesn’t replace the newer list', async () => {
    api.toolsReplies = [];
    const m = await mount();
    await m.click(m.button('Show'));
    await m.open('No tools picked yet');
    session.key = 'k2';
    await act(async () => { m.root.render(h(ControlsPage)); });
    await flush();
    // The open picker asked again under the new key.
    expect(api.toolsReplies).toHaveLength(2);
    await act(async () => { api.toolsReplies![1](['new_tool']); });
    await flush();
    await act(async () => { api.toolsReplies![0](['old_tool']); });
    await flush();
    const group = m.el.querySelector('select[aria-label="Add a tool"] optgroup')!;
    expect(group.textContent).toBe('new_tool');
    m.root.unmount();
  });

  it('with no fleet tools, the tool picker is today’s', async () => {
    const m = await mount();
    await m.click(m.button('Show'));
    await m.open('No tools picked yet');
    await flush();
    const select = m.el.querySelector('select[aria-label="Add a tool"]') as HTMLSelectElement;
    expect(select.options[0].textContent).toBe('+ Add tool');
    expect([...select.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'))).toEqual(['File & code', 'Web & API', 'Execution', 'Memory & state']);
    m.root.unmount();
  });

  it('"Block tools" starts with the fleet’s delete-looking tools picked, and says to check them', async () => {
    api.tools = ['search_claims', 'update_claim', 'DeleteAttachment', 'send_email'];
    api.create.mockImplementation(async (_f: string, r: { ruleType: GovernanceRule['ruleType']; mode: GovernanceRule['mode']; params?: GovernanceRule['params'] }) => {
      const rule: GovernanceRule = { ...base, id: 'new', ruleType: r.ruleType, mode: r.mode, response: 'block', appliesTo: 'all', params: r.params ?? { blockedTools: [] } };
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add rule'));
    await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Block tools')));
    expect(api.create).toHaveBeenCalledWith('f1', { ruleType: 'tool_list', mode: 'watch', params: { blockedTools: ['update_claim', 'DeleteAttachment'] } }, 'k');
    expect(m.text()).toContain('Tool list rule added in Watch. Check its tools.');
    m.root.unmount();
  });

  it('"Block tools" uses tools already read, without reading again', async () => {
    api.tools = ['update_claim'];
    api.create.mockImplementation(async (_f: string, r: { ruleType: GovernanceRule['ruleType']; mode: GovernanceRule['mode']; params?: GovernanceRule['params'] }) => {
      const rule: GovernanceRule = { ...base, id: 'new', ruleType: r.ruleType, mode: r.mode, response: 'block', appliesTo: 'all', params: r.params ?? { blockedTools: [] } };
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Show'));
    await m.open('No tools picked yet');
    await m.click(m.button('Close'));
    expect(api.toolsAsked).toBe(1);
    await m.click(m.button('Add rule'));
    await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Block tools')));
    expect(api.toolsAsked).toBe(1);
    expect(api.create).toHaveBeenCalledWith('f1', { ruleType: 'tool_list', mode: 'watch', params: { blockedTools: ['update_claim'] } }, 'k');
    m.root.unmount();
  });

  it('"Block tools" waits at most 2 seconds for the tools, then is added as before', async () => {
    api.toolsHang = true;
    api.create.mockImplementation(async (_f: string, r: { ruleType: GovernanceRule['ruleType']; mode: GovernanceRule['mode'] }) => {
      const rule: GovernanceRule = { ...base, id: 'new', ruleType: r.ruleType, mode: r.mode, response: 'block', appliesTo: 'all', params: { blockedTools: [] } };
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add rule'));
    vi.useFakeTimers();
    try {
      await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Block tools')));
      expect(api.create).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(1999); });
      expect(api.create).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(1); });
      await flush();
    } finally { vi.useRealTimers(); }
    await flush();
    expect(api.create).toHaveBeenCalledWith('f1', { ruleType: 'tool_list', mode: 'watch' }, 'k');
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeTruthy();
    expect(m.text()).not.toContain('Check its tools');
    m.root.unmount();
  });

  it('"Block tools" with no fleet tools known is added as before', async () => {
    api.create.mockImplementation(async (_f: string, r: { ruleType: GovernanceRule['ruleType']; mode: GovernanceRule['mode'] }) => {
      const rule: GovernanceRule = { ...base, id: 'new', ruleType: r.ruleType, mode: r.mode, response: 'block', appliesTo: 'all', params: { blockedTools: [] } };
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add rule'));
    await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Block tools')));
    expect(api.create).toHaveBeenCalledWith('f1', { ruleType: 'tool_list', mode: 'watch' }, 'k');
    expect(m.text()).not.toContain('Check its tools');
    m.root.unmount();
  });

  it('Keywords: Generate marker adds a marker chip and says what a marker is', async () => {
    api.created = [{ ...base, id: 'k1', ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: 'all', params: { keywords: ['Project Falcon', 'wrmk3f9a1c07b2e4d8a6'], where: 'replies', wholeWord: true } }];
    const m = await mount();
    // The row counts the marker and never shows its code.
    expect(m.row('Project Falcon').textContent).toContain('"Project Falcon", 1 marker');
    expect(m.text()).not.toContain('wrmk3f9a1c07b2e4d8a6');
    await m.open('Project Falcon');
    const editor = () => m.el.querySelector('aside[aria-label="Edit rule"]')!.textContent ?? '';
    expect(editor()).toContain('wrmk3f9a…d8a6');
    expect(editor()).toContain('A marker is a made-up code. Copy it into private records and this rule flags it when it shows up.');
    expect(editor()).not.toContain('With incoming data on');
    await m.click(m.button('Generate marker'));
    expect(m.el.querySelectorAll('.gov-chip--marker')).toHaveLength(2);
    await choose(m.el.querySelector('select[aria-label="Where to look"]') as HTMLSelectElement, 'both');
    expect(editor()).toContain('With incoming data on, it also matches when an agent reads the record.');
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
    await m.pick('Block the call');
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

  it('a row with nothing caught shows 0, and keeps its meaning for screen readers and the tooltip', async () => {
    const m = await mount();
    const zeros = [...m.el.querySelectorAll('.ctl-row__count')].filter((c) => c.querySelector('[aria-hidden="true"]')?.textContent === '0');
    expect(zeros.length).toBeGreaterThan(0);
    for (const z of zeros) {
      expect(z.querySelector('.wr-sr-only')?.textContent).toMatch(/^None (since edit|caught · 7 days)$/);
      expect(z.getAttribute('title')).toBe(z.querySelector('.wr-sr-only')?.textContent);
    }
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
    await m.click(m.button('Turn on in Watch…'));
    await m.click(m.button('Turn on in Watch'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', expect.objectContaining({ mode: 'watch', params: { allowedModels: ['claude-haiku-4-5-20251001'] } }), 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Turned your Model allowlist on in Watch.');
    m.root.unmount();
  });

  it('an Off allowlist missing a model: names it, says it goes to Watch, and adds it', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all', mode: 'off' };
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.saved[id], ...ch, version: 2 } }));
    const m = await mount();
    expect(m.text()).toContain('Allowlist is missing gpt-4o, used in the last 14 days.');
    await m.click(m.button('Add to allowlist…'));
    expect([...m.el.querySelectorAll('dialog[open]')].at(-1)!.textContent).toContain('Applies to all agents, in Watch.');
    await m.click(m.button('Allow for all agents'));
    expect(api.update).toHaveBeenCalledWith('f1', 'r2', expect.objectContaining({ mode: 'watch', params: { allowedModels: ['gpt-4o', 'claude-haiku-4-5-20251001'] } }), 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('gpt-4o allowed for all agents.');
    m.root.unmount();
  });

  it('an allowlist in Enforce takes the model through the editor, where Save asks first; no second allowlist', async () => {
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
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Saved. Spend cap is in Watch for all agents.');
    expect((m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement).value).toBe('150');
    expect(m.button('Save')!.disabled).toBe(true);
    expect(m.text()).not.toContain('From a Diagnosis suggestion');
    m.root.unmount();
  });

  it('says blocked for blocked calls only, as Performance and Home do; pauses and stops are named apart', async () => {
    api.totals = { blocked: 12, paused: 2, stopped: 1, toldYou: 3, wouldAct: 38 };
    const m = await mount();
    expect(m.el.querySelector('.ctl-lead')!.textContent).toBe('5 rules · 2 Enforce · 3 Watch · 56 caught, 12 blocked, 2 paused, 1 stopped this week');
    m.root.unmount();
  });

  it('viewing one agent, the lead line counts that agent’s rules and rule activity', async () => {
    nav.params = new URLSearchParams('agent=lead-agent');
    const m = await mount();
    // The mocked engine's 2 blocks are fleet-wide, none of them lead-agent's.
    expect(m.el.querySelector('.ctl-lead')!.textContent).toBe('4 rules · 2 Enforce · 2 Watch · 0 caught, 0 blocked this week');
    m.root.unmount();
  });

  it('changing the Agent filter asks about unsaved edits, and closes a rule the new filter hides', async () => {
    const m = await mount();
    const agent = () => m.el.querySelector('select#ctl-cover') as HTMLSelectElement;
    await m.open('Only claude');
    await m.pick('Block the call');
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

  it('adds a removed rule back as a new rule in Watch', async () => {
    api.history = [{ id: 'h2', ruleId: 'gone', ruleType: 'spend_cap', description: 'Removed Spend cap rule', by: 'test', time: when, before: snap(500, 'enforce'), after: null }];
    api.create.mockImplementation(async (_f: string, r: Record<string, unknown>) => { const rule = { ...base, id: 'r9', ...r }; api.created.push(rule as GovernanceRule); return { rule }; });
    const m = await mount();
    await m.click(m.button('Add it back'));
    expect(api.create).toHaveBeenCalledWith('f1', expect.objectContaining({ ruleType: 'spend_cap', mode: 'watch', response: 'block', params: { dailyCap: 500, scope: 'day', unit: 'dollars' }, appliesTo: 'all' }), 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Spend cap is back, in Watch. Turn on Enforce when you’re ready.');
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
    expect(editor()).toContain('Watch: records what it would do; every call goes through.');
    // Three modes in one control; the action only in Enforce.
    expect([...m.el.querySelectorAll('[aria-label="What happens"] button')].map((b) => b.textContent)).toEqual(['Off', 'Watch', 'Enforce']);
    expect(m.seg('Watch')!.getAttribute('aria-checked')).toBe('true');
    expect(m.action()).toBeNull();
    await m.pick('Off');
    expect(editor()).toContain('Off: does nothing and records nothing.');
    expect(m.action()).toBeNull();
    await m.pick('Enforce');
    expect(m.action()!.value).toBe('block');
    expect([...m.action()!.options].map((o) => o.textContent)).toEqual(['Block the call', 'Only alert me']);
    expect(editor()).toContain('Enforce: blocks the call. The agent keeps going.');
    await m.pick('Only alert me');
    expect(editor()).toContain('Enforce: alerts you. The call goes through.');
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
    await m.pick('Watch');
    await m.click(m.button('Save'));
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    expect(dialog.textContent).toContain('Stop blocking with this rule?');
    expect(dialog.textContent).toContain('Matching calls will go through for all agents. They’ll still be recorded.');
    expect(m.button('Keep blocking')!.className).toContain('wr-btn--primary');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Keep blocking'));
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Save'));
    await m.click(m.button('Switch to Watch'));
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

  it('shows what the fleet really spends a day behind When’s ⓘ, for a dollars-a-day cap', async () => {
    const whenHint = (x: { el: HTMLElement }) => x.el.querySelector('aside .ctl-q [aria-label^="What is this?"]')?.getAttribute('aria-label') ?? '';
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
    expect(whenHint(m2)).toContain('Your fleet spends about $13 a day, all agents together (last 14 days).');
    m2.root.unmount();
    api.hourly = [{ hour: ago(1.5), costMicros: 4_000_000 }, { hour: ago(0.5), costMicros: 3_000_000 }];
    const m3 = await mount();
    await m3.open('$190');
    expect(whenHint(m3)).toContain('Your fleet spends about $3.50 a day, all agents together (last 2 days).');
    m3.root.unmount();
    // Only beside a dollars-a-day cap: not per run, not in tokens.
    const m4 = await mount();
    await m4.open('$190');
    await choose(m4.el.querySelector('select[aria-label="Limit period"]') as HTMLSelectElement, 'run');
    expect(whenHint(m4)).not.toContain('Your fleet spends about');
    await choose(m4.el.querySelector('select[aria-label="Limit period"]') as HTMLSelectElement, 'day');
    await choose(m4.el.querySelector('select[aria-label="Limit unit"]') as HTMLSelectElement, 'tokens');
    expect(whenHint(m4)).not.toContain('Your fleet spends about');
    m4.root.unmount();
  });

  it('narrowing a rule for all agents can keep it and add a copy just for them', async () => {
    api.create.mockImplementation(async (_f: string, r: Record<string, unknown>) => { const rule = { ...base, id: 'r9', ...r }; api.created.push(rule as GovernanceRule); return { rule }; });
    const m = await mount();
    await m.open('$190');
    await choose(m.el.querySelector('select[aria-label="Which agents this rule applies to"]') as HTMLSelectElement, 'some');
    await choose(m.el.querySelector('select[aria-label="Add an agent"]') as HTMLSelectElement, 'lead-agent');
    // Who's ⓘ says Save will ask.
    expect(m.el.querySelector('aside [aria-label*="keep this rule for everyone and add a copy, or move it"]')).toBeTruthy();
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
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Added a Spend cap rule just for lead-agent, in Watch. Everyone else keeps the original.');
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
    await m.pick('Only alert me');
    await m.click(m.button('Save'));
    expect([...m.el.querySelectorAll('dialog[open]')].at(-1)!.textContent).toContain('Turn on alerts for this rule?');
    expect(m.button('Start blocking')).toBeUndefined();
    await m.click(m.button('Turn on alerts'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', expect.objectContaining({ mode: 'enforce' }), 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Saved. Keywords is on for all agents.');
    m.root.unmount();
  });

  it('a Tool list says streamed calls are checked in Watch, and what Enforce does to streamed and Bedrock calls', async () => {
    api.created.push({ ...base, id: 't1', ruleType: 'tool_list', mode: 'watch', response: 'block', appliesTo: 'all', params: { blockedTools: ['delete_record'] } });
    const m = await mount();
    await m.open('delete_record');
    const hint = m.el.querySelector('aside .ctl-q [aria-label^="What is this?"]')?.getAttribute('aria-label') ?? '';
    expect(hint).toContain('In Watch, streamed calls are checked after they arrive. In Enforce, a streamed call that can use a listed tool arrives all at once, and a Bedrock one is refused.');
    expect(hint).not.toMatch(/aren’t checked|can’t be checked|before it streams/);
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
    expect(hint()).not.toContain('Bedrock replies are checked in Watch; in Enforce, Bedrock calls are refused.');
    await choose(where, 'both');
    expect(hint()).toContain('To block a streamed reply, it’s checked whole first, so its text arrives all at once. Bedrock replies are checked in Watch; in Enforce, Bedrock calls are refused.');
    expect(hint()).not.toMatch(/can’t be checked|streamed calls aren’t checked/);
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
    await m.pick('Off');
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Mode: Watch → Off');
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
      await m.pick('Only alert me');
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
    // Block on incoming data waits a day; Only alert me never does, so Enforce opens on it.
    const block = (await m.option('Block the call'))!;
    expect(block.disabled).toBe(true);
    expect(block.textContent).toMatch(/^Block the call · from .+, after 24 hours in Watch$/);
    expect((await m.option('Only alert me'))!.disabled).toBe(false);
    expect(m.action()!.value).toBe('notify');
    expect(m.text()).toContain('Enforce: alerts you. The call goes through.');
    // Looking only at replies, Block doesn't wait.
    await choose(m.el.querySelector('select[aria-label="Where to look"]') as HTMLSelectElement, 'replies');
    expect((await m.option('Block the call'))!.disabled).toBe(false);
    expect(api.update).not.toHaveBeenCalled();
    m.root.unmount();
  });

  it('after a day, blocking incoming data is confirmed by typing who it covers', async () => {
    api.created.push(keywordRule({ response: 'block' }));
    api.history = [{ id: 'h1', ruleId: 'k1', ruleType: 'keyword', description: 'Added new Keywords rule', by: 'test', time: new Date(Date.now() - 2 * 86_400_000).toISOString() }];
    api.update.mockImplementation(async (_f: string, _id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...keywordRule({ response: 'block' }), ...ch, version: 2 } }));
    const m = await mount();
    await m.open('"Project Falcon"');
    await m.pick('Block the call');
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Let this rule block calls on incoming data?');
    const dialog = [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
    await type(dialog.querySelector('input') as HTMLInputElement, 'block all agents');
    await m.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Block on incoming data'));
    expect(api.update).toHaveBeenCalledWith('f1', 'k1', { mode: 'enforce', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('Add a rule offers Flag keywords, with its category and no New tag', async () => {
    const m = await mount();
    const option = [...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Flag keywords'));
    expect(option?.querySelector('.ctl-cat')?.textContent).toBe('Data protection');
    expect(option?.querySelector('.wr-tag')).toBeNull();
    m.root.unmount();
  });
});

describe('Controls page, mockup suggestions and toasts', () => {
  const dlg = (m: Awaited<ReturnType<typeof mount>>) => [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
  const created = () => api.create.mockImplementation(async (_f: string, r: Record<string, unknown>) => { const rule = { ...base, id: `c${api.created.length}`, response: 'block', ...r } as GovernanceRule; api.created.push(rule); return { rule }; });

  it('two identical rules: Remove one takes the extra away at once, and Undo adds it back in Watch', async () => {
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

  it('a Keywords rule for one agent: Cover all agents confirms, adds a copy for everyone in Watch, and Undo removes it', async () => {
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
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('"password" rule now covers all agents (Watch).');
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
    // The engine keeps what it saved: the reload lists version 5.
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: (api.saved[id] = { ...api.saved[id], ...ch, version: 5 } as GovernanceRule) }));
    const m = await mount();
    await m.click(m.button('Add to allowlist…'));
    await m.click(m.button('Allow for all agents'));
    await m.click(m.button('Undo'));
    expect(api.update).toHaveBeenLastCalledWith('f1', 'r2', { params: { allowedModels: ['claude-haiku-4-5-20251001'] }, ifVersion: 5, description: 'Undid the last change' }, 'k');
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('Undone. Model allowlist is back to how it was (Watch).');
    m.root.unmount();
  });

  it('Undo of a suggested new allowlist removes it even when the reload after adding it failed', async () => {
    api.models = ['gpt-4o'];
    api.create.mockImplementation(async (_f: string, r: Partial<GovernanceRule>) => {
      const rule = { ...base, id: 'a1', response: 'block', appliesTo: 'all', ...r } as GovernanceRule;
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    api.listFail = true;
    await m.click(m.button('Add allowlist…'));
    await m.click(m.button('Add in Watch'));
    expect(api.create).toHaveBeenCalled();
    api.listFail = false;
    await m.click(m.button('Undo'));
    expect(api.remove).toHaveBeenCalledWith('f1', 'a1', 'k');
    m.root.unmount();
  });

  it('Undo of an added rule reads it fresh first, and leaves a teammate’s newer edit alone', async () => {
    api.models = ['gpt-4o'];
    api.create.mockImplementation(async (_f: string, r: Partial<GovernanceRule>) => {
      const rule = { ...base, id: 'a1', response: 'block', appliesTo: 'all', ...r } as GovernanceRule;
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add allowlist…'));
    await m.click(m.button('Add in Watch'));
    // A teammate edits it after the page last loaded: only the engine knows.
    api.created[0] = { ...api.created[0], version: api.created[0].version + 1 };
    await m.click(m.button('Undo'));
    expect(api.remove).not.toHaveBeenCalled();
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('This rule changed again since, so Undo left it as it is.');
    m.root.unmount();
  });

  it('Undo of an added rule says it’s gone when the fresh read no longer lists it', async () => {
    api.models = ['gpt-4o'];
    api.create.mockImplementation(async (_f: string, r: Partial<GovernanceRule>) => {
      const rule = { ...base, id: 'a1', response: 'block', appliesTo: 'all', ...r } as GovernanceRule;
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add allowlist…'));
    await m.click(m.button('Add in Watch'));
    // A teammate removes it after the page last loaded: only the engine knows.
    api.created = [];
    await m.click(m.button('Undo'));
    expect(api.remove).not.toHaveBeenCalled();
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('That rule isn’t here any more, so there’s nothing to undo.');
    m.root.unmount();
  });

  it('Undo of an added rule deletes nothing when the fresh read fails', async () => {
    api.models = ['gpt-4o'];
    api.create.mockImplementation(async (_f: string, r: Partial<GovernanceRule>) => {
      const rule = { ...base, id: 'a1', response: 'block', appliesTo: 'all', ...r } as GovernanceRule;
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add allowlist…'));
    await m.click(m.button('Add in Watch'));
    api.listFail = true;
    await m.click(m.button('Undo'));
    expect(api.remove).not.toHaveBeenCalled();
    expect(m.text()).not.toContain('Change undone.');
    expect(m.text()).toContain('Couldn’t');
    m.root.unmount();
  });

  it('a refused allowlist suggestion says so and leaves the open allowlist open', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all' };
    api.update.mockRejectedValue(new WhiteRoomApiError('changed', 409));
    const m = await mount();
    await m.open('Only claude');
    await m.click(m.button('Add to allowlist…'));
    await m.click(m.button('Allow for all agents'));
    expect(m.text()).toContain('Your Model allowlist changed somewhere else, so the suggestion wasn’t added.');
    expect(m.el.querySelector('aside[aria-label="Edit rule"]')).toBeTruthy();
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

  it('Undo of an added copy says it’s gone, rather than delete, when a reload no longer lists it', async () => {
    api.created.push({ ...base, id: 'kw', ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: ['lead-agent'], params: { keywords: ['password'], where: 'incoming', wholeWord: true } });
    // A teammate removes the copy straight after: the reload doesn't list it.
    api.create.mockImplementation(async (_f: string, r: Record<string, unknown>) => ({ rule: { ...base, id: 'c0', response: 'block', ...r } as GovernanceRule }));
    const m = await mount();
    await m.click(m.button('Cover all agents…'));
    await m.click(m.button('Cover all agents'));
    await m.click(m.button('Undo'));
    expect(api.remove).not.toHaveBeenCalled();
    expect(m.el.querySelector('.wr-toast')!.textContent).toContain('That rule isn’t here any more, so there’s nothing to undo.');
    m.root.unmount();
  });

  it('the allowlist toast Undo, refused because the rule changed again, says so', async () => {
    api.models = ['gpt-4o'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all' };
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => {
      if (api.update.mock.calls.length > 1) throw new WhiteRoomApiError('changed', 409);
      return { rule: (api.saved[id] = { ...api.saved[id], ...ch, version: 5 } as GovernanceRule) };
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

  it('during the wait, a rule that would Stop opens Enforce on an action it can take now', async () => {
    api.govV1 = true;
    api.saved.r2 = { ...RULES[1], response: 'stop' };
    api.history = [{ id: 'h1', ruleId: 'r2', ruleType: 'model_allowlist', description: 'Added new Model allowlist rule', by: 'test', time: new Date(Date.now() - 60_000).toISOString() }];
    const m = await mount();
    await m.open('Only claude');
    // In Watch the action stays as saved, and no dropdown shows.
    expect(m.action()).toBeNull();
    expect(m.el.querySelector('.gov-edhead__mode')).toBeTruthy();
    await m.pick('Enforce');
    expect(m.action()!.value).toBe('block');
    expect((await m.option('Stop the agent'))!.disabled).toBe(true);
    // Back to Watch: the saved action returns, so nothing changed.
    await m.pick('Watch');
    expect(m.button('Save')!.disabled).toBe(true);
    m.root.unmount();
  });

  it('words the Start confirm by what the rule does: Pause ends the run', async () => {
    api.govV1 = true;
    const m = await mount();
    await m.open('Only claude');
    await m.pick('Pause the agent');
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

  it('before Enforce, warns when an allowlist would block every call an agent makes', async () => {
    api.would = { r2: { 'market-researcher': 12 } };
    api.agentCalls = { 'market-researcher': 12 };
    const m = await mount();
    await m.open('Only claude');
    await m.pick('Block the call');
    await m.click(m.button('Save'));
    await flush();
    expect(dlg(m).textContent).toContain('This would block every call market-researcher makes.');
    m.root.unmount();
  });

  it('has no audit button: Home, Runs and Settings carry it', async () => {
    const m = await mount();
    await m.open('Only claude');
    expect([...m.el.querySelectorAll('button')].some((b) => b.textContent === 'Check audit trail')).toBe(false);
    m.root.unmount();
  });

  it('rule history has a plain link to test the rules in Sandbox', async () => {
    const m = await mount();
    await m.open('Only claude');
    const link = [...m.el.querySelectorAll('a')].find((x) => x.textContent === 'Test in Sandbox');
    expect(link?.getAttribute('href')).toBe('/sandbox/practice');
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

// An unsaved edit survives leaving the page (bug-fix spec PR D, finding 12):
// Back/Forward can't be held back in the App Router, so the draft is kept for
// this tab and restored on return, restore first and then keep.
describe('Controls › an unsaved edit comes back', () => {
  const KEY = 'wr_controls_draft:f1';
  const limit = (m: Awaited<ReturnType<typeof mount>>) => (m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement | null)?.value;
  const saved = () => JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { ruleId: string; version: number; draft: { number: string } } | null;
  async function editAndLeave(value = '250') {
    const m = await mount();
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, value);
    expect(saved()).toMatchObject({ ruleId: 'r3', version: 1, draft: { number: value } });
    await act(async () => m.root.unmount()); // Back: the page goes away, nothing asked
    document.body.innerHTML = '';
  }

  it('Back then Forward: the edit is back in the editor, with a note', async () => {
    await editAndLeave();
    const m = await mount();
    expect(limit(m)).toBe('250');
    expect(m.text()).toContain('Your unsaved change to Spend cap is back. Save or discard it.');
    expect(m.button('Save')!.disabled).toBe(false);
    m.root.unmount();
  });

  it('the note goes once the edit is discarded, saved or edited back', async () => {
    const NOTE = 'Your unsaved change to Spend cap is back.';
    const input = (m: Awaited<ReturnType<typeof mount>>) => m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement;
    await editAndLeave();
    let m = await mount();
    expect(m.text()).toContain(NOTE);
    await m.click(m.button('Discard changes'));
    expect(limit(m)).toBe('190');
    expect(m.text()).not.toContain(NOTE);
    m.root.unmount(); document.body.innerHTML = '';

    await editAndLeave();
    m = await mount();
    expect(m.text()).toContain(NOTE);
    await type(input(m), '190');
    expect(m.text()).not.toContain(NOTE);
    m.root.unmount(); document.body.innerHTML = '';

    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => {
      const rule = { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } as GovernanceRule;
      api.saved[id] = rule;
      return { rule };
    });
    await editAndLeave('150');
    m = await mount();
    expect(m.text()).toContain(NOTE);
    await m.click(m.button('Save'));
    expect(m.text()).not.toContain(NOTE);
    m.root.unmount();
  });

  it('with the rules slow to load, the saved edit is untouched until they arrive, then restored', async () => {
    await editAndLeave();
    let open!: () => void;
    api.listGate = new Promise<void>((r) => { open = r; });
    const m = await mount();
    expect(saved()?.draft.number).toBe('250'); // the first render (nothing selected) didn't wipe it
    await act(async () => open()); await flush();
    expect(limit(m)).toBe('250');
    m.root.unmount();
  });

  it('if the rules fail to load, the saved edit waits for the next visit', async () => {
    await editAndLeave();
    api.listFail = true;
    let m = await mount();
    expect(saved()?.draft.number).toBe('250');
    m.root.unmount(); document.body.innerHTML = '';
    api.listFail = false;
    m = await mount();
    expect(limit(m)).toBe('250');
    m.root.unmount();
  });

  it('a link to another rule wins; the edit is kept until another rule is edited', async () => {
    await editAndLeave();
    nav.params = new URLSearchParams('rule=r4');
    const m = await mount();
    expect(m.text()).not.toContain('is back');
    expect(saved()?.ruleId).toBe('r3');
    await m.click(m.button('Change'));
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '210');
    expect(saved()).toMatchObject({ ruleId: 'r4', draft: { number: '210' } });
    m.root.unmount();
  });

  it('a rule changed since the edit: the edit is dropped, and the note says so', async () => {
    await editAndLeave();
    api.saved.r3 = { ...RULES[2], version: 2 };
    const m = await mount();
    expect(m.text()).toContain('Spend cap changed since you edited it, so your unsaved change was dropped.');
    expect(saved()).toBeNull();
    m.root.unmount();
  });

  it('a rule removed since: the edit is dropped quietly', async () => {
    await editAndLeave();
    api.empty = true;
    const m = await mount();
    expect(saved()).toBeNull();
    expect(m.text()).not.toContain('unsaved change');
    m.root.unmount();
  });

  it('Save clears it', async () => {
    // The server keeps what was saved, so the reload after Save lists it.
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => {
      const rule = { ...RULES.find((r) => r.id === id)!, ...ch, version: 2 } as GovernanceRule;
      api.saved[id] = rule;
      return { rule };
    });
    const m = await mount();
    await m.open('$190');
    // Lower (stricter), so Save goes straight through without the "make it weaker?" confirm.
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    expect(saved()).not.toBeNull();
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalled();
    expect(saved()).toBeNull();
    m.root.unmount();
  });

  it('Discard clears it', async () => {
    const m = await mount();
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '250');
    await m.click(m.button('Discard changes'));
    expect(saved()).toBeNull();
    m.root.unmount();
  });

  it('editing back to the saved value clears it', async () => {
    const m = await mount();
    await m.open('$190');
    const input = () => m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement;
    await type(input(), '250');
    expect(saved()).not.toBeNull();
    await type(input(), '190');
    expect(saved()).toBeNull();
    m.root.unmount();
  });

  it('storage that throws: the page still works, and keeps nothing', async () => {
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    try {
      const m = await mount();
      await m.open('$190');
      await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '250');
      expect(m.button('Save')!.disabled).toBe(false);
      m.root.unmount();
    } finally {
      Object.defineProperty(window, 'sessionStorage', real);
    }
    expect(saved()).toBeNull();
  });

  it('a save refused because the rule changed elsewhere drops the kept edit too', async () => {
    const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
    api.update.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 409', 409));
    const m = await mount();
    await m.open('$190');
    await type(m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    expect(saved()).not.toBeNull();
    await m.click(m.button('Save'));
    expect(m.text()).toContain('This rule changed somewhere else');
    expect(saved()).toBeNull();
    m.root.unmount();
  });

  it('"Discard changes" in the leave dialog drops the kept edit', async () => {
    const m = await mount();
    await m.open('Only claude');
    await m.pick('Block the call');
    expect(saved()?.ruleId).toBe('r2');
    await m.click(m.button('‹ Controls'));
    await m.click([...[...m.el.querySelectorAll('dialog[open]')].at(-1)!.querySelectorAll('button')].find((b) => b.textContent === 'Discard changes'));
    expect(saved()).toBeNull();
    m.root.unmount();
  });

  it('a suggestion being added (?rec=) comes first; the kept edit waits for a later visit', async () => {
    await editAndLeave();
    nav.params = new URLSearchParams('rec=rec_123');
    let m = await mount();
    expect(m.text()).toContain('Suggestion draft');
    expect(m.text()).not.toContain('is back');
    expect(saved()?.draft.number).toBe('250');
    m.root.unmount(); document.body.innerHTML = '';
    nav.params = new URLSearchParams();
    m = await mount();
    expect(limit(m)).toBe('250');
    m.root.unmount();
  });

  it('a kept edit for a rule that is now another kind is dropped', async () => {
    await editAndLeave();
    sessionStorage.setItem(KEY, JSON.stringify({ ...saved()!, draft: { ...saved()!.draft, ruleType: 'call_rate' } }));
    const m = await mount();
    expect(saved()).toBeNull();
    expect(m.text()).not.toContain('is back');
    m.root.unmount();
  });
});

describe('Controls: Watch counts in one read (engine PR 345)', () => {
  const dlg = (m: Awaited<ReturnType<typeof mount>>) => [...m.el.querySelectorAll('dialog[open]')].at(-1)!;
  /** The page, and what the allowlist confirm says (from rule_would_act). */
  async function caught() {
    api.models = ['claude-sonnet-4-5'];
    api.saved.r2 = { ...RULES[1], appliesTo: 'all' };
    api.would = { r2: { 'lead-agent': 44 } };
    const m = await mount();
    // The fallback takes a few more turns to land.
    await flush();
    const page = m.text();
    await m.click(m.button('Add to allowlist…'));
    return { m, page, shown: dlg(m).textContent };
  }

  it('reads every Watch rule in one request on a new engine', async () => {
    const { m, shown } = await caught();
    expect(shown).toContain('the allowlist caught 44 calls from lead-agent');
    // r2, r3 and r4 are the Watch rules.
    expect(api.wouldBatches).toEqual([3]);
    expect(api.wouldSingle).toBe(0);
    m.root.unmount();
  });

  it('falls back to one read per rule on an older engine, shows the same, and doesn’t ask it the batch again', async () => {
    const fresh = await caught();
    fresh.m.root.unmount();
    document.body.innerHTML = '';
    resetBatchSupport();
    api.wouldBatches = []; api.wouldSingle = 0; api.oldEngine = true;
    const old = await caught();
    expect(old.page).toBe(fresh.page);
    expect(old.shown).toBe(fresh.shown);
    expect(api.wouldBatches).toEqual([3]);
    expect(api.wouldSingle).toBe(3);
    // A reload (here after a failed save) goes straight to the single reads.
    await old.m.click([...dlg(old.m).querySelectorAll('button')].find((b) => b.textContent === 'Cancel'));
    api.update.mockRejectedValue(new Error('network down'));
    await old.m.open('$190');
    await type(old.m.el.querySelector('input[aria-label="Spend limit"]') as HTMLInputElement, '150');
    await old.m.click(old.m.button('Save'));
    await flush();
    expect(api.wouldBatches).toEqual([3]);
    expect(api.wouldSingle).toBe(6);
    old.m.root.unmount();
  });
});

// Data-protection spec, phase 2: each rule's category label on its row, in the
// editor and in Add a rule. The Add a rule choices lose the rule name beside the title.
describe('Controls: category labels', () => {
  const keyword: GovernanceRule = { ...base, id: 'k1', ruleType: 'keyword', mode: 'watch', response: 'notify', appliesTo: 'all', params: { keywords: ['Project Falcon'], where: 'incoming', wholeWord: true } };
  const send: GovernanceRule = { ...base, id: 's1', ruleType: 'send_limit', mode: 'watch', response: 'notify', appliesTo: 'all', params: { tools: ['send_email'], domains: ['acme.com'] } };
  const flow: GovernanceRule = { ...base, id: 'o1', ruleType: 'outside_then_send', mode: 'watch', response: 'notify', appliesTo: 'all', params: { readTools: ['web_fetch'], sendTools: ['send_email'] } };
  // Every type, each with a row in view (the fleet's Tool list is off, in a closed card).
  const streak: GovernanceRule = { ...base, id: 'b1', ruleType: 'block_streak', mode: 'watch', response: 'notify', appliesTo: 'all', params: { threshold: 3 } };
  const trim: GovernanceRule = { ...base, id: 't1', ruleType: 'trim_results', mode: 'watch', response: 'notify', appliesTo: 'all', params: { keepRecent: 5, minTokens: 50_000 } };
  const everyType = () => { api.created.push(keyword, send, flow, streak, trim); api.saved.r6 = { ...RULES[5], mode: 'watch', params: { blockedTools: ['delete_file'] } }; };
  const nameToCat = Object.fromEntries(Object.entries(RULE_LABELS).map(([t, name]) => [name, RULE_CATEGORY[t as keyof typeof RULE_CATEGORY]]));

  it('shows each row’s category above its count and mode tag, for every type', async () => {
    everyType();
    const m = await mount();
    const rows = [...m.el.querySelectorAll('button.ctl-row')];
    const seen = rows.map((r) => {
      const name = r.querySelector('.ctl-row__main .ctl-cap')!.textContent!;
      const side = r.querySelector('.ctl-row__side')!;
      expect(side.firstElementChild?.className).toBe('ctl-cat');
      expect(side.querySelector('.ctl-row__state .ctl-mtag')).toBeTruthy();
      expect(side.querySelector('.ctl-cat')!.textContent).toBe(nameToCat[name]);
      return name;
    });
    expect(new Set(seen)).toEqual(new Set(Object.values(RULE_LABELS)));
    m.root.unmount();
  });

  it('shows the category in the editor beside Close, with the name under it and again in the body for a phone', async () => {
    everyType();
    const m = await mount();
    const names = [...m.el.querySelectorAll('button.ctl-row .ctl-row__main .ctl-cap')].map((c) => c.textContent!);
    const opened = new Set<string>();
    for (const name of names) {
      await m.click([...m.el.querySelectorAll('button.ctl-row')].find((r) => r.querySelector('.ctl-row__main .ctl-cap')?.textContent === name));
      const head = m.el.querySelector('.gov-edhead')!;
      expect([...head.children].map((c) => c.className.split(' ')[0])).toEqual(['gov-edhead__back', 'ctl-cat', 'wr-btn', 'gov-edhead__title', 'gov-edhead__mode']);
      expect(head.querySelector('.ctl-cat')!.textContent).toBe(nameToCat[name]);
      expect(head.querySelector('h2')!.textContent).toBe(name);
      expect(m.el.querySelector('.gov-edhead__full')!.textContent).toBe(nameToCat[name] + name);
      opened.add(name);
    }
    expect(opened.size).toBe(10);
    m.root.unmount();
  });

  it('Add a rule shows each choice’s title, category and description, and no rule name', async () => {
    api.ruleTypes = RULE_TEMPLATES.map((t) => t.type);
    const m = await mount();
    await m.click(m.button('Add rule'));
    const options = [...m.el.querySelectorAll('button.gov-template')];
    expect(options.map((o) => o.textContent)).toEqual(RULE_TEMPLATES.map((t) => t.title + RULE_CATEGORY[t.type] + t.desc));
    expect(options.map((o) => o.querySelector('.gov-template__top > .ctl-cat')?.textContent)).toEqual(RULE_TEMPLATES.map((t) => RULE_CATEGORY[t.type]));
    // No "New" tag on the new rule (owner, Nov 14).
    expect(options.at(-1)!.textContent).not.toMatch(/\bNew\b/);
    m.root.unmount();
  });
});

// Data-protection spec, phase 3 (D5): Where tools can send data.
describe('Controls: Where tools can send data', () => {
  const ALL_TYPES = ['spend_cap', 'loop_breaker', 'model_allowlist', 'tool_list', 'call_rate', 'keyword', 'send_limit'];
  const sendRule = (over: Partial<GovernanceRule> = {}, params: Record<string, unknown> = {}): GovernanceRule => ({
    ...base, id: 's1', ruleType: 'send_limit', mode: 'watch', response: 'notify', appliesTo: 'all', params: { tools: ['send_email', 'post_message'], domains: ['acme.com'], ...params } as GovernanceRule['params'], ...over,
  });
  const seenRows = [
    { tool: 'send_email', domain: 'gmail.com', agentId: 'support-agent', firstSeen: '2026-11-12T10:00:00Z' },
    { tool: 'post_message', domain: '(none)', agentId: 'support-agent', firstSeen: '2026-11-11T10:00:00Z' },
    { tool: 'send_email', domain: '(unreadable)', agentId: 'support-agent', firstSeen: '2026-11-11T09:00:00Z' },
    { tool: 'send_email', domain: 'x-[cleaned].example', agentId: 'support-agent', firstSeen: '2026-11-10T09:00:00Z', canAdd: false },
  ];
  const seenRow = (m: Awaited<ReturnType<typeof mount>>, needle: string) => [...m.el.querySelectorAll('.ctl-seen__row')].find((r) => r.textContent?.includes(needle));
  const dlg = (m: Awaited<ReturnType<typeof mount>>) => [...m.el.querySelectorAll('dialog[open]')].at(-1);
  const saving = () => api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.created.find((r) => r.id === id)!, ...ch, version: 2 } }));

  it('is offered in Add a rule only when the engine’s ruleTypes has it', async () => {
    const titles = async () => {
      const m = await mount();
      await m.click(m.button('Add rule'));
      const t = [...m.el.querySelectorAll('button.gov-template .gov-template__title')].map((b) => b.textContent);
      m.root.unmount();
      document.body.innerHTML = '';
      return t;
    };
    expect(await titles()).not.toContain('Limit where tools can send data');
    api.ruleTypes = ALL_TYPES.filter((t) => t !== 'send_limit');
    expect(await titles()).not.toContain('Limit where tools can send data');
    api.ruleTypes = ALL_TYPES;
    expect(await titles()).toContain('Limit where tools can send data');
  });

  it('is added in Watch on Only alert me, with likely senders picked', async () => {
    api.ruleTypes = ALL_TYPES;
    api.tools = ['search_docs', 'send_email', 'http_request', 'delete_record'];
    api.create.mockImplementation(async (_f: string, r: { ruleType: GovernanceRule['ruleType']; mode: GovernanceRule['mode']; response?: GovernanceRule['response']; params?: GovernanceRule['params'] }) => {
      const rule: GovernanceRule = { ...base, id: 'new', ruleType: r.ruleType, mode: r.mode, response: r.response, appliesTo: 'all', params: r.params! };
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add rule'));
    await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Limit where tools can send data')));
    expect(api.create).toHaveBeenCalledWith('f1', { ruleType: 'send_limit', mode: 'watch', response: 'notify', params: { tools: ['send_email', 'http_request'], domains: [] } }, 'k');
    expect(m.text()).toContain('Where tools can send data rule added in Watch. Check its tools.');
    // A new rule opens with When expanded: the empty list says how to build it.
    expect(m.text()).toContain('Nothing is allowed yet. Leave this in Watch to see where these tools send data, then add what’s fine.');
    m.root.unmount();
  });

  it('shows Seen with When collapsed; reserved and cleaned rows have no Add to list', async () => {
    api.created.push(sendRule());
    api.seenRows = { s1: seenRows };
    const m = await mount();
    expect(m.row('sends to a domain').textContent).toContain('send_email or post_message sends to a domain that isn’t on the list');
    await m.click(m.row('sends to a domain'));
    expect(api.seenAsked).toEqual(['s1']);
    expect(m.button('Change')).toBeTruthy();
    expect(m.text()).toContain('Seen, not on the list');
    expect(seenRow(m, 'gmail.com')!.textContent).toContain('support-agent · send_email');
    expect(seenRow(m, 'gmail.com')!.querySelector('button')?.textContent).toBe('Add to list');
    for (const n of ['No domain found', 'Couldn’t read the domain', 'x-[cleaned].example']) expect(seenRow(m, n)!.querySelector('button'), n).toBeNull();
    expect(m.text()).toContain('Only the domain is stored, never what was sent.');
    // The no-domain note shows once the tool has made such a call, under When.
    await m.click(m.button('Change'));
    expect(m.text()).toContain('post_message: no domain found. Block would stop every call it makes.');
    m.root.unmount();
  });

  it('says “Nothing new.” for an empty Seen list, the cap at 500, and no no-domain note on a rule with no calls', async () => {
    api.created.push(sendRule());
    const m = await mount();
    await m.open('sends to a domain');
    expect(m.text()).toContain('Nothing new.');
    expect(m.text()).not.toContain('Only the domain is stored');
    expect(m.text()).not.toContain('no domain found');
    m.root.unmount();
    document.body.innerHTML = '';
    api.seenFull = true;
    api.seenRows = { s1: [seenRows[0]] };
    const full = await mount();
    await full.click(full.row('sends to a domain'));
    expect(full.text()).toContain('More than 500 domains seen. Showing the first 500.');
    full.root.unmount();
  });

  it('stages Add to list; in Watch Save applies it without asking', async () => {
    api.created.push(sendRule());
    api.seenRows = { s1: seenRows };
    saving();
    const m = await mount();
    await m.click(m.row('sends to a domain'));
    await m.click(seenRow(m, 'gmail.com')!.querySelector('button')!);
    expect(api.update).not.toHaveBeenCalled();
    expect(m.text()).toContain('gmail.com added. Save to apply.');
    expect(seenRow(m, 'gmail.com')).toBeUndefined();
    await m.click(m.button('Save'));
    expect(dlg(m)).toBeUndefined();
    expect(api.update).toHaveBeenCalledWith('f1', 's1', { params: { tools: ['send_email', 'post_message'], domains: ['acme.com', 'gmail.com'] }, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('in Enforce, Save of a staged Add to list asks “weaker?” first', async () => {
    api.created.push(sendRule({ mode: 'enforce', response: 'block' }));
    api.seenRows = { s1: seenRows };
    saving();
    const m = await mount();
    await m.click(m.row('sends to a domain'));
    // Block's own help: streamed replies and Bedrock.
    expect(m.text()).toContain('Streamed replies from agents with these tools arrive all at once. Replies on Bedrock can’t be checked yet.');
    await m.click(seenRow(m, 'gmail.com')!.querySelector('button')!);
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Make the Where tools can send data rule weaker?');
    expect(m.text()).toContain('Also allows gmail.com');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Save the change'));
    expect(api.update).toHaveBeenCalledWith('f1', 's1', { params: { tools: ['send_email', 'post_message'], domains: ['acme.com', 'gmail.com'] }, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('says what Only alert me does for this rule', async () => {
    api.created.push(sendRule({ mode: 'enforce', response: 'notify' }));
    const m = await mount();
    await m.click(m.row('sends to a domain'));
    expect(m.text()).toContain('You get an alert the first time a tool sends to a new domain. The call goes through.');
    expect(m.text()).not.toContain('Streamed replies from agents');
    m.root.unmount();
  });

  it('at 100 domains, says why Add to list is off', async () => {
    api.created.push(sendRule({}, { domains: Array.from({ length: 100 }, (_, i) => `d${i}.com`) }));
    api.seenRows = { s1: seenRows };
    const m = await mount();
    await m.click(m.row('sends to a domain'));
    expect((seenRow(m, 'gmail.com')!.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(m.text()).toContain('A rule allows up to 100 domains. Remove one to add another.');
    m.root.unmount();
  });

  it('a failed Seen read says so, and Try again reads it again', async () => {
    api.created.push(sendRule());
    api.seenRows = { s1: seenRows };
    api.seenFail = true;
    const m = await mount();
    await m.click(m.row('sends to a domain'));
    expect(m.text()).toContain('Couldn’t load this list.');
    expect(seenRow(m, 'gmail.com')).toBeUndefined();
    api.seenFail = false;
    await m.click(m.button('Try again'));
    expect(api.seenAsked).toEqual(['s1', 's1']);
    expect(seenRow(m, 'gmail.com')).toBeTruthy();
    m.root.unmount();
  });

  it('reads Seen again after a save, and never shows one rule’s rows on another', async () => {
    api.created.push(sendRule(), sendRule({ id: 's2', appliesTo: ['lead-agent'] }, { tools: ['upload_file'] }));
    api.seenRows = { s1: seenRows, s2: [] };
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => {
      const prev = api.created.find((r) => r.id === id)!;
      const next = { ...prev, ...ch, version: prev.version + 1 } as GovernanceRule;
      api.created = api.created.map((r) => (r.id === id ? next : r));
      return { rule: next };
    });
    const m = await mount();
    await m.click(m.row('send_email or post_message'));
    await m.click(seenRow(m, 'gmail.com')!.querySelector('button')!);
    // The engine drops the row the list now allows.
    api.seenRows = { s1: seenRows.slice(1), s2: [] };
    await m.click(m.button('Save'));
    await flush();
    expect(api.seenAsked).toEqual(['s1', 's1']);
    expect(seenRow(m, 'gmail.com')).toBeUndefined();
    await m.click(m.row('upload_file'));
    expect(api.seenAsked.at(-1)).toBe('s2');
    expect(m.text()).toContain('Nothing new.');
    expect(seenRow(m, 'Couldn’t read the domain')).toBeUndefined();
    m.root.unmount();
  });

  it('shows the engine’s refusal of a domain on Save in plain words', async () => {
    api.created.push(sendRule());
    api.update.mockRejectedValue(new WhiteRoomApiError('HTTP 400', 400, '"co.uk": that ending is shared by many sites. Enter a domain under it.'));
    const m = await mount();
    await m.open('sends to a domain');
    await type(m.el.querySelector('input[aria-label="Domain"]') as HTMLInputElement, 'co.uk');
    await m.click(m.button('Add'));
    await m.click(m.button('Save'));
    await flush();
    expect(m.text()).toContain('Couldn’t save the rule. “co.uk”: That ending is shared by many sites, like co.uk. Type the full domain, like acme.co.uk.');
    m.root.unmount();
  });

  it('a removed rule whose domains were hidden offers no Undo that would add it back empty', async () => {
    api.history = [{ id: 'hs', ruleId: 'gone', ruleType: 'send_limit', description: 'Removed Where tools can send data rule', by: 'user:u1', time: '2026-11-14T00:00:00Z',
      before: { mode: 'watch', response: 'notify', alsoNotify: false, appliesTo: 'all', params: { tools: ['send_email'], domains: [], domainCount: 2 } }, after: null }];
    const m = await mount();
    expect(m.el.querySelector('aside')!.textContent).toContain('Where tools can send data');
    expect(m.button('Add it back')).toBeUndefined();
    m.root.unmount();
    document.body.innerHTML = '';
    // With the list, the same removal can be added back.
    (api.history[0].before as { params: Record<string, unknown> }).params = { tools: ['send_email'], domains: ['acme.com'] };
    const shown = await mount();
    expect(shown.button('Add it back')).toBeTruthy();
    shown.root.unmount();
  });

  it('a caller without the secret sees the count, read only, with no Seen list, and never saves the list', async () => {
    api.created.push(sendRule({}, { domains: [], domainCount: 3 }));
    saving();
    const m = await mount();
    await m.click(m.row('sends to a domain'));
    expect(m.text()).toContain('3 domains are hidden here.');
    expect(m.text()).not.toContain('Seen, not on the list');
    expect(api.seenAsked).toEqual([]);
    expect(m.button('Change')!.closest('fieldset')!.disabled).toBe(true);
    expect(m.button('Save')!.disabled).toBe(true);
    expect(m.el.querySelector('input[aria-label="Domain"]')).toBeNull();
    // Who can't change either, so the rule can't be moved or copied with an empty list; nor removed (with an Undo that would add it back empty).
    expect(m.el.querySelector('select[aria-label="Which agents this rule applies to"]')!.closest('fieldset')!.disabled).toBe(true);
    expect([...m.el.querySelectorAll('aside button')].filter((b) => b.textContent === 'Remove rule').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(api.update).not.toHaveBeenCalled();
    m.root.unmount();
  });

  it('refuses a typed domain the engine would, in plain words, before Save', async () => {
    api.created.push(sendRule());
    const m = await mount();
    await m.open('sends to a domain');
    const input = m.el.querySelector('input[aria-label="Domain"]') as HTMLInputElement;
    await type(input, 'https://gmail.com');
    expect(m.text()).toContain('Type just the domain, like acme.com, without https://.');
    expect(m.button('Add')!.disabled).toBe(true);
    await type(input, 'Gmail.com');
    await m.click(m.button('Add'));
    expect([...m.el.querySelectorAll('.gov-chip')].map((c) => c.firstChild?.textContent)).toContain('gmail.com');
    m.root.unmount();
  });
});

// Data-protection spec, phase 4 (D6): Outside content, then send data.
describe('Controls: Outside content, then send data', () => {
  const ALL_TYPES = ['spend_cap', 'loop_breaker', 'model_allowlist', 'tool_list', 'call_rate', 'keyword', 'send_limit', 'outside_then_send'];
  const flowRule = (over: Partial<GovernanceRule> = {}, params: Record<string, unknown> = {}): GovernanceRule => ({
    ...base, id: 'o1', ruleType: 'outside_then_send', mode: 'watch', response: 'notify', appliesTo: 'all',
    params: { readTools: ['web_fetch', 'read_inbox'], sendTools: ['send_email', 'post_message'], ...params } as GovernanceRule['params'], ...over,
  });
  const WHEN = 'An agent reads outside content, then tries to send data out in the same run';

  it('is offered in Add a rule only when the engine’s ruleTypes has it', async () => {
    const titles = async () => {
      const m = await mount();
      await m.click(m.button('Add rule'));
      const t = [...m.el.querySelectorAll('button.gov-template .gov-template__title')].map((b) => b.textContent);
      m.root.unmount();
      document.body.innerHTML = '';
      return t;
    };
    expect(await titles()).not.toContain('Flag sends after outside content');
    api.ruleTypes = ALL_TYPES.filter((t) => t !== 'outside_then_send');
    expect(await titles()).not.toContain('Flag sends after outside content');
    api.ruleTypes = ALL_TYPES;
    expect(await titles()).toContain('Flag sends after outside content');
  });

  it('is a data protection choice with its own words, and no New tag', async () => {
    api.ruleTypes = ALL_TYPES;
    const m = await mount();
    await m.click(m.button('Add rule'));
    const choice = [...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Flag sends after outside content'))!;
    expect(choice.textContent).toBe('Flag sends after outside contentData protectionGet an alert when an agent reads a web page, email or file, then tries to send data out.');
    expect(choice.textContent).not.toMatch(/\bNew\b/);
    m.root.unmount();
  });

  it('is added in Watch on Only alert me, with likely readers and senders picked', async () => {
    api.ruleTypes = ALL_TYPES;
    api.tools = ['search_docs', 'web_fetch', 'send_email', 'read_inbox', 'http_request', 'delete_record'];
    api.create.mockImplementation(async (_f: string, r: { ruleType: GovernanceRule['ruleType']; mode: GovernanceRule['mode']; response?: GovernanceRule['response']; params?: GovernanceRule['params'] }) => {
      const rule: GovernanceRule = { ...base, id: 'new', ruleType: r.ruleType, mode: r.mode, response: r.response, appliesTo: 'all', params: r.params! };
      api.created.push(rule);
      return { rule };
    });
    const m = await mount();
    await m.click(m.button('Add rule'));
    await m.click([...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Flag sends after outside content')));
    expect(api.create).toHaveBeenCalledWith('f1', { ruleType: 'outside_then_send', mode: 'watch', response: 'notify', params: { readTools: ['web_fetch', 'read_inbox'], sendTools: ['send_email', 'http_request'] } }, 'k');
    expect(m.text()).toContain('Outside content, then send data rule added in Watch. Check its tools.');
    // A new rule opens with When expanded: both pickers and their help.
    expect(m.text()).toContain('Reads outside content');
    expect(m.text()).toContain('The provider’s web search and web fetch always count.');
    expect(m.text()).toContain('Sends data out');
    m.root.unmount();
  });

  it('shows its sentence in the row and under When; Change opens both tool pickers, fleet tools first', async () => {
    api.created.push(flowRule());
    api.tools = ['search_docs', 'web_fetch', 'read_inbox', 'browse_page', 'send_email'];
    const m = await mount();
    expect(m.row(WHEN).textContent).toContain(WHEN);
    expect(m.row(WHEN).querySelector('.ctl-cat')!.textContent).toBe('Data protection');
    await m.click(m.row(WHEN));
    expect(m.el.querySelector('.ctl-when')!.textContent).toBe(WHEN + 'Change');
    await m.click(m.button('Change'));
    await flush();
    expect(m.text()).toContain(WHEN + '.');
    expect(m.text()).toContain('A web page, email or file can carry hidden instructions. An agent that reads mail and replies will match on most runs.');
    const reads = m.el.querySelector('select[aria-label="Add a tool that reads outside content"]') as HTMLSelectElement;
    const sends = m.el.querySelector('select[aria-label="Add a tool that sends data out"]') as HTMLSelectElement;
    // Each opens on "Choose a tool…", never on a tool; the fleet's own tools come first.
    for (const sel of [reads, sends]) {
      expect(sel.options[0].textContent).toBe('Choose a tool…');
      expect(sel.querySelector('optgroup')!.getAttribute('label')).toBe('Your fleet’s tools');
    }
    // Likely readers first under Reads; likely senders first under Sends. Tools already picked aren't offered.
    expect([...reads.querySelector('optgroup')!.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['browse_page', 'search_docs', 'send_email']);
    expect([...sends.querySelector('optgroup')!.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['search_docs', 'web_fetch', 'read_inbox', 'browse_page']);
    m.root.unmount();
  });

  it('has no When enforced dropdown: Only alert me as fixed text, and its own effect line', async () => {
    api.created.push(flowRule());
    const m = await mount();
    await m.click(m.row(WHEN));
    expect(m.text()).not.toContain('You get one alert per run.');
    await m.click(m.seg('Enforce'));
    expect(m.action()).toBeNull();
    expect(m.el.querySelector('select[aria-label="When enforced"]')).toBeNull();
    expect(m.text()).toContain('When enforced: Only alert me');
    expect(m.text()).toContain('You get one alert per run. The agent keeps going.');
    expect(m.text()).not.toContain('Also alert me');
    m.root.unmount();
  });

  it('saves Enforce on Only alert me', async () => {
    api.created.push(flowRule());
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.created.find((r) => r.id === id)!, ...ch, version: 2 } }));
    const m = await mount();
    await m.click(m.row(WHEN));
    await m.click(m.seg('Enforce'));
    await m.click(m.button('Save'));
    // Turning on Enforce asks first, as for any rule; for this one it turns on alerts.
    expect(m.text()).toContain('Turn on alerts for this rule?');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Turn on alerts'));
    expect(api.update).toHaveBeenCalledWith('f1', 'o1', { mode: 'enforce', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('a rule holding another response saves as Only alert me', async () => {
    api.created.push(flowRule({ mode: 'enforce', response: 'block' }));
    const m = await mount();
    await m.click(m.row(WHEN));
    expect(m.action()).toBeNull();
    await m.click(m.seg('Watch'));
    await m.click(m.seg('Enforce'));
    // Back in Enforce it takes Only alert me, the one response this type has, and Save sends it.
    expect(m.text()).toContain('When enforced: Only alert me');
    api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.created.find((r) => r.id === id)!, ...ch, version: 2 } }));
    await m.click(m.button('Save'));
    // Block → Only alert me is weaker, so Save asks first.
    expect(m.text()).toContain('Make the Outside content, then send data rule weaker?');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Save the change'));
    expect(api.update).toHaveBeenCalledWith('f1', 'o1', { response: 'notify', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('with no send tools it is Not set up and does nothing', async () => {
    api.created.push(flowRule({}, { sendTools: [] }));
    const m = await mount();
    await m.click(m.button('Show'));
    const r = m.row('No send tools picked yet');
    expect(r.textContent).toContain('Not set up');
    expect(r.textContent).toContain('Does nothing until you add a send tool');
    await m.click(r);
    // It opens with When expanded, so the empty picker is in view.
    expect(m.el.querySelector('select[aria-label="Add a tool that sends data out"]')).toBeTruthy();
    m.root.unmount();
  });

  it('says each list holds up to 50 tools, and Save says so too', async () => {
    api.created.push(flowRule({}, { sendTools: Array.from({ length: 51 }, (_, i) => `send_${i}`) }));
    const m = await mount();
    await m.open(WHEN);
    expect(m.text()).toContain('A rule holds up to 50 tools in each list. Remove one to save.');
    // Taking one off clears it.
    await m.click(m.el.querySelector('button[aria-label="Remove send_0"]')!);
    expect(m.text()).not.toContain('A rule holds up to 50 tools in each list.');
    m.root.unmount();
  });

  it('tells the agent nothing: the call goes through', async () => {
    api.created.push(flowRule({ mode: 'enforce' }));
    const m = await mount();
    await m.click(m.row(WHEN));
    expect(m.el.querySelector('details.gov-details pre')!.textContent).toBe('Nothing: the call goes through.\nYou get an alert; the agent doesn’t.');
    m.root.unmount();
  });
});

// Repeated blocks (block_streak) and Old tool results (trim_results).
describe('Controls: Repeated blocks and Old tool results', () => {
  const ALL_TYPES = ['spend_cap', 'loop_breaker', 'model_allowlist', 'tool_list', 'call_rate', 'keyword', 'send_limit', 'outside_then_send', 'block_streak', 'trim_results'];
  const streak = (over: Partial<GovernanceRule> = {}): GovernanceRule => ({ ...base, id: 'b1', ruleType: 'block_streak', mode: 'watch', response: 'pause', appliesTo: 'all', params: { threshold: 3 }, ...over });
  const trim = (over: Partial<GovernanceRule> = {}): GovernanceRule => ({ ...base, id: 't1', ruleType: 'trim_results', mode: 'watch', response: 'notify', appliesTo: 'all', params: { keepRecent: 5, minTokens: 50_000 }, ...over });
  const STREAK = 'Blocked 3× in a row in a run';
  const TRIM = 'Tool results older than the newest 5 turns';
  const creates = () => api.create.mockImplementation(async (_f: string, r: { ruleType: GovernanceRule['ruleType']; mode: GovernanceRule['mode']; response?: GovernanceRule['response']; params?: GovernanceRule['params'] }) => {
    const rule: GovernanceRule = { ...base, id: 'new', ruleType: r.ruleType, mode: r.mode, response: r.response, appliesTo: 'all', params: r.params! };
    api.created.push(rule);
    return { rule };
  });
  const saves = () => api.update.mockImplementation(async (_f: string, id: string, ch: Partial<GovernanceRule>) => ({ rule: { ...api.created.find((r) => r.id === id)!, ...ch, version: 2 } }));
  const input = (m: Awaited<ReturnType<typeof mount>>, label: string) => m.el.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  const template = (m: Awaited<ReturnType<typeof mount>>, title: string) => [...m.el.querySelectorAll('button.gov-template')].find((b) => b.textContent?.startsWith(title));

  it('are offered in Add a rule only when the engine’s ruleTypes has them', async () => {
    const titles = async () => {
      const m = await mount();
      await m.click(m.button('Add rule'));
      const t = [...m.el.querySelectorAll('button.gov-template .gov-template__title')].map((b) => b.textContent);
      m.root.unmount();
      document.body.innerHTML = '';
      return t;
    };
    expect(await titles()).not.toEqual(expect.arrayContaining(['Act on repeated blocks']));
    api.ruleTypes = ALL_TYPES.slice(0, 8);
    const before = await titles();
    expect(before).not.toContain('Act on repeated blocks');
    expect(before).not.toContain('Trim old tool results');
    api.ruleTypes = ALL_TYPES;
    expect((await titles()).slice(-2)).toEqual(['Act on repeated blocks', 'Trim old tool results']);
  });

  it('Repeated blocks is added in Watch on Pause where the fleet has it, else on Only alert me, and opens on its number', async () => {
    api.ruleTypes = ALL_TYPES;
    creates();
    const plain = await mount();
    await plain.click(plain.button('Add rule'));
    await plain.click(template(plain, 'Act on repeated blocks'));
    expect(api.create).toHaveBeenLastCalledWith('f1', { ruleType: 'block_streak', mode: 'watch', response: 'notify', params: { threshold: 3 } }, 'k');
    plain.root.unmount();
    document.body.innerHTML = '';
    api.created = [];
    api.govV1 = true;
    const m = await mount();
    await m.click(m.button('Add rule'));
    await m.click(template(m, 'Act on repeated blocks'));
    expect(api.create).toHaveBeenLastCalledWith('f1', { ruleType: 'block_streak', mode: 'watch', response: 'pause', params: { threshold: 3 } }, 'k');
    // A new rule opens with When expanded: the number, with its default, and what counts.
    expect(input(m, 'Blocked calls in a row')!.value).toBe('3');
    expect(m.text()).toContain('Counts calls that another rule in Enforce blocked. A call that isn’t blocked starts the count over.');
    expect(m.el.querySelector('#ctl-ed-title')!.textContent).toBe('Repeated blocks');
    m.root.unmount();
  });

  it('Old tool results is added in Watch with its defaults, and opens on both numbers', async () => {
    api.ruleTypes = ALL_TYPES;
    creates();
    const m = await mount();
    await m.click(m.button('Add rule'));
    await m.click(template(m, 'Trim old tool results'));
    expect(api.create).toHaveBeenCalledWith('f1', { ruleType: 'trim_results', mode: 'watch', response: 'notify', params: { keepRecent: 5, minTokens: 50_000 } }, 'k');
    expect(input(m, 'Request size in tokens')!.value).toBe('50000');
    expect(input(m, 'Recent turns to keep')!.value).toBe('5');
    expect(m.text()).toContain('Each old result is replaced with a short note. The agent can call the tool again if it needs one back.');
    expect(m.text()).toContain('Watch: changes nothing and records what it would have removed.');
    m.root.unmount();
  });

  it('Repeated blocks offers Pause, Stop and Only alert me when enforced, never Block the call', async () => {
    api.govV1 = true;
    api.created.push(streak());
    const m = await mount();
    expect(m.row(STREAK).querySelector('.ctl-row__main .ctl-cap')!.textContent).toBe('Repeated blocks');
    await m.click(m.row(STREAK));
    expect(m.el.querySelector('.ctl-when')!.textContent).toBe('Has 3 calls in a row blocked in a run' + 'Change');
    expect(m.text()).toContain('Watch: only records what it would have done.');
    await m.click(m.seg('Enforce'));
    expect([...m.action()!.options].map((o) => o.textContent!.split(' · ')[0])).toEqual(['Pause the agent', 'Stop the agent', 'Only alert me']);
    expect(m.action()!.value).toBe('pause');
    // Stop still needs its day in Watch first, as on any rule.
    expect((await m.option('Stop the agent'))!.disabled).toBe(true);
    expect(m.text()).not.toContain('Block the call');
    expect(m.text()).not.toContain('Also alert me');
    expect(m.text()).toContain('Enforce: pauses the agent and alerts you. Its run ends until someone resumes it.');
    await m.pick('Only alert me');
    expect(m.text()).toContain('Enforce: alerts you. The agent keeps going.');
    m.root.unmount();
  });

  it('Repeated blocks on a fleet without Pause and Stop only alerts: fixed text, no dropdown', async () => {
    api.created.push(streak({ response: 'notify' }));
    const m = await mount();
    await m.click(m.row(STREAK));
    await m.click(m.seg('Enforce'));
    expect(m.action()).toBeNull();
    expect(m.text()).toContain('When enforced: Only alert me');
    expect(m.text()).not.toContain('Pause the agent');
    expect(m.text()).not.toContain('Block the call');
    m.root.unmount();
  });

  it('Repeated blocks takes 2 to 100, says so on Save, and saves a number in range', async () => {
    api.created.push(streak());
    saves();
    const m = await mount();
    await m.open(STREAK);
    for (const bad of ['1', '101', '', 'abc', '2.5']) {
      await type(input(m, 'Blocked calls in a row')!, bad);
      await m.click(m.button('Save'));
      expect(m.text(), bad).toContain('Enter a whole number from 2 to 100.');
    }
    expect(api.update).not.toHaveBeenCalled();
    await type(input(m, 'Blocked calls in a row')!, '2');
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 'b1', { params: { threshold: 2 }, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('Old tool results has no When enforced choice and no alert control, and says what Enforce changes', async () => {
    api.govV1 = true;
    api.created.push(trim());
    const m = await mount();
    expect(m.row(TRIM).textContent).toContain('Tool results older than the newest 5 turns, once a request is about 50,000 tokens');
    await m.click(m.row(TRIM));
    expect(m.el.querySelector('.ctl-when')!.textContent).toBe('Sends a request of about 50,000 tokens or more, with tool results older than the newest 5 turns' + 'Change');
    await m.click(m.seg('Enforce'));
    expect(m.action()).toBeNull();
    expect(m.text()).not.toContain('When enforced');
    expect(m.text()).not.toContain('Also alert me');
    expect(m.text()).not.toContain('Only alert me');
    expect(m.text()).toContain('Enforce: edits what the agent sends to the model. It never blocks a call or alerts you.');
    // No alert channel is connected, and it doesn't matter: this rule never sends one.
    expect(m.text()).not.toContain('No alert channel is connected.');
    expect(m.el.querySelector('.gov-edhead__mode')!.textContent).toBe('Enforce · unsaved');
    expect(m.el.querySelector('details.gov-details pre')!.textContent).toBe('Nothing: the call goes through.\nOld tool results in it are replaced with a short note.');
    m.root.unmount();
  });

  it('Old tool results checks both numbers on Save, then saves them', async () => {
    api.created.push(trim());
    saves();
    const m = await mount();
    await m.open(TRIM);
    for (const bad of ['999', '10000001', '', 'abc']) {
      await type(input(m, 'Request size in tokens')!, bad);
      await m.click(m.button('Save'));
      expect(m.text(), bad).toContain('Enter a whole number of tokens from 1,000 to 10,000,000.');
    }
    await type(input(m, 'Request size in tokens')!, '80,000');
    for (const bad of ['0', '101', '']) {
      await type(input(m, 'Recent turns to keep')!, bad);
      await m.click(m.button('Save'));
      expect(m.text(), bad).toContain('Enter a whole number of turns from 1 to 100.');
    }
    expect(api.update).not.toHaveBeenCalled();
    await type(input(m, 'Recent turns to keep')!, '8');
    await m.click(m.button('Save'));
    expect(api.update).toHaveBeenCalledWith('f1', 't1', { params: { keepRecent: 8, minTokens: 80_000 }, ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('turning on Enforce for Old tool results asks first, in its own words', async () => {
    api.created.push(trim());
    saves();
    const m = await mount();
    await m.click(m.row(TRIM));
    await m.click(m.seg('Enforce'));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Start trimming old tool results?');
    expect(m.text()).toContain('Would have trimmed');
    expect(m.text()).toContain('From now on, a large request goes to the model with its old tool results replaced by a short note. This edits what the agent sends. No call is blocked.');
    expect(m.text()).not.toContain('Turn on alerts');
    expect(api.update).not.toHaveBeenCalled();
    await m.click(m.button('Start trimming'));
    expect(api.update).toHaveBeenCalledWith('f1', 't1', { mode: 'enforce', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('stepping Old tool results down from Enforce asks in its own words', async () => {
    api.created.push(trim({ mode: 'enforce' }));
    saves();
    const m = await mount();
    await m.click(m.row(TRIM));
    await m.click(m.seg('Watch'));
    await m.click(m.button('Save'));
    expect(m.text()).toContain('Stop trimming old tool results?');
    expect(m.text()).toContain('Requests from all agents will go to the model unchanged.');
    expect(m.text()).not.toContain('You won’t get alerts');
    expect(m.button('Keep trimming')).toBeTruthy();
    await m.click(m.button('Switch to Watch'));
    expect(api.update).toHaveBeenCalledWith('f1', 't1', { mode: 'watch', ifVersion: 1 }, 'k');
    m.root.unmount();
  });

  it('an enforced Old tool results rule is tagged Enforce and counts as trimmed, never as blocked or an alert', async () => {
    api.created.push(trim({ mode: 'enforce' }));
    api.totals = { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 5, trimmed: 12 };
    api.byRule = { trim_results: { blocked: 0, paused: 0, stopped: 0, toldYou: 3, wouldAct: 0, trimmed: 12 } };
    const m = await mount();
    const row = m.row(TRIM);
    expect(row.querySelector('.ctl-mtag')!.textContent).toBe('Enforce');
    expect(row.querySelector('.ctl-row__count')!.textContent).toBe('12 trimmed · 7 days');
    expect(row.textContent).not.toMatch(/blocked|alerted|Alert only/);
    // The lead line names trims apart from blocks, and doesn't count the rule as Alert only.
    const lead = m.el.querySelector('.ctl-lead')!.textContent!;
    expect(lead).toContain('19 caught, 2 blocked, 12 trimmed this week');
    expect(lead).not.toContain('Alert only');
    await m.click(row);
    expect(m.el.querySelector('.ctl-status')!.textContent).toBe('Enforcing for all agents · 12 trimmed in 7 days');
    m.root.unmount();
  });

  it('an engine that doesn’t send trimmed reads as none, and the lead line is as before', async () => {
    api.created.push(trim({ mode: 'enforce' }));
    api.byRule = { trim_results: { blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 } };
    const m = await mount();
    expect(m.row(TRIM).querySelector('.ctl-row__count')!.textContent).toContain('0');
    expect(m.row(TRIM).querySelector('.ctl-row__count')!.textContent).toContain('None caught · 7 days');
    expect(m.el.querySelector('.ctl-lead')!.textContent).toContain('7 caught, 2 blocked this week');
    m.root.unmount();
  });
});
