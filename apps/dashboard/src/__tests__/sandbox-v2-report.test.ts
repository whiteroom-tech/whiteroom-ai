// @vitest-environment happy-dom
// Sandbox v2 phases 6–7: the report once a checking window ends (status
// mapping, next steps, rule lines, Copy summary without keys, URLs or IDs), Past tests
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
const { ENOUGH_CALLS, KEEP_RUNNING, TOO_FEW_HELP, NOT_REACHED, reportOf, reportSummary, scrub, FIX, SCORED_CHECKS, TRIP_TIP, verdictOf } = await import('@/lib/sandbox/check-report');
const { COPY_RESET_MS, copyText, ReportView, SandboxChecks } = await import('@/components/sandbox/v2/SandboxChecks');
const { SandboxHome } = await import('@/components/sandbox/v2/SandboxHome');
const { PastTestDetail, PastTests, hiddenByDefault, pastRows, rowTasks } = await import('@/components/sandbox/PastTests');
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
const card = (st: CheckState, id: CheckId) => { const r = reportOf(st); return [...r.fix, ...r.ok, ...r.skipped].find((c) => c.id === id)!; };
const all = (status: CheckStatus) => Object.fromEntries(CHECK_IDS.map((id) => [id, [status]])) as Results;

describe('report: the verdict, scored over six checks', () => {
  it('a failure leads: "N things to fix", warn tone, never red', () => {
    const one = reportOf(stateOf({ ...all('passed'), provider_errors: ['failed'] }));
    expect(one.headline).toBe('1 thing to fix before going live');
    expect([one.verdict, one.tone]).toEqual(['fix', 'warn']);
    expect(reportOf(stateOf({ spend_cap: ['failed'], loop_rate: ['failed'] })).headline).toBe('2 things to fix before going live');
  });

  it('every scored check passed: "Your agent passed every check", whatever Finishes the job correctly says', () => {
    const r = reportOf(stateOf({ ...all('passed'), finishes_correctly: ['not_checked'] }));
    expect(r.headline).toBe('Your agent passed every check');
    expect([r.verdict, r.tone, r.passed, r.failed, r.notRun]).toEqual(['pass', 'pass', 6, 0, 0]);
    expect([...r.fix, ...r.ok, ...r.skipped].map((c) => c.id)).not.toContain('finishes_correctly');
    expect(SCORED_CHECKS).toHaveLength(6);
  });

  it('no failures, some didn’t run: "No problems found · N didn’t run"; a check still pending reads Not checked', () => {
    const r = reportOf(stateOf({ spend_cap: ['passed'], pause_stop: ['passed'], loop_rate: ['not_triggered'] }));
    expect(r.headline).toBe('No problems found · 4 checks didn’t run');
    expect(r.tone).toBe('neutral');
    expect(r.skipped.map((c) => [c.id, c.status])).toEqual([['loop_rate', 'not_triggered'], ['allowlists_keywords', 'not_checked'], ['long_task', 'not_checked'], ['provider_errors', 'not_checked']]);
  });

  it('nothing passed or failed: too few calls, or nothing checked', () => {
    expect(verdictOf({ passed: 0, failed: 0, notRun: 6 }, ENOUGH_CALLS - 1)).toEqual({ verdict: 'too_few', headline: 'Not enough calls to check your agent', tone: 'neutral' });
    expect(verdictOf({ passed: 0, failed: 0, notRun: 6 }, ENOUGH_CALLS).headline).toBe('Nothing was checked this time');
    expect(verdictOf({ passed: 1, failed: 0, notRun: 0 }, 0).verdict).toBe('pass');
  });
});

