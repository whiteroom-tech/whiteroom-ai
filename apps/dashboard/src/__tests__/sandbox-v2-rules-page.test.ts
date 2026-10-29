// @vitest-environment happy-dom
// Sandbox rules on /sandbox (components/sandbox/v2/SandboxRules): the
// ready-made set applied once when the Sandbox has none, Copy shown only when
// production has rules, the source lines, editing through Sandbox actions
// only, the preview states, and no link to Controls. Placeholder keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SandboxRules } = await import('@/components/sandbox/v2/SandboxRules');
const { SandboxHome } = await import('@/components/sandbox/v2/SandboxHome');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const { SANDBOX_RULES_ONLY, sourceLine, previewReadyMade } = await import('@/lib/sandbox/rules');

const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
const READY = previewReadyMade(SANDBOX_ID);
const state = (over: Record<string, unknown> = {}) => ({ success: true, sandboxFleetId: SANDBOX_ID, rules: READY, source: 'ready_made', productionChanged: 0, ...over });

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
let root: Root;
const text = () => document.body.textContent ?? '';
/** The last shown button with this name (a closed dialog's buttons don't count): a dialog's confirm comes after the button that opened it. */
const button = (name: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === name && !b.closest('dialog:not([open])')).pop() as HTMLButtonElement | undefined;
const click = async (name: string) => { await act(async () => { button(name)!.click(); }); await flush(); };
const render = async (el: ReturnType<typeof h>) => { await act(async () => { root.render(el); }); await flush(); };

