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
// The Sandbox's server actions (plan, Take it live): today's page, nothing on the server.
vi.mock('@/lib/sandbox/sandbox-plan', () => ({ getSandboxPlan: async () => ({ plan: 'other', canBuy: false, invite: null }) }));
vi.mock('@/lib/user-fleets', () => ({ takeItLive: async () => ({ ok: false }) }));
// The plan banner's event name only (the banner itself reads the server).
vi.mock('@/components/AccountPlanBanner', () => ({ PLAN_CHANGED: 'wr:plan-changed' }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { CHECK_IDS, CHECK_NAMES } = await import('@/lib/sandbox/checks');
const { BLOCKED_FIX, ENOUGH_CALLS, failText, FIX, scrub, SCORED_CHECKS, tooFewCalls, tooFewNote } = await import('@/lib/sandbox/check-report');
const { rowsSummary, sandboxRows } = await import('@/lib/sandbox/sandbox-rows');
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
const all = (status: CheckStatus) => Object.fromEntries(CHECK_IDS.map((id) => [id, [status]])) as Results;
const summary = (st: CheckState, when = 'checked 6 min ago') => rowsSummary(sandboxRows(st), { when, calls: 12 });

describe('report: the shared pieces', () => {
  it('too few calls: nothing passed or failed, under about 5 calls', () => {
    const st = (calls: number, results: Results = {}) => ({ ...stateOf(results), window: { ...stateOf({}).window!, calls } });
    expect(tooFewCalls(st(ENOUGH_CALLS - 1))).toBe(true);
    expect(tooFewCalls(st(ENOUGH_CALLS))).toBe(false);
    expect(tooFewCalls(st(1, { spend_cap: ['passed'] }))).toBe(false);
    expect(SCORED_CHECKS).toHaveLength(6);
  });

  it('a failure’s detail loses the engine’s closing "Fix: …"; How to fix says it', () => {
    expect(failText('We returned a provider error (529) → your agent retried it 4 times within 5 s. Fix: retry with a growing wait, and give up after a few tries.'))
      .toBe('We returned a provider error (529) → your agent retried it 4 times within 5 s.');
    // A Fix with a period in it goes whole; a detail that is nothing but "Fix:" (no sentence before it) stays.
    expect(failText('Blocked a call. Fix: wait 1.5 seconds, then try once more.')).toBe('Blocked a call.');
    expect(failText('Fix: this text is the whole detail.')).toBe('Fix: this text is the whole detail.');
    // One fix for a refused call, and no Resume on the page any more.
    expect(FIX.spend_cap).toBe(BLOCKED_FIX);
    expect(FIX.pause_stop).not.toMatch(/Resume/);
  });
});

describe('Copy summary', () => {
  it('keeps ordinary hyphenated words like key-value or tok-limit', () => {
    const text = summary(stateOf({ spend_cap: ['failed', 'Wrote to a key-value store and hit the tok-limit; key_rotation pending.'] }));
    for (const w of ['key-value', 'tok-limit', 'key_rotation']) expect(text).toContain(w);
  });

  it('is plain text in the page’s order, with no keys, URLs or fleet IDs', () => {
    const text = summary(stateOf({ spend_cap: ['failed', `Called with ${PLACEHOLDER_KEY} on ${SANDBOX_ID}`] }));
    expect(text.startsWith('WhiteRoom Sandbox check: 1 thing to fix before going live')).toBe(true);
    expect(text).toContain('12 calls · checked 6 min ago');
    for (const label of ['The agent:', 'The guardrails:', '- 04 Spend cap:', 'How to fix:']) expect(text).toContain(label);
    expect(text.indexOf('The agent:')).toBeLessThan(text.indexOf('The guardrails:'));
    expect(text).not.toMatch(/sk-wr|sandbox-0000|chk_1|https?:/);
    expect(text).toContain('[hidden]');
  });

  it('hides URLs, UUIDs and bare tokens in free-text details, and keeps plain words', () => {
    const uuid = '00000000-0000-4000-8000-000000000000';
    const hex = '0123456789abcdef0123';
    const bare = 'PLACEHOLDERtoken0000placeholder0000';
    const text = summary(stateOf({
      spend_cap: ['failed', 'Posted to https://example.invalid/hooks/placeholder?id=1 and stopped.'],
      long_task: ['failed', `Retried run ${uuid} with fleet-0000placeholder.`],
      pause_stop: ['failed', `Sent header ${bare} and trace ${hex}.`],
    }));
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
    // The eight rows, in number order and two groups; the headline counts them.
    expect([...document.querySelectorAll('li[data-row]')].map((li) => li.getAttribute('data-row'))).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    expect([...document.querySelectorAll('section[aria-label^="The "]')].map((x) => x.getAttribute('aria-label'))).toEqual(['The agent', 'The guardrails']);
    expect(body).toMatch(/\d of 8 checked · 2 need practice tasks/);
    // The failed row opens in place with what happened and how to fix it.
    const fix = document.querySelector('li[data-row="03"]')!;
    expect(fix.getAttribute('data-state')).toBe('failed');
    expect(fix.textContent).toContain('What happened');
    expect(fix.querySelector('[data-next]')?.textContent).toBe(FIX.provider_errors);
    // Rows 01 and 08 are checked in practice tasks: not run yet, a next step, linked.
    expect(document.querySelector('li[data-row="01"]')?.getAttribute('data-state')).toBe('not_run_yet');
    expect(document.querySelector('li[data-row="08"]')?.textContent).toContain('Not run yet: checks in practice tasks.');
    // The Next card beside the report (mockup Rev 3): the fix, then practice tasks for the rows they check.
    const next = document.querySelector('section[aria-label="Next"]')!;
    expect([...next.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Add a back-off to your agent’s retries, then check again.',
      'Run practice tasks for 01, 08 and the rest of 03. A few minutes.',
    ]);
    // Practice tasks open in the page: from rows 01 and 08, Next, and the report's own button (row 02's note has no link, as in the mockup).
    expect([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Run practice tasks')).toHaveLength(4);
    expect(document.querySelector('li[data-row="02"] button')).toBeNull();
    expect(document.querySelector('li[data-row="02"]')?.textContent).toContain('The long-task result is in the Deep test.');
    expect(document.querySelector('a[href^="/sandbox/practice"]')).toBeNull();
    // The Sandbox rules card beside the report: Edit rules opens the editor under the step.
    expect(document.querySelector('section[aria-label="Sandbox rules"]')?.textContent).toContain('5 ready-made · all Watch');
    expect(document.getElementById('sandbox-rules')).toBeNull();
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit rules')!.click(); });
    expect(document.getElementById('sandbox-rules')?.textContent).toContain('Use the ready-made set');
    expect(document.querySelector('a[href^="/controls"]')).toBeNull();
    const again = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Check again')!;
    expect(again.className).toContain('wr-btn--primary');
    const copy = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Copy summary')!;
    await act(async () => { copy.click(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String((writeText.mock.calls[0] as unknown[])[0])).not.toMatch(/sk-wr|sandbox-|https?:/);
    expect(copy.textContent).toBe('Copied');
  });

  it('all passed live: Nothing to fix, in the pass tone; Check again stays the first button (mockup Rev 3)', () => {
    const html = renderToStaticMarkup(h(ReportView, { state: stateOf(all('passed')), checked: 'just now', calls: 30, onAgain: () => {} }));
    expect(html).toContain('Nothing to fix');
    expect(html).toContain('data-tone="pass"');
    expect(html).toMatch(/wr-btn--primary[^>]*>Check again/);
  });

  it('too few calls: the eight rows still show, with one line on what the live checks need', () => {
    const few = { ...stateOf({}), window: { ...stateOf({}).window!, calls: 3, agentId: 'support-bot' } };
    const html = renderToStaticMarkup(h(ReportView, { state: few, checked: 'just now', calls: 3, onAgain: () => {} }));
    expect(html).not.toContain('Not enough calls to check your agent');
    expect(html).toContain('Nothing was checked this time');
    expect(html).toContain('0 of 8 checked · 2 need practice tasks · support-bot · 3 calls · just now');
    expect(html).toContain(tooFewNote(3));
    expect(html).toContain('Only 3 calls this time, so the live checks couldn’t run.');
    // All eight rows, in order; practice rows still offer practice tasks, and so does the next step.
    expect([...html.matchAll(/data-row="(\d\d)"/g)].map((m) => m[1])).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    expect(html).toContain('Not run yet: checks in practice tasks.');
    expect(html).toMatch(/<a[^>]*>Run practice tasks<\/a>/);
    expect(html).toMatch(/>Check again</);
    // Copy summary agrees: the same line under the when-line, then the rows.
    const text = rowsSummary(sandboxRows(few), { when: 'checked just now', calls: 3, lead: tooFewNote(3) });
    const lines = text.split('\n');
    expect(lines[0]).toBe('WhiteRoom Sandbox check: Nothing was checked this time');
    expect(lines[2]).toBe(tooFewNote(3));
    expect(text).toContain('- 01 Finishes the job correctly: Not run yet');
  });

  it('the too-few line names the calls plainly', () => {
    expect(tooFewNote(0)).toMatch(/^No calls reached your Sandbox this time/);
    expect(tooFewNote(1)).toMatch(/^Only 1 call this time/);
    expect(tooFewNote(4)).toMatch(/^Only 4 calls this time/);
  });

  it('enough calls but nothing checked: no "need 5 calls" line; the checks that didn’t run say why', () => {
    const html = renderToStaticMarkup(h(ReportView, { state: stateOf({ long_task: ['not_checked', 'Your agent stopped calling.'] }), checked: 'just now', calls: 12, onAgain: () => {} }));
    expect(html).toContain('Nothing was checked this time');
    expect(html).not.toContain('The checks need about 5 calls');
    expect(html).toContain('0 of 8 checked');
    expect(html).toContain('Your agent stopped calling.');
  });

  it('lists other agents that called (not checked), and how a streaming agent’s rules treat its replies', () => {
    const base = stateOf(all('passed'));
    const html = renderToStaticMarkup(h(ReportView, { state: { ...base, window: { ...base.window!, otherAgents: ['billing-agent', 'ops-bot'] }, streaming: { streamed: true, lines: ['Tool list: in Watch, streamed replies aren’t checked; they pass and say so.'] } }, checked: 'just now', calls: 30 }));
    expect(html).toContain('Also called during this check: billing-agent, ops-bot (not checked).');
    expect(html).toContain('Your agent streams: how your rules treat its replies');
    expect(html).toContain('Tool list: in Watch, streamed replies aren’t checked; they pass and say so.');
    const quiet = renderToStaticMarkup(h(ReportView, { state: base, checked: 'just now', calls: 30 }));
    expect(quiet).not.toMatch(/Also called during|Your agent streams/);
  });

  it('practice tasks bound to the report fill all eight rows, with each part’s time; only the deep test’s long task is still linked', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report-practice'] })); });
    const body = document.body.textContent ?? '';
    expect(document.querySelector('li[data-row="08"]')?.getAttribute('data-state')).toBe('passed');
    expect(document.querySelector('li[data-row="01"]')?.getAttribute('data-state')).toBe('passed');
    expect(body).toMatch(/8 of 8 checked/);
    expect(body).toMatch(/Live check .+ · Practice tasks /);
    // No row points on: every practice row is filled (row 02's note names the Deep test; Next offers it).
    expect([...document.querySelectorAll('li[data-row] button')].filter((b) => b.textContent === 'Run practice tasks')).toEqual([]);
    expect(body).not.toContain('Next: Run practice tasks');
  });

  it('another agent’s practice run is shown apart and not counted; this agent’s rows still link to practice tasks', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report-other-agent'] })); });
    const body = document.body.textContent ?? '';
    expect(body).toContain('Practice tasks (different agent): billing-agent');
    expect(body).toContain('These don’t count toward support-bot’s checks.');
    expect(body).toContain('01 ✓ · 03 ✓ · 08 ✕ Sent the file when the email asked');
    expect(body).toContain('Nothing to fix · 6 of 8 checked');
    expect(body).toContain('2 need practice tasks · support-bot');
    // The practice rows say whose run they still wait for, and open practice tasks in the page.
    expect(document.querySelector('li[data-row="08"]')?.textContent).toContain('Not run yet for support-bot.');
    expect([...document.querySelectorAll('li[data-row="01"] button')].some((b) => b.textContent === 'Run practice tasks')).toBe(true);
    // Apart, between the two groups (mockup Rev 3).
    const apart = document.querySelector('[data-other-run]')!;
    expect(apart.previousElementSibling?.getAttribute('aria-label')).toBe('The agent');
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