describe('report: each check', () => {
  it('passed: what happened, from the detail; nothing to do', () => {
    const c = card(stateOf({ spend_cap: ['passed', 'Blocked at $0.02, and your agent stopped.'] }), 'spend_cap');
    expect(c.happened).toBe('Blocked at $0.02, and your agent stopped.');
    expect(c.next).toBeNull();
  });

  it('failed: a concrete fix per check', () => {
    const st = stateOf({ spend_cap: ['failed'], provider_errors: ['failed', 'Retried 6 times in 4 seconds.'] });
    expect(card(st, 'provider_errors').next).toBe('Retry with a back-off of at least 1 second, and give up after a few tries.');
    expect(card(st, 'provider_errors').happened).toBe('Retried 6 times in 4 seconds.');
    for (const id of SCORED_CHECKS) expect(card(stateOf({ [id]: ['failed'] }), id).next).toBe(FIX[id]);
    // No Resume on the page any more: the fix doesn't mention it.
    expect(FIX.pause_stop).not.toMatch(/Resume/);
  });

  it('not triggered: the tip from the detail, else a default tip', () => {
    expect(card(stateOf({ loop_rate: ['not_triggered', 'Needs the same call 3 times.'] }), 'loop_rate').next).toBe('Needs the same call 3 times.');
    expect(card(stateOf({ loop_rate: ['not_triggered'] }), 'loop_rate').next).toBe(TRIP_TIP.loop_rate);
    expect(card(stateOf({ loop_rate: ['not_triggered'] }), 'loop_rate').happened).toBe('This run didn’t trip it.');
  });

  it('not checked: the engine’s reason, else not reached; then keep it running (no dead toggle line)', () => {
    expect(card(stateOf({ long_task: ['not_checked', 'Your agent stopped calling.'] }), 'long_task').happened).toBe('Your agent stopped calling.');
    const c = card(stateOf({ provider_errors: ['not_checked'] }, { injectErrors: false }), 'provider_errors');
    expect([c.happened, c.next]).toEqual([NOT_REACHED, KEEP_RUNNING]);
  });

  it('lists the rules each check was judged on', () => {
    const st = stateOf({ spend_cap: ['passed'] }, { rules: [{ ruleId: 'gr_1', ruleType: 'spend_cap', check: 'spend_cap', wouldAct: true, acted: true, status: 'passed', detail: 'Blocked at $0.02.' }] });
    expect(card(st, 'spend_cap').rules).toEqual(['Spend cap · Passed · Blocked at $0.02.']);
    expect(card(st, 'loop_rate').rules).toEqual([]);
  });
});

describe('Copy summary', () => {
  it('passed checks are one line, without their rules, as on the page', () => {
    const rule = (check: CheckId, status: CheckStatus) => ({ ruleId: `gr_${check}`, ruleType: 'spend_cap', check, wouldAct: true, acted: true, status, detail: `Rule detail ${check}` });
    const st = stateOf({ spend_cap: ['passed'], loop_rate: ['failed'] }, { rules: [rule('spend_cap', 'passed'), rule('loop_rate', 'failed')] });
    const text = reportSummary(reportOf(st), { checked: 'just now', calls: 12 });
    expect(text).not.toContain('Rule detail spend_cap');
    expect(text).toContain('Rule detail loop_rate');
  });

  it('keeps ordinary hyphenated words like key-value or tok-limit', () => {
    const st = stateOf({ spend_cap: ['failed', 'Wrote to a key-value store and hit the tok-limit; key_rotation pending.'] });
    const text = reportSummary(reportOf(st), { checked: '1 min ago', calls: 3 });
    for (const w of ['key-value', 'tok-limit', 'key_rotation']) expect(text).toContain(w);
  });

  it('is plain text with every card, and no keys, URLs or fleet IDs', () => {
    const st = stateOf(
      { spend_cap: ['failed', `Called with ${PLACEHOLDER_KEY} on ${SANDBOX_ID}`] },
      { rules: [{ ruleId: 'gr_1', ruleType: 'keyword', check: 'allowlists_keywords', wouldAct: true, acted: false, status: 'not_triggered', detail: 'Saw wr_placeholder0000 in a reply.' }] },
    );
    const text = reportSummary(reportOf(st), { checked: '6 min ago', calls: 12 });
    expect(text.startsWith('WhiteRoom Sandbox check: 1 thing to fix before going live')).toBe(true);
    for (const label of ['To fix:', '- Spend cap:', 'How to fix:', 'Didn’t run:', 'Rule: Keywords', 'Finishes the job correctly (run practice tasks)']) expect(text).toContain(label);
    // In the page's order: to fix before what didn't run.
    expect(text.indexOf('To fix:')).toBeLessThan(text.indexOf('Didn’t run:'));
    expect(text).not.toMatch(/sk-wr|wr_placeholder|sandbox-0000|chk_1|https?:/);
    expect(text).toContain('[hidden]');
  });

  it('hides URLs, UUIDs and bare tokens in free-text details, and keeps plain words', () => {
    const uuid = '00000000-0000-4000-8000-000000000000';
    const hex = '0123456789abcdef0123';
    const bare = 'PLACEHOLDERtoken0000placeholder0000';
    const st = stateOf({
      spend_cap: ['failed', 'Posted to https://example.invalid/hooks/placeholder?id=1 and stopped.'],
      loop_rate: ['failed', `Retried run ${uuid} with fleet-0000placeholder.`],
      pause_stop: ['failed', `Sent header ${bare} and trace ${hex}.`],
    });
    const text = reportSummary(reportOf(st), { checked: '6 min ago', calls: 12 });
    expect(text).not.toMatch(/https?:|example\.invalid|00000000-0000|fleet-0000|PLACEHOLDERtoken|0123456789abcdef/);
    expect(text).toContain('Posted to [hidden] and stopped.');
    expect(text).toContain('Retried run [hidden] with [hidden].');
    expect(text).toContain('Sent header [hidden] and trace [hidden].');
    expect(scrub('Blocked at $0.02 after 1,234 calls on allowlists_keywords (529).')).toBe('Blocked at $0.02 after 1,234 calls on allowlists_keywords (529).');
  });
});