/** BFF + Controls' governance_list read. */
let listAnswer: Record<string, unknown>;
let productionRules: unknown[];
/** Route suffix → a refusal status (e.g. '/rules/update' → 409); `once` clears it after the first. */
let refuse: Record<string, { status: number; once?: boolean }>;
let govFails: boolean;
/** Each /rules/list call takes the next gate (if any) and waits for it: an in-flight read. */
let listGates: Promise<void>[];
/** Holds the next /rules/list call until the returned release is called. */
const holdNextList = () => { let release!: () => void; listGates.push(new Promise<void>((r) => { release = r; })); return () => release(); };
const bff = vi.fn();
const calls = () => bff.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  listAnswer = state();
  productionRules = [];
  refuse = {};
  govFails = false;
  listGates = [];
  bff.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!url.startsWith('/api/sandbox/')) {
      expect(body.action).toBe('governance_list');
      if (govFails) return Response.json({ error: 'down' }, { status: 500 });
      return Response.json({ fleetId: 'prod-eu', rules: productionRules, history: [], agents: ['support-triage'] });
    }
    const hit = Object.keys(refuse).find((k) => url.endsWith(k));
    if (hit) {
      const { status, once } = refuse[hit];
      if (once) delete refuse[hit];
      return Response.json({ error: `Refused ${status}.` }, { status });
    }
    if (url.endsWith('/rules/list')) {
      const answer = listAnswer;
      const gate = listGates.shift();
      if (gate) await gate;
      return Response.json(answer);
    }
    if (url.endsWith('/rules/ready-made')) return Response.json(state());
    if (url.endsWith('/rules/copy-production')) return Response.json(state({ source: 'production_copy', copiedAt: '2026-10-29T10:00:00.000Z' }));
    if (url.endsWith('/rules/create')) return Response.json({ success: true, rule: { ...READY[2], id: 'gr_new', ruleType: body.ruleType, params: { blockedTools: [] } } });
    if (url.endsWith('/rules/update')) return Response.json({ success: true, rule: { ...READY[0], mode: 'enforce', version: 2 } });
    if (url.endsWith('/rules/delete')) return Response.json({ success: true });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  });
  vi.stubGlobal('fetch', bff);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('Sandbox rules', () => {
  it('applies the ready-made set once when the Sandbox has no rules yet', async () => {
    listAnswer = state({ rules: [], source: null });
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    const applied = calls().filter((c) => c.url.endsWith('/rules/ready-made'));
    expect(applied).toHaveLength(1);
    expect(applied[0].body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(text()).toContain('Ready-made set — easy to trip on a short run. All start in Watch.');
    expect(text()).toContain('Spend cap');
  });

  it('doesn’t apply anything when the Sandbox already has a source', async () => {
    listAnswer = state({ rules: [], source: 'custom' });
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    expect(calls().some((c) => c.url.endsWith('/rules/ready-made'))).toBe(false);
    expect(text()).toContain('No rules in your Sandbox');
  });

  it('never replaces rules whose source it doesn’t know, or rules that are there with no source', async () => {
    listAnswer = state({ source: 'some_future_source' });
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    expect(calls().some((c) => c.url.endsWith('/rules/ready-made'))).toBe(false);
    expect(text()).toContain('Your own Sandbox rules.');
    expect(text()).toContain('Spend cap');

    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    listAnswer = state({ source: null });
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    expect(calls().some((c) => c.url.endsWith('/rules/ready-made'))).toBe(false);
    expect(text()).toContain('Spend cap');
  });

  it('hides Copy my production rules when production has no rules, shows it when it has', async () => {
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    expect(button('Copy my production rules')).toBeUndefined();
    expect(button('Use the ready-made set')).toBeDefined();
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    productionRules = [READY[0]];
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    expect(button('Copy my production rules')).toBeDefined();
  });

  it('copies production rules only after a confirm, through the Sandbox route', async () => {
    productionRules = [READY[0]];
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    await click('Copy my production rules');
    expect(calls().some((c) => c.url.endsWith('/rules/copy-production'))).toBe(false);
    expect(text()).toContain('Copy your production rules?');
    await click('Copy my production rules');
    expect(calls().filter((c) => c.url.endsWith('/rules/copy-production'))).toHaveLength(1);
    expect(text()).toContain('Copy of your production rules from');
  });

  it('edits, adds and removes through Sandbox rule actions only', async () => {
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    await act(async () => { (document.querySelector('button[aria-label="Edit Spend cap"]') as HTMLButtonElement).click(); });
    await flush();
    await act(async () => { ([...document.querySelectorAll('[role=radio]')].find((r) => r.textContent === 'Enforce') as HTMLElement).click(); });
    await flush();
    expect(document.querySelector('select[aria-label="When enforced"]')).not.toBeNull();
    expect(text()).toContain('Also alert me');
    await click('Save');
    const update = calls().find((c) => c.url.endsWith('/rules/update'))!;
    expect(update.body).toMatchObject({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, ruleId: READY[0].id, mode: 'enforce', ifVersion: 1 });

    // The engine's list after the add: it includes the new rule (the page re-reads it quietly).
    listAnswer = state({ rules: [...READY, { ...READY[2], id: 'gr_new', ruleType: 'tool_list', params: { blockedTools: [] } }], source: 'custom' });
    await click('Add a rule');
    await act(async () => { ([...document.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Block tools')) as HTMLButtonElement).click(); });
    await flush();
    expect(calls().find((c) => c.url.endsWith('/rules/create'))!.body).toMatchObject({ ruleType: 'tool_list', mode: 'watch' });

    await click('Remove rule');
    await click('Remove rule');
    expect(calls().find((c) => c.url.endsWith('/rules/delete'))!.body).toMatchObject({ ruleId: 'gr_new' });
    for (const c of calls()) expect(c.body.action ?? 'none').not.toMatch(/^governance_(create|update|delete)/);
  });

  it('says the rules are Sandbox-only and never links to Controls', async () => {
    productionRules = [READY[0]];
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    expect(text()).toContain(SANDBOX_RULES_ONLY);
    expect([...document.querySelectorAll('a')].some((a) => a.getAttribute('href')?.includes('/controls'))).toBe(false);
  });
});

describe('Sandbox rules: failures and races', () => {
  const editSpendCap = async () => {
    await act(async () => { (document.querySelector('button[aria-label="Edit Spend cap"]') as HTMLButtonElement).click(); });
    await flush();
    await act(async () => { ([...document.querySelectorAll('[role=radio]')].find((r) => r.textContent === 'Enforce') as HTMLElement).click(); });
    await flush();
  };
  const count = (suffix: string) => calls().filter((c) => c.url.endsWith(suffix)).length;

  for (const status of [404, 409]) {
    it(`reloads the Sandbox status when list, create, update or delete answers ${status}`, async () => {
      // list
      refuse = { '/rules/list': { status } };
      const onStale = vi.fn();
      await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, onStale }));
      expect(onStale).toHaveBeenCalledTimes(1);
      expect(text()).toContain(`Refused ${status}.`);

      // create
      refuse = {};
      act(() => root.unmount());
      root = createRoot(document.body.appendChild(document.createElement('div')));
      onStale.mockClear();
      await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, onStale }));
      refuse = { '/rules/create': { status } };
      await click('Add a rule');
      await act(async () => { ([...document.querySelectorAll('button.gov-template')].find((b) => b.textContent?.includes('Block tools')) as HTMLButtonElement).click(); });
      await flush();
      expect(onStale).toHaveBeenCalledTimes(1);

      // delete
      onStale.mockClear();
      refuse = { '/rules/delete': { status } };
      await act(async () => { (document.querySelector('button[aria-label="Edit Spend cap"]') as HTMLButtonElement).click(); });
      await flush();
      await click('Remove rule');
      await click('Remove rule');
      expect(onStale).toHaveBeenCalledTimes(1);

      // update: the rules are re-read; when the Sandbox itself is gone that read reloads the status.
      onStale.mockClear();
      refuse = { '/rules/update': { status }, '/rules/list': { status } };
      await click('Cancel');
      await editSpendCap();
      await click('Save');
      expect(onStale).toHaveBeenCalledTimes(1);
    });
  }

  it('shows the editor error and reloads the rules when an update conflicts', async () => {
    const onStale = vi.fn();
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, onStale }));
    const lists = count('/rules/list');
    refuse = { '/rules/update': { status: 409 } };
    // Changed elsewhere: the engine now has Spend cap at version 2, in Enforce.
    listAnswer = state({ rules: READY.map((r, i) => (i === 0 ? { ...r, mode: 'enforce', version: 2 } : r)), source: 'custom' });
    await editSpendCap();
    await click('Save');
    expect(text()).toContain('Refused 409.');
    expect(count('/rules/list')).toBe(lists + 1);
    expect(text()).not.toContain('Ready-made set');
    expect(onStale).not.toHaveBeenCalled();
  });

  it('applies the ready-made set on Try again after the first apply failed', async () => {
    listAnswer = state({ rules: [], source: null });
    refuse = { '/rules/ready-made': { status: 500, once: true } };
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    expect(text()).toContain('Refused 500.');
    expect(text()).not.toContain('No rules in your Sandbox');
    await click('Try again');
    expect(count('/rules/ready-made')).toBe(2);
    expect(text()).toContain('Ready-made set — easy to trip on a short run.');
    expect(text()).toContain('Spend cap');
  });

  it('hides Copy my production rules when production’s rules can’t be read', async () => {
    productionRules = [READY[0]];
    govFails = true;
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    expect(button('Use the ready-made set')).toBeDefined();
    expect(button('Copy my production rules')).toBeUndefined();
  });

  it('doesn’t let an older quiet re-read overwrite a newer replace', async () => {
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    // The save's quiet re-read is held; it would answer "custom, no rules".
    const release = holdNextList();
    listAnswer = state({ rules: [], source: 'custom' });
    await editSpendCap();
    await click('Save');
    await click('Use the ready-made set');
    await click('Use the ready-made set');
    expect(count('/rules/ready-made')).toBe(1);
    expect(text()).toContain('Ready-made set — easy to trip on a short run.');
    await act(async () => { release(); });
    await flush();
    expect(text()).toContain('Ready-made set — easy to trip on a short run.');
    expect(text()).not.toContain('No rules in your Sandbox');
  });
});

