// @vitest-environment happy-dom
// Sandbox v2 phases 6–7: the report once a checking window ends (status
// mapping, next steps, rule lines, Copy summary without keys), Past tests
// hiding demos and tests that never started behind Show all, and the practice
// page framed as secondary with its way back to Sandbox. Placeholder values only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CheckState, CheckStatus, CheckId } from '@/lib/sandbox/checks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { CHECK_IDS, CHECK_NAMES } = await import('@/lib/sandbox/checks');
const { reportOf, reportSummary, FIX, RUN_PRACTICE, TRIP_TIP } = await import('@/lib/sandbox/check-report');
const { ReportView, SandboxChecks } = await import('@/components/sandbox/v2/SandboxChecks');
const { SandboxHome } = await import('@/components/sandbox/v2/SandboxHome');
const { PastTests, hiddenByDefault, pastRows } = await import('@/components/sandbox/PastTests');
const { PracticeTest, PRACTICE_INTRO } = await import('@/components/sandbox/practice/PracticeTest');
const { PRACTICE_ROWS, PRACTICE_STATES } = await import('@/app/dev/practice/states');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');

const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
const PLACEHOLDER_KEY = 'sk-wr-placeholder-not-a-real-key';

type Results = Partial<Record<CheckId, [CheckStatus, string?]>>;
const stateOf = (results: Results, opts: { injectErrors?: boolean; rules?: CheckState['rules'] } = {}): CheckState => ({
  window: { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', endedAt: '2026-10-29T10:06:00.000Z', stage: 'done', injectErrors: opts.injectErrors ?? true, calls: 12 },
  checks: CHECK_IDS.map((id) => ({ id, label: CHECK_NAMES[id], status: results[id]?.[0] ?? 'pending', detail: results[id]?.[1] ?? '' })),
  rules: opts.rules ?? [],
});
const card = (st: CheckState, id: CheckId) => reportOf(st).cards.find((c) => c.id === id)!;

describe('report: status mapping and the headline', () => {
  it('counts passed, not triggered and not checked; a check still pending reads Not checked', () => {
    const r = reportOf(stateOf({ spend_cap: ['passed'], pause_stop: ['passed'], loop_rate: ['not_triggered'], finishes_correctly: ['not_checked'] }));
    expect(r.headline).toBe('2 of 7 passed · 1 not triggered · 4 not checked');
    expect(r.cards.map((c) => c.status)).toEqual(['passed', 'not_triggered', 'not_checked', 'passed', 'not_checked', 'not_checked', 'not_checked']);
    expect(r.tone).toBe('pass');
  });

  it('is neutral when a check failed or none passed, and leaves out zero counts', () => {
    const failed = reportOf(stateOf(Object.fromEntries(CHECK_IDS.map((id) => [id, ['passed']])) as Results));
    expect(failed.headline).toBe('7 of 7 passed');
    expect(failed.tone).toBe('pass');
    expect(reportOf(stateOf({ ...Object.fromEntries(CHECK_IDS.map((id) => [id, ['passed']])), spend_cap: ['failed'] } as Results)).tone).toBe('neutral');
    expect(reportOf(stateOf({})).tone).toBe('neutral');
  });
});

describe('report: what to do next', () => {
  it('passed: nothing to do, and what the agent did comes from the detail', () => {
    const c = card(stateOf({ spend_cap: ['passed', 'Blocked at $0.02, and your agent stopped.'] }), 'spend_cap');
    expect(c.weDid).toMatch(/spend cap/);
    expect(c.agentDid).toBe('Blocked at $0.02, and your agent stopped.');
    expect(c.next).toBe('Nothing to do.');
  });

  it('failed: a concrete fix per check', () => {
    const st = stateOf({ spend_cap: ['failed'], provider_errors: ['failed', 'Retried 6 times in 4 seconds.'] });
    expect(card(st, 'spend_cap').next).toBe('Make your agent stop or back off when WhiteRoom blocks a call (it got a 4xx with a reason).');
    expect(card(st, 'provider_errors').next).toBe('Retry with a back-off of at least 1 second, and give up after a few tries.');
    expect(card(st, 'provider_errors').agentDid).toBe('Retried 6 times in 4 seconds.');
    for (const id of CHECK_IDS) expect(card(stateOf({ [id]: ['failed'] }), id).next).toBe(FIX[id]);
  });

  it('not triggered: the tip from the detail, else a default tip', () => {
    expect(card(stateOf({ loop_rate: ['not_triggered', 'Needs the same call 3 times.'] }), 'loop_rate').next).toBe('Needs the same call 3 times.');
    expect(card(stateOf({ loop_rate: ['not_triggered'] }), 'loop_rate').next).toBe(TRIP_TIP.loop_rate);
    expect(card(stateOf({ loop_rate: ['not_triggered'] }), 'loop_rate').agentDid).toBe('This run didn’t trip it.');
  });

  it('not checked: why and how', () => {
    const fin = card(stateOf({ finishes_correctly: ['not_checked', 'Run practice tasks to check this.'] }), 'finishes_correctly');
    expect(fin.next).toBe(RUN_PRACTICE);
    expect(fin.agentDid).toBe('Not checked. Only practice tasks check this.');
    expect(card(stateOf({ provider_errors: ['not_checked'] }, { injectErrors: false }), 'provider_errors').next).toMatch(/Turn on “Test how my agent handles provider errors”/);
    expect(card(stateOf({ long_task: ['not_checked', 'Your agent stopped calling.'] }), 'long_task').agentDid).toBe('Your agent stopped calling.');
  });

  it('lists the rules each check was judged on', () => {
    const st = stateOf({ spend_cap: ['passed'] }, { rules: [{ ruleId: 'gr_1', ruleType: 'spend_cap', check: 'spend_cap', wouldAct: true, acted: true, status: 'passed', detail: 'Blocked at $0.02.' }] });
    expect(card(st, 'spend_cap').rules).toEqual(['Spend cap · Passed · Blocked at $0.02.']);
    expect(card(st, 'loop_rate').rules).toEqual([]);
  });
});

describe('Copy summary', () => {
  it('is plain text with every card, and no keys, URLs or fleet IDs', () => {
    const st = stateOf(
      { spend_cap: ['failed', `Called with ${PLACEHOLDER_KEY} on ${SANDBOX_ID}`] },
      { rules: [{ ruleId: 'gr_1', ruleType: 'keyword', check: 'allowlists_keywords', wouldAct: true, acted: false, status: 'not_triggered', detail: 'Saw wr_placeholder0000 in a reply.' }] },
    );
    const text = reportSummary(reportOf(st), { checked: '6 min ago', calls: 12 });
    expect(text.startsWith('WhiteRoom Sandbox check: 0 of 7 passed')).toBe(true);
    for (const label of ['What we did:', 'What your agent did:', 'What to do next:', 'Spend cap: Failed', 'Rule: Keywords']) expect(text).toContain(label);
    expect(text).not.toMatch(/sk-wr|wr_placeholder|sandbox-0000|chk_1|https?:/);
    expect(text).toContain('[hidden]');
  });
});

describe('the report on the page', () => {
  let root: Root;
  beforeEach(() => { const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

  it('one card per check with its three lines, Run practice tasks inside the not-checked card, Check again and Copy summary', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report'] })); });
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/\d of 7 passed · 1 not triggered · 1 not checked/);
    const cards = [...document.querySelectorAll('li[data-check]')];
    expect(cards).toHaveLength(7);
    for (const c of cards) for (const label of ['What we did', 'What your agent did', 'What to do next']) expect(c.textContent).toContain(label);
    const fin = document.querySelector('li[data-check="finishes_correctly"]')!;
    expect(fin.querySelector('[data-next] a')?.getAttribute('href')).toBe('/sandbox/practice');
    // The footer link stays too.
    expect([...document.querySelectorAll('a[href="/sandbox/practice"]')].length).toBe(2);
    expect(document.querySelector('a[href^="/controls"]')).toBeNull();
    const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons).toContain('Check again');
    const copy = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Copy summary')!;
    await act(async () => { copy.click(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String((writeText.mock.calls[0] as unknown[])[0])).not.toMatch(/sk-wr|sandbox-|https?:/);
    expect(copy.textContent).toBe('Copied');
  });

  it('renders on its own from a state', () => {
    const html = renderToStaticMarkup(h(ReportView, { state: stateOf({ spend_cap: ['failed'] }), checked: 'just now', calls: 1, again: null }));
    expect(html).toContain('0 of 7 passed · 6 not checked');
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain('1 call');
  });

  it('the live checklist has no report cards until the window ends', () => {
    const html = renderToStaticMarkup(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, preview: SANDBOX_V2_STATES['checks-observe'].checks }));
    expect(html).not.toContain('What to do next');
  });
});