describe('the report on the page', () => {
  let root: Root;
  beforeEach(() => { const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

  it('verdict, fixes open, passed one line each, the rest folded; practice as the next step; Check again and Copy summary', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report'] })); });
    const body = document.body.textContent ?? '';
    expect(document.querySelector('h3[data-tone]')?.textContent).toBe('1 thing to fix before going live');
    expect(body).toContain('6 checks · ');
    expect(body).not.toMatch(/of 7 passed|What we did|Nothing to do/);
    // The failed check is a card with what happened and how to fix it.
    const fix = document.querySelector('li[data-check="provider_errors"]')!;
    expect(fix.textContent).toContain('What happened');
    expect(fix.querySelector('[data-next]')?.textContent).toBe(FIX.provider_errors);
    // Passed checks are one line each; one that didn't run is inside a closed section.
    expect(document.querySelector('li[data-check="spend_cap"]')?.textContent).toMatch(/^Spend cap\. /);
    const folded = document.querySelector('li[data-check="loop_rate"]')!;
    expect(folded.closest('details')?.querySelector('summary')?.textContent).toBe('1 check didn’t run this time');
    // Finishes the job correctly isn't scored; practice tasks is the next step (and the footer link stays).
    expect(document.querySelector('li[data-check="finishes_correctly"]')).toBeNull();
    expect(body).toContain('Next: check its answers too.');
    // The Connect step's footer link isn't on Results: just the next step.
    expect([...document.querySelectorAll('a[href="/sandbox/practice"]')].length).toBe(1);
    // "Checked against N Sandbox rules · Change rules" opens the closed rules section.
    expect(body).toMatch(/Checked against \d+ Sandbox rules · Change rules/);
    const rules = document.getElementById('sandbox-rules') as HTMLDetailsElement;
    expect(rules.open).toBe(false);
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Change rules')!.click(); });
    expect(rules.open).toBe(true);
    expect(document.querySelector('a[href^="/controls"]')).toBeNull();
    const again = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Check again')!;
    expect(again.className).toContain('wr-btn--primary');
    const copy = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Copy summary')!;
    await act(async () => { copy.click(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String((writeText.mock.calls[0] as unknown[])[0])).not.toMatch(/sk-wr|sandbox-|https?:/);
    expect(copy.textContent).toBe('Copied');
  });

  it('all passed: Check again is secondary, and there is no "Passed" heading or folded section', () => {
    const html = renderToStaticMarkup(h(ReportView, { state: stateOf(all('passed')), checked: 'just now', calls: 30, onAgain: () => {} }));
    expect(html).toContain('Your agent passed every check');
    expect(html).toContain('data-tone="pass"');
    expect(html).toMatch(/wr-btn--secondary[^>]*>Check again/);
    expect(html).not.toMatch(/>Passed<|didn’t run this time/);
  });

  it('too few calls: says what the checks need, no score and no practice step', () => {
    const html = renderToStaticMarkup(h(ReportView, { state: { ...stateOf({}), window: { ...stateOf({}).window!, calls: 3 } }, checked: 'just now', calls: 3, onAgain: () => {} }));
    expect(html).toContain('Not enough calls to check your agent');
    expect(html).toContain('3 calls · checked just now');
    expect(html).toContain('The checks need about 5 calls from one run.');
    expect(html).not.toMatch(/6 checks|Next: check its answers/);
    // Copy summary agrees: no practice-tasks line either.
    const st = { ...stateOf({}), window: { ...stateOf({}).window!, calls: 3 } };
    const few = reportSummary(reportOf(st), { checked: 'just now', calls: 3 });
    expect(few).not.toMatch(/practice tasks|Didn’t run/);
    expect(few).toContain(TOO_FEW_HELP);
    expect(reportSummary(reportOf(stateOf({ spend_cap: ['passed'] })), { checked: 'just now', calls: 12 })).toContain('Finishes the job correctly (run practice tasks)');
  });

  it('enough calls but nothing checked: no "need 5 calls" line; the checks that didn’t run say why', () => {
    const html = renderToStaticMarkup(h(ReportView, { state: stateOf({ long_task: ['not_checked', 'Your agent stopped calling.'] }), checked: 'just now', calls: 12, onAgain: () => {} }));
    expect(html).toContain('Nothing was checked this time');
    expect(html).not.toContain('The checks need about 5 calls');
    expect(html).toContain('6 checks didn’t run this time');
    expect(html).toContain('Your agent stopped calling.');
  });

  it('focuses the verdict when asked (a report that appears while the page is open)', async () => {
    await act(async () => { root.render(h(ReportView, { state: stateOf({ spend_cap: ['failed'] }), checked: 'just now', calls: 8, focus: true })); });
    expect(document.activeElement?.tagName).toBe('H3');
    expect(document.activeElement?.textContent).toBe('1 thing to fix before going live');
  });

  it('says when copying fails, and resets after a while; a second click restarts the timer', async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn(async (): Promise<void> => { throw new Error('denied'); });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await act(async () => { root.render(h(ReportView, { state: stateOf({ spend_cap: ['passed'] }), checked: 'just now', calls: 1 })); });
      const copy = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Copy summary')!;
      await act(async () => { copy.click(); });
      expect(document.body.textContent).toContain('Couldn’t copy. Try again.');
      await act(async () => { vi.advanceTimersByTime(COPY_RESET_MS - 500); });
      writeText.mockImplementation(async () => {});
      await act(async () => { copy.click(); });
      expect(copy.textContent).toBe('Copied');
      expect(document.body.textContent).not.toContain('Couldn’t copy');
      // The first click's timer was cleared: still Copied past its deadline.
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(copy.textContent).toBe('Copied');
      await act(async () => { vi.advanceTimersByTime(COPY_RESET_MS); });
      expect(copy.textContent).toBe('Copy summary');
      // Unmounting with a reset pending is quiet.
      await act(async () => { copy.click(); });
      act(() => root.unmount());
      await act(async () => { vi.advanceTimersByTime(COPY_RESET_MS * 2); });
      root = createRoot(document.body.appendChild(document.createElement('div')));
    } finally {
      vi.useRealTimers();
    }
  });

  it('copyText never throws: no clipboard, or writeText throwing synchronously', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await expect(copyText('x')).resolves.toBe(false);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => { throw new Error('sync'); } }, configurable: true });
    await expect(copyText('x')).resolves.toBe(false);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
    await expect(copyText('x')).resolves.toBe(true);
  });

  it('renders on its own from a state', () => {
    const html = renderToStaticMarkup(h(ReportView, { state: stateOf({ spend_cap: ['failed'] }), checked: 'just now', calls: 1 }));
    expect(html).toContain('1 thing to fix before going live');
    expect(html).toContain('data-tone="warn"');
    expect(html).toContain('1 call');
    // No onAgain: no Check again.
    expect(html).not.toContain('Check again');
  });

  it('the live checklist has no report cards until the window ends', () => {
    const html = renderToStaticMarkup(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, preview: SANDBOX_V2_STATES['checks-observe'].checks }));
    expect(html).not.toContain('How to fix');
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

  it('a hidden row opened under Show all stays shown after Show fewer', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(PastTests, { preview: tests, practice: [PRACTICE_ROWS[0]] })); });
    const dataRows = () => [...el.querySelectorAll<HTMLElement>('[role="row"][tabindex]')];
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Show all (3)')!.click(); });
    const demo = dataRows().find((r) => r.textContent?.includes('Connection test (demo)'))!;
    await act(async () => { demo.click(); });
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Show fewer')!.click(); });
    expect(dataRows()).toHaveLength(3);
    expect(el.textContent).toContain('Connection test (demo)');
    expect(el.textContent).toContain('Test ID');
    act(() => root.unmount());
  });

  it('one Kind label per kind, and Tasks as the count, done/total, or — when unknown', () => {
    const html = renderToStaticMarkup(h(PastTests, { preview: tests, practice: [PRACTICE_ROWS[0]], previewShowAll: true }));
    for (const k of ['>Connection test<', '>Connection test (demo)<', '>Practice tasks<']) expect(html).toContain(k);
    expect(html).not.toMatch(/>Your agent<|>Demo</);
    expect(html).toContain('>4<');
    expect(html).toContain('>6<');
    expect(html).toContain('>18/18<');
    const [row] = pastRows([tests[0]], []);
    expect(rowTasks(row)).toBe('4');
    expect(rowTasks(pastRows([{ ...tests[0], totalTasks: undefined as unknown as number }], [])[0])).toBe('—');
    expect(rowTasks(pastRows([], [{ ...PRACTICE_ROWS[0], tasks: { finished: 0, total: 0 } }])[0])).toBe('—');
  });

  it('a connection test row and its detail show the same task count', () => {
    const t = { ...tests[0], totalTasks: 9 };
    const detail = renderToStaticMarkup(h(PastTestDetail, { test: t, onClose: () => {} }));
    expect(detail).toMatch(/<dt>Tasks<\/dt><dd>9 /);
    expect(rowTasks(pastRows([t], [])[0])).toBe('9');
    const list = renderToStaticMarkup(h(PastTests, { preview: [t], previewOpen: 's2' }));
    expect(list).toContain('>9<');
    expect(list).toMatch(/<dt>Tasks<\/dt><dd>9 /);
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