describe('Sandbox rules: loading and retry', () => {
  const LOADING = 'Loading your Sandbox rules…';
  const count = (suffix: string) => calls().filter((c) => c.url.endsWith(suffix)).length;
  /** Save Spend cap in Enforce; with update refused 409 this starts a rules load. */
  const saveConflict = async () => {
    if (!document.querySelector('select[aria-label="When enforced"]')) {
      await act(async () => { (document.querySelector('button[aria-label="Edit Spend cap"]') as HTMLButtonElement).click(); });
      await flush();
      await act(async () => { ([...document.querySelectorAll('[role=radio]')].find((r) => r.textContent === 'Enforce') as HTMLElement).click(); });
      await flush();
    }
    await click('Save');
  };

  it('keeps loading while a newer load runs, and stops when that one lands', async () => {
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    expect(text()).not.toContain(LOADING);
    refuse = { '/rules/update': { status: 409 } };
    const releaseOld = holdNextList();
    const releaseNew = holdNextList();
    const lists = count('/rules/list');
    await saveConflict();
    await saveConflict();
    expect(count('/rules/list')).toBe(lists + 2);
    expect(text()).toContain(LOADING);
    // The older load finishes first: the newer one is still running.
    await act(async () => { releaseOld(); });
    await flush();
    expect(text()).toContain(LOADING);
    listAnswer = state({ source: 'custom' });
    await act(async () => { releaseNew(); });
    await flush();
    expect(text()).not.toContain(LOADING);
  });

  it('offers Try again when a reload fails with rules still shown', async () => {
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    refuse = { '/rules/update': { status: 409 }, '/rules/list': { status: 500, once: true } };
    await saveConflict();
    expect(text()).toContain('Refused 500.');
    expect(text()).toContain('Spend cap');
    expect(button('Try again')).toBeDefined();
    listAnswer = state({ source: 'custom' });
    await click('Try again');
    expect(text()).not.toContain('Refused 500.');
    expect(button('Try again')).toBeUndefined();
    expect(text()).toContain('Your own Sandbox rules.');
  });

  it('doesn’t offer Try again for a failed edit', async () => {
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    refuse = { '/rules/delete': { status: 500 } };
    await act(async () => { (document.querySelector('button[aria-label="Edit Spend cap"]') as HTMLButtonElement).click(); });
    await flush();
    await click('Remove rule');
    await click('Remove rule');
    expect(text()).toContain('Refused 500.');
    expect(button('Try again')).toBeUndefined();
  });

  it('is never stuck loading when a replace overtakes a load', async () => {
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    refuse = { '/rules/update': { status: 409 } };
    const release = holdNextList();
    listAnswer = state({ rules: [], source: 'custom' });
    await saveConflict();
    expect(text()).toContain(LOADING);
    await click('Use the ready-made set');
    await click('Use the ready-made set');
    expect(count('/rules/ready-made')).toBe(1);
    expect(text()).not.toContain(LOADING);
    expect(text()).toContain('Ready-made set — easy to trip on a short run.');
    // The overtaken load lands last and changes nothing.
    await act(async () => { release(); });
    await flush();
    expect(text()).not.toContain(LOADING);
    expect(text()).not.toContain('No rules in your Sandbox');
  });

  it('is never stuck loading when a quiet re-read overtakes a load, even if that read fails', async () => {
    await render(h(SandboxRules, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID }));
    refuse = { '/rules/update': { status: 409 } };
    const release = holdNextList();
    await saveConflict();
    expect(text()).toContain(LOADING);
    // Remove a rule: its quiet re-read overtakes the held load, and fails.
    refuse = { '/rules/list': { status: 500, once: true } };
    await click('Remove rule');
    await click('Remove rule');
    expect(text()).not.toContain(LOADING);
    await act(async () => { release(); });
    await flush();
    expect(text()).not.toContain(LOADING);
  });
});