describe('Past tests: hide demos and tests that never started', () => {
  const tests = [
    { sandboxId: 's2', destroyedAt: '2026-10-12T11:00:00Z', overall: 'pass' as const, totalTasks: 4, isTrial: false },
    { sandboxId: 's1', destroyedAt: '2026-10-11T10:00:00Z', overall: 'pass' as const, totalTasks: 6, isTrial: true },
  ];
  const never = { ...PRACTICE_ROWS[0], id: 'r-11111111-1111-4111-8111-111111111111', lifecycle: 'cancelled' as const, verdict: null, tasks: { finished: 0, total: 6 } };

  it('decides what is hidden', () => {
    const rows = pastRows(tests, [PRACTICE_ROWS[0], never]);
    expect(rows.filter(hiddenByDefault).map((r) => r.key).sort()).toEqual([never.id, 's1'].sort());
  });

  it('shows Show all (N), and every row once pressed', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(PastTests, { preview: tests, practice: [PRACTICE_ROWS[0], never] })); });
    const dataRows = () => el.querySelectorAll('[role="row"][tabindex]').length;
    expect(dataRows()).toBe(2);
    expect(el.textContent).not.toContain('Connection test (demo)');
    const more = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Show all (4)')!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { more.click(); });
    expect(dataRows()).toBe(4);
    expect(el.textContent).toContain('Connection test (demo)');
    expect(el.textContent).toContain('Show fewer');
    act(() => root.unmount());
  });

  it('one Kind label per kind, and Tasks as done/total or —', () => {
    const html = renderToStaticMarkup(h(PastTests, { preview: tests, practice: [PRACTICE_ROWS[0]], previewShowAll: true }));
    for (const k of ['>Connection test<', '>Connection test (demo)<', '>Practice tasks<']) expect(html).toContain(k);
    expect(html).not.toMatch(/>Your agent<|>Demo</);
    expect(html).toContain('>—<');
    expect(html).toContain('>18/18<');
  });

  it('says so when only hidden tests exist', () => {
    const html = renderToStaticMarkup(h(PastTests, { preview: [tests[1]] }));
    expect(html).toContain('Only demos and tests that never started so far.');
    expect(html).toContain('Show all (1)');
  });
});

describe('/sandbox/practice is Practice tasks, secondary to Sandbox', () => {
  it.each(['setup', 'passed'] as const)('%s: heading, intro and the way back', (state) => {
    const html = renderToStaticMarkup(h(PracticeTest, { preview: PRACTICE_STATES[state] }));
    expect(html).toMatch(/<h1[^>]*>Practice tasks<\/h1>/);
    expect(PRACTICE_INTRO).toBe('Scripted tasks with known answers. Your agent’s checks live on Sandbox.');
    expect(html).toContain(PRACTICE_INTRO);
    expect(html).toContain('href="/sandbox">← Back to Sandbox</a>');
    expect(html).not.toMatch(/href="\/controls/);
  });
});
