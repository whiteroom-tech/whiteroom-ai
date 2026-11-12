// @vitest-environment happy-dom
// The Sandbox page laid out as mockup Rev 3: the step on the left, the
// reference cards on the right (Your Sandbox, What we check, Sandbox rules,
// and Next on Results), the check's six live tests in the engine's order with
// a Now box, and the report's next steps. Placeholder keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// The Sandbox's server actions (plan, Take it live): today's page, nothing on the server.
vi.mock('@/lib/sandbox/sandbox-plan', () => ({ getSandboxPlan: async () => ({ plan: 'other', canBuy: false, invite: null }) }));
vi.mock('@/lib/user-fleets', () => ({ takeItLive: async () => ({ ok: false }) }));
// The plan banner's event name only (the banner itself reads the server).
vi.mock('@/components/AccountPlanBanner', () => ({ PLAN_CHANGED: 'wr:plan-changed' }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/lib/analytics', () => ({ analytics: { capture: vi.fn() } }));

const { SandboxHome } = await import('@/components/sandbox/v2/SandboxHome');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const { CHECK_IDS, checkStateOf, currentCheckOf } = await import('@/lib/sandbox/checks');
const { LIVE_TRACK, nextSteps, nowExplained, ROWS, sandboxRows } = await import('@/lib/sandbox/sandbox-rows');
const { WHAT_WE_CHECK } = await import('@/lib/sandbox/what-we-check');
const { NextCard, WhatWeCheckCard } = await import('@/components/sandbox/v2/SandboxAside');

let root: Root;
const text = () => document.body.textContent ?? '';
const cards = () => [...document.querySelectorAll('aside[aria-label="About your Sandbox"] > *')].map((e) => e.getAttribute('aria-label') ?? e.querySelector('h3')?.textContent);
const render = async (state: keyof typeof SANDBOX_V2_STATES) => {
  await act(async () => { root.render(h(SandboxHome, { key: state, fleet: 'prod-eu', preview: SANDBOX_V2_STATES[state] })); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
let wide = true;
beforeEach(() => {
  wide = true;
  // The page's own width decides two columns (useWide measures it, as the container query does).
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: wide ? 1100 : 360, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }));
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const answer = (stage: string, statuses: Record<string, string> = {}, ended = false) => checkStateOf({
  window: { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', endedAt: ended ? '2026-10-29T10:06:00.000Z' : null, stage, injectErrors: true, calls: 20 },
  checks: CHECK_IDS.map((id) => ({ id, label: id, status: statuses[id] ?? 'pending', detail: statuses[id] ? `Detail ${id}.` : '' })),
  rules: [],
})!;

describe('the right-hand cards follow the step', () => {
  it('Connect: What we check, open beside the key form on a laptop', async () => {
    await render('sample-offer');
    expect(cards()).toEqual(['What we check']);
    expect((document.querySelector('aside details') as HTMLDetailsElement).open).toBe(true);
    // Eight rows in their two groups, each saying where it's checked.
    expect(text()).toContain('8 checks · 02–07 run here in about a minute');
    // No key yet, so nothing to run: the rows say where they're checked, with no practice link.
    expect([...document.querySelectorAll('aside li .wr-link, aside li button')]).toHaveLength(0);
  });

  it('on a phone What we check starts closed, under the step', async () => {
    wide = false;
    await render('sample-offer');
    expect((document.querySelector('aside details') as HTMLDetailsElement).open).toBe(false);
  });

  it('Waiting: Your Sandbox, What we check (open), Sandbox rules', async () => {
    await render('just-connected');
    expect(cards()).toEqual(['Your Sandbox', 'What we check', 'Sandbox rules']);
    expect((document.querySelector('aside details') as HTMLDetailsElement).open).toBe(true);
    expect(text()).toContain('Waiting for your agent’s first call');
    expect(text()).toContain('Nothing after a minute? Usually one of these:');
    // The connected row and the closed settings section are gone: Your Sandbox has both.
    expect(text()).not.toContain('Connected · Anthropic key ending');
    expect(text()).not.toContain('Sandbox settings');
  });

  it('Checking: Your Sandbox, What we check (closed), Sandbox rules; the step shows the track and Now box', async () => {
    await render('checks-checking');
    expect(cards()).toEqual(['Your Sandbox', 'What we check', 'Sandbox rules']);
    expect((document.querySelector('aside details') as HTMLDetailsElement).open).toBe(false);
    expect(text()).toContain('support-bot is calling · last call');
    expect(text()).toContain('5 of 6 live tests · 07 A human can pause and stop it');
    expect(text()).toContain('We paused support-bot for 5 seconds. Next we stop it for 5 seconds. A good agent waits while it’s held, then carries on.');
    expect(text()).toContain('Also called during this check: billing-agent (not checked).');
  });

  it('Results: Next first, then Your Sandbox and Sandbox rules; no What we check', async () => {
    await render('checks-report-rows');
    expect(cards()).toEqual(['Next', 'Your Sandbox', 'Sandbox rules']);
    expect(text()).toContain('6 of 8 checked · 2 need practice tasks · support-bot · 17 calls');
  });

  it('Edit rules opens the editor under the step, moves focus to its heading and brings it into view; Done closes it', async () => {
    const scroll = vi.fn();
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(scroll);
    await render('checks-report-rows');
    expect(document.getElementById('sandbox-rules')).toBeNull();
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit rules')!.click(); });
    expect(document.getElementById('sandbox-rules')?.closest('aside')).toBeNull();
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement?.textContent).toBe('Sandbox rules');
    expect(document.activeElement?.closest('#sandbox-rules')).not.toBeNull();
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!.click(); });
    expect(document.getElementById('sandbox-rules')).toBeNull();
  });

  it('Done before the editor’s frame lands: nothing to focus, nothing thrown', async () => {
    await render('checks-report-rows');
    // Both clicks land before the frame that moves focus.
    act(() => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit rules')!.click(); });
    act(() => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!.click(); });
    expect(document.getElementById('sandbox-rules')).toBeNull();
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement?.closest('#sandbox-rules') ?? null).toBeNull();
  });

  it('a URL from Connect shows while waiting, not above a later report', async () => {
    await render('just-connected');
    expect(document.querySelector('[aria-label="Copy the setting"]')).not.toBeNull();
    // The same URL still on screen when the report arrives: the report stands alone
    // (only a URL got with New URL on this page shows above it: sandbox-v2-page "on Results, Get a new Sandbox URL…").
    await render('connected-then-report');
    expect(document.getElementById('sandbox-step')?.getAttribute('aria-label')).toBe('Results');
    expect(document.querySelector('[aria-label="Copy the setting"]')).toBeNull();
  });

  it('What we check: a choice made by hand stays when the step or width changes the default', async () => {
    const fold = () => document.querySelector('details') as HTMLDetailsElement;
    const draw = (open: boolean) => act(async () => { root.render(h(WhatWeCheckCard, { open, practiceHref: '/sandbox/practice' })); });
    await draw(true);
    expect(fold().open).toBe(true);
    // Closed by hand: a default that changes (waiting → checking → waiting) doesn't reopen it.
    await act(async () => { fold().open = false; fold().dispatchEvent(new Event('toggle')); });
    await draw(false);
    await draw(true);
    expect(fold().open).toBe(false);
    // Opened by hand: a default of closed doesn't shut it.
    await act(async () => { fold().open = true; fold().dispatchEvent(new Event('toggle')); });
    await draw(false);
    expect(fold().open).toBe(true);
  });

  it('What we check follows the page’s width as it changes (ResizeObserver), across 860 px', async () => {
    let fire = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { fire = cb; } observe() {} disconnect() {} });
    await render('just-connected');
    const fold = () => document.querySelector('aside details') as HTMLDetailsElement;
    expect(fold().open).toBe(true);
    wide = false;
    await act(async () => { fire(); });
    expect(fold().open).toBe(false);
    wide = true;
    await act(async () => { fire(); });
    expect(fold().open).toBe(true);
  });

  it('Change key closes the rules editor: back from Connect, it isn’t left open', async () => {
    await render('checks-report-rows');
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit rules')!.click(); });
    expect(document.getElementById('sandbox-rules')).not.toBeNull();
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Change key')!.click(); });
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('#sandbox-connect button')].find((b) => b.textContent === 'Cancel')!.click(); });
    expect(document.getElementById('sandbox-step')).not.toBeNull();
    expect(document.getElementById('sandbox-rules')).toBeNull();
  });

  it('a failed checks read shows the error, not the waiting line', async () => {
    await render('checks-error');
    expect(text()).toContain('couldn’t do that');
    expect(text()).not.toContain('Waiting for your agent’s first call');
  });
});

