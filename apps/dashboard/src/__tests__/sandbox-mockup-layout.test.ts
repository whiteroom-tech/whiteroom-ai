// @vitest-environment happy-dom
// The Sandbox page laid out as mockup Rev 3: the step on the left, the
// reference cards on the right (Your Sandbox, What we check, Sandbox rules,
// and Next on Results), the check's six live tests in the engine's order with
// a Now box, and the report's next steps. Placeholder keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/lib/analytics', () => ({ analytics: { capture: vi.fn() } }));

const { SandboxHome } = await import('@/components/sandbox/v2/SandboxHome');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const { CHECK_IDS, checkStateOf, currentCheckOf } = await import('@/lib/sandbox/checks');
const { LIVE_TRACK, nextSteps, nowExplained, ROWS, sandboxRows } = await import('@/lib/sandbox/sandbox-rows');
const { WHAT_WE_CHECK } = await import('@/lib/sandbox/what-we-check');

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
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: wide && q.includes('min-width'), addEventListener: () => {}, removeEventListener: () => {} }));
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

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
    expect([...document.querySelectorAll('aside li .wr-link, aside li button')].length).toBeGreaterThan(0);
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
    expect(text()).toContain('5 of 6 tests · 07 A human can pause and stop it');
    expect(text()).toContain('We paused support-bot for 5 seconds. Next we stop it for 5 seconds. A good agent waits while it’s held, then carries on.');
    expect(text()).toContain('Also called during this check: billing-agent (not checked).');
  });

  it('Results: Next first, then Your Sandbox and Sandbox rules; no What we check', async () => {
    await render('checks-report-rows');
    expect(cards()).toEqual(['Next', 'Your Sandbox', 'Sandbox rules']);
    expect(text()).toContain('6 of 8 checked · 2 need practice tasks · support-bot · 17 calls');
  });

  it('Edit rules opens the editor under the step, and Done closes it', async () => {
    await render('checks-report-rows');
    expect(document.getElementById('sandbox-rules')).toBeNull();
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit rules')!.click(); });
    expect(document.getElementById('sandbox-rules')?.closest('aside')).toBeNull();
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!.click(); });
    expect(document.getElementById('sandbox-rules')).toBeNull();
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

describe('What we check', () => {
  it('has the eight rows in number order, in two groups, each saying where it’s checked', () => {
    expect(WHAT_WE_CHECK.map((g) => g.name)).toEqual(['The agent', 'The guardrails']);
    expect(WHAT_WE_CHECK.flatMap((g) => g.rows.map((r) => `${r.num}:${r.where}`)))
      .toEqual(['01:practice', '02:both', '03:both', '04:here', '05:here', '06:here', '07:here', '08:practice']);
  });
});
