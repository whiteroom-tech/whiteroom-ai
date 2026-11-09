// @vitest-environment happy-dom
// A report cut short by a WhiteRoom restart (Nov 2, prod): it says so and
// offers Check again, never "no calls reached your Sandbox"; row 03 says the
// restart once; and Your Sandbox keeps "key ending XXXX" together.
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
const { ENGINE_RESTARTED_SENTENCE, restartedCheck, restartNote, tooFewNote } = await import('@/lib/sandbox/check-report');
const { nextSteps, sandboxRows } = await import('@/lib/sandbox/sandbox-rows');
const { CHECK_IDS, checkStateOf } = await import('@/lib/sandbox/checks');

let root: Root;
const text = () => document.body.textContent ?? '';
beforeEach(() => { root = createRoot(document.body.appendChild(document.createElement('div'))); });
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

const R = ENGINE_RESTARTED_SENTENCE;
const ended = (statuses: Record<string, [string, string]>, parts: unknown[] = []) => checkStateOf({
  window: { id: 'chk_1', startedAt: '2026-11-02T10:00:00.000Z', endedAt: '2026-11-02T10:06:00.000Z', stage: 'done', injectErrors: true, calls: 0 },
  checks: CHECK_IDS.map((id) => ({ id, label: id, status: statuses[id]?.[0] ?? 'not_checked', detail: statuses[id]?.[1] ?? '' })),
  rules: [], parts,
})!;

describe('a check cut short by a WhiteRoom restart', () => {
  it('is recognised from the engine’s wording on what it couldn’t finish, and only from that', () => {
    expect(restartedCheck(ended({ long_task: ['not_checked', R] }))).toBe(true);
    expect(restartedCheck(ended({}, [{ id: 'rate_limit_wait', status: 'not_checked', detail: R }]))).toBe(true);
    expect(restartedCheck(ended({ long_task: ['not_checked', 'Your agent didn’t reach this step.'] }))).toBe(false);
    // A reworded engine sentence still counts; the phrase on a passed result doesn't.
    expect(restartedCheck(ended({ pause_stop: ['not_checked', 'Not checked — WhiteRoom Restarted during this check. Check again.'] }))).toBe(true);
    expect(restartedCheck(ended({ pause_stop: ['passed', 'Restarted during the check, then carried on.'] }))).toBe(false);
  });

  it('Next is Check again, not "run your agent again"', () => {
    const state = ended({ long_task: ['not_checked', R] });
    expect(nextSteps(sandboxRows(state), { few: true, sample: false, restarted: true })[0]).toEqual({ kind: 'restarted' });
    expect(nextSteps(sandboxRows(state), { few: true, sample: false, restarted: true }).map((x) => x.kind)).not.toContain('again');
  });

  it('row 03 says the restart once, though its error and its wait both were cut short', () => {
    const r03 = sandboxRows(ended({ provider_errors: ['not_checked', R] }, [{ id: 'rate_limit_wait', status: 'not_checked', detail: R }])).find((r) => r.num === '03')!;
    expect(r03.parts[0].text).toBe(R);
  });

  it('on the page: the restart note and Check again, never the too-few-calls note', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report-restarted'] })); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain(restartNote(false));
    expect(text()).not.toContain(tooFewNote(0));
    expect(document.querySelector('section[aria-label="Next"]')?.textContent).toContain('WhiteRoom restarted during this check. Check again.');
    expect(document.querySelector('section[aria-label="Next"]')?.textContent).not.toContain('longer task');
    // Row 03's Here line: once.
    expect(document.querySelector('li[data-row="03"]')?.textContent?.split('WhiteRoom restarted during the check').length).toBe(2);
  });

  it('the sample agent: no Check again step; the note points to Run the sample again', async () => {
    const state = ended({ long_task: ['not_checked', R] });
    expect(nextSteps(sandboxRows(state), { few: true, sample: true, restarted: true })).toEqual([]);
    expect(restartNote(false, true)).toBe('WhiteRoom restarted during this check, so nothing was checked. Run the sample again.');
    const { ReportView } = await import('@/components/sandbox/v2/SandboxChecks');
    await act(async () => { root.render(h(ReportView, { state, checked: 'today', calls: 0, sample: { onOwnKey: vi.fn(), onAgain: vi.fn() } })); });
    expect(text()).toContain('Run the sample again.');
    expect(text()).not.toContain('Check again.');
  });

  it('without the restart wording (another engine release), the report falls back to the too-few-calls note: the known limit of matching words', async () => {
    const { ReportView } = await import('@/components/sandbox/v2/SandboxChecks');
    const state = ended({ long_task: ['not_checked', 'Not checked.'] });
    expect(restartedCheck(state)).toBe(false);
    await act(async () => { root.render(h(ReportView, { state, checked: 'today', calls: 0 })); });
    expect(text()).toContain(tooFewNote(0));
    expect(text()).not.toContain('WhiteRoom restarted');
  });

  it('some checks done before the restart: says some didn’t finish', () => {
    expect(restartNote(true)).toBe('WhiteRoom restarted during this check, so some checks didn’t finish. Check again.');
  });
});

describe('Your Sandbox', () => {
  it('keeps "key ending XXXX" on one line (the 300 px column wrapped the last four onto their own)', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report-rows'] })); });
    const group = [...document.querySelectorAll('section[aria-label="Your Sandbox"] span')].find((e) => e.textContent?.startsWith('key ending'));
    expect(group?.className).toMatch(/nowrap/);
    expect(group?.textContent).toBe('key ending AbCd');
  });
});