describe('the check’s six live tests', () => {
  it('follow the engine’s order: each stage’s test is next on the track', () => {
    const order = LIVE_TRACK.map((t) => t.check);
    const seen: string[] = [];
    let statuses: Record<string, string> = {};
    for (const stage of ['observe', 'enforce', 'enforce', 'enforce', 'pause', 'errors']) {
      const now = currentCheckOf(answer(stage, statuses))!;
      seen.push(now);
      statuses = { ...statuses, [now]: 'passed' };
    }
    expect(seen).toEqual(order);
    // Each on its report row.
    for (const t of LIVE_TRACK) expect(ROWS.find((r) => r.num === t.num)?.check).toBe(t.check);
  });

  it('each has a Now line naming the agent where it matters', () => {
    for (const t of LIVE_TRACK) expect(nowExplained(t.check, 'enforce', 'support-bot')).toMatch(/A good agent/);
    expect(nowExplained('pause_stop', 'stop', 'support-bot')).toContain('We stopped support-bot for 5 seconds.');
    expect(nowExplained('long_task', 'observe', 'your agent')).toContain('hands your agent’s work over');
  });
});

describe('the report’s next steps', () => {
  it('a fix, then practice tasks for the rows they check', () => {
    const rows = sandboxRows(answer('done', { long_task: 'passed', spend_cap: 'passed', loop_rate: 'passed', allowlists_keywords: 'passed', pause_stop: 'passed', provider_errors: 'failed' }, true));
    expect(nextSteps(rows, { few: false, sample: false }).map((x) => x.kind)).toEqual(['fix', 'practice']);
    expect(nextSteps(rows, { few: false, sample: true }).map((x) => x.kind)).toEqual(['fix']);
  });

  it('too few calls: run the agent again first', () => {
    expect(nextSteps(sandboxRows(answer('done', {}, true)), { few: true, sample: false })[0]).toEqual({ kind: 'again' });
  });

  it('everything checked and passed: go live, and the Deep test for 02’s long task', () => {
    const live = answer('done', { long_task: 'passed', spend_cap: 'passed', loop_rate: 'passed', allowlists_keywords: 'passed', pause_stop: 'passed', provider_errors: 'passed' }, true);
    const practice = { runId: 'r-1', endedAt: null, checks: ['a.result', 'c.timeout', 'c.keeps_failing', 'd.injection'].map((id) => ({ id, label: id, status: 'passed' as const, summary: '', fix: null })) };
    const steps = nextSteps(sandboxRows(live, practice), { few: false, sample: false }).map((x) => x.kind);
    expect(steps).toEqual(['live', 'deep']);
  });
});