describe('Sandbox rules: source line', () => {
  it('reads each source', () => {
    expect(sourceLine({ source: 'ready_made', productionChanged: 0 }).text).toBe('Ready-made set — easy to trip on a short run. All start in Watch.');
    const copy = sourceLine({ source: 'production_copy', copiedAt: '2026-10-27T12:00:00.000Z', productionChanged: 2 }, Date.parse('2026-10-29T12:00:00Z'));
    expect(copy.text).toMatch(/^Copy of your production rules from Oct 2[67]$/);
    expect(copy.changed).toBe('Production has 2 newer changes');
    expect(sourceLine({ source: 'production_copy', productionChanged: 1 }).changed).toBe('Production has 1 newer change');
  });
});

describe('Sandbox rules: preview states', () => {
  const renderState = (name: keyof typeof SANDBOX_V2_STATES) => render(h(SandboxHome, { key: name, fleet: 'prod-eu', preview: SANDBOX_V2_STATES[name] }));

  it('render without the engine, each as described, with no Controls link', async () => {
    for (const name of ['rules-ready-made', 'rules-copy', 'rules-custom', 'rules-empty', 'rules-editing', 'rules-error'] as const) {
      await renderState(name);
      expect(bff).not.toHaveBeenCalled();
      expect(text()).toContain('3. Sandbox rules');
      expect([...document.querySelectorAll('a')].some((a) => a.getAttribute('href')?.includes('/controls'))).toBe(false);
      if (name === 'rules-ready-made') expect(text()).toContain('Ready-made set');
      if (name === 'rules-copy') { expect(text()).toContain('Production has 2 newer changes'); expect(button('Copy again')).toBeDefined(); }
      if (name === 'rules-custom') expect(button('Copy my production rules')).toBeUndefined();
      if (name === 'rules-empty') expect(text()).toContain('No rules in your Sandbox');
      if (name === 'rules-editing') expect(document.querySelector('select[aria-label="When enforced"]')).not.toBeNull();
      if (name === 'rules-error') expect(text()).toContain('couldn’t do that');
    }
  });

  it('isn’t shown before a key is connected', async () => {
    await renderState('not-connected');
    expect(text()).not.toContain('3. Sandbox rules');
  });
});