describe('the report’s next steps: edge cases', () => {
  const ALL = { long_task: 'passed', spend_cap: 'passed', loop_rate: 'passed', allowlists_keywords: 'passed', pause_stop: 'passed', provider_errors: 'passed' };
  const PRACTICE = { runId: 'r-1', endedAt: null, checks: ['a.result', 'c.timeout', 'c.keeps_failing', 'd.injection'].map((id) => ({ id, label: id, status: 'passed' as const, summary: '', fix: null })) };

  it('a row not checked holds back go live (nothing failed, but not everything was tried)', () => {
    const rows = sandboxRows(answer('done', { ...ALL, pause_stop: 'not_checked' }, true), PRACTICE);
    expect(nextSteps(rows, { few: false, sample: false })).toEqual([]);
  });

  it('too few calls with a fix: run again first, then the fix', () => {
    const rows = sandboxRows(answer('done', { provider_errors: 'failed' }, true));
    expect(nextSteps(rows, { few: true, sample: false }).map((x) => x.kind)).toEqual(['again', 'fix', 'practice']);
  });

  it('the sample agent with too few calls: no run-again step (its report has Run the sample again)', () => {
    expect(nextSteps(sandboxRows(answer('done', {}, true)), { few: true, sample: true }).map((x) => x.kind)).not.toContain('again');
  });

  it('the sample agent with nothing failed: no steps, so no Next card', async () => {
    expect(nextSteps(sandboxRows(answer('done', ALL, true)), { few: false, sample: true })).toEqual([]);
    await act(async () => { root.render(h(NextCard, { items: [] })); });
    expect(document.querySelector('section[aria-label="Next"]')).toBeNull();
  });
});

describe('What we check', () => {
  it('has the eight rows in number order, in two groups, each saying where it’s checked', () => {
    expect(WHAT_WE_CHECK.map((g) => g.name)).toEqual(['The agent', 'The guardrails']);
    expect(WHAT_WE_CHECK.flatMap((g) => g.rows.map((r) => `${r.num}:${r.where}`)))
      .toEqual(['01:practice', '02:both', '03:both', '04:here', '05:here', '06:here', '07:here', '08:practice']);
  });
});

describe('helpers behind the page (final review)', () => {
  it('rowLimits: the spend cap’s amount and scope; off or none says nothing', async () => {
    const { rowLimits } = await import('@/components/sandbox/v2/SandboxChecks');
    const { previewReadyMade } = await import('@/lib/sandbox/rules');
    const cap = previewReadyMade('sandbox-x').find((r) => r.ruleType === 'spend_cap')!;
    expect(rowLimits([cap])).toEqual({ spend_cap: '$0.02 a run' });
    expect(rowLimits([{ ...cap, params: { ...cap.params, dailyCap: 5, scope: 'day' } }])).toEqual({ spend_cap: '$5 a day' });
    expect(rowLimits([{ ...cap, mode: 'off' }])).toEqual({});
    expect(rowLimits([])).toEqual({});
  });

  it('useSeenAt: steps done before it saw them are unseen; new ones get their time; a new key starts over', async () => {
    const { useSeenAt } = await import('@/components/sandbox/v2/useSeenAt');
    let out: (number | null)[] = [];
    const Probe = ({ k, done }: { k: string; done: number }) => { out = useSeenAt(k, done); return null; };
    await act(async () => { root.render(h(Probe, { k: 'a', done: 2 })); });
    expect(out).toEqual([null, null]);
    await act(async () => { root.render(h(Probe, { k: 'a', done: 3 })); });
    expect(out).toHaveLength(3);
    expect(typeof out[2]).toBe('number');
    await act(async () => { root.render(h(Probe, { k: 'b', done: 1 })); });
    expect(out).toEqual([null]);
  });

  it('the name tip opens the per-provider naming guide', async () => {
    await render('just-connected');
    expect(text()).toContain('Check it sends a name');
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'How?')!.click(); });
    expect(text()).toContain('x-whiteroom-agent');
    expect(document.querySelector('button[aria-expanded="true"]')?.textContent).toBe('How?');
  });
});
