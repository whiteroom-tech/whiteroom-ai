// @vitest-environment happy-dom
// Practice tasks inside the Sandbox page (eight checks spec Rev 7 §6a; mockup
// Rev 3 states 4–6): Run practice tasks opens them as the main card with Back
// to results; the line to paste (CLI pinned, code on stdin, adapter as one
// quoted argument); refusals; progress; a finished test of your own agent goes
// back to the report, bound; another agent's run sums up apart. Placeholder
// codes and keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics', () => ({ analytics: { capture } }));

const { SandboxHome } = await import('@/components/sandbox/v2/SandboxHome');
const { SandboxPractice } = await import('@/components/sandbox/v2/SandboxPractice');
const { ReportView, SandboxChecks } = await import('@/components/sandbox/v2/SandboxChecks');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const { otherRunLine, practiceCommand, practiceRefusal, practiceTaskLines, shellQuote } = await import('@/lib/sandbox/sandbox-practice');
const { PracticeError } = await import('@/lib/sandbox/practice/api');
const { notRunFor, rowsSummary, sandboxRows } = await import('@/lib/sandbox/sandbox-rows');
const { checkStateOf, CHECK_IDS } = await import('@/lib/sandbox/checks');
const { CLI_VERSION } = await import('@/lib/sandbox/practice/model');

const CODE = 'wrrt_placeholder-run-code-for-tests-only-0000000000';
const RUN = 'r-00000000-0000-4000-8000-0000000000aa';
let root: Root;
const text = () => document.body.textContent ?? '';
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const button = (name: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === name).pop() as HTMLButtonElement | undefined;
const click = async (name: string) => { await act(async () => { button(name)!.click(); }); await flush(); };

const run = (over: Record<string, unknown> = {}) => ({
  id: RUN, lifecycle: 'draft', verdict: null, endReason: null, sourceFleetId: 'prod-eu', agentId: 'support-bot', sample: false, runs: 1, scope: null,
  provider: 'anthropic', proxyKeyDisplayPrefix: 'sk-wr-0123456789abcdef', keyHint: 'AbCd', createdAt: '2026-10-29T14:00:00.000Z', startedAt: null, endedAt: null,
  codeExpiresAt: '2026-10-29T14:30:00.000Z', codeTriesLeft: 5, progress: null, profile: 'quick', origin: 'sandbox', plan: null, ...over,
});
let served: Record<string, unknown>;
/** The runs the list returns (an open one is picked up), what Start answers, and a report for a finished run. */
let listed: Record<string, unknown>[];
let startAnswer: () => Response;
let report: (() => Response) | null;
let runRead: (() => Response) | null;
/** The Sandbox's checks: support-bot's live check, ended. */
const checksAnswer = { success: true, window: { id: 'chk_1', startedAt: '2026-10-29T14:00:00.000Z', endedAt: '2026-10-29T14:06:00.000Z', stage: 'done', injectErrors: true, calls: 20, agentId: 'support-bot' }, checks: [], rules: [] };
const RUN2 = 'r-00000000-0000-4000-8000-0000000000bb';
const fetchMock = vi.fn();
const posts = () => fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST').map(([u, i]) => ({ url: String(u), body: JSON.parse(String((i as RequestInit).body)) }));

beforeEach(() => {
  served = run();
  listed = [];
  report = null;
  runRead = null;
  startAnswer = () => Response.json({ runId: RUN, code: CODE, codeExpiresAt: '2026-10-29T14:30:00.000Z' });
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/sandbox/checks/')) return Response.json(checksAnswer);
    if (u.startsWith('/api/sandbox/practice/capabilities')) return Response.json({ profiles: ['quick', 'deep'] });
    if (u.startsWith('/api/sandbox/practice/start')) return startAnswer();
    const m = u.match(/^\/api\/sandbox\/practice\/(r-[0-9a-f-]+)(\/[a-z]+)?/);
    if (m && m[2] === '/end') { served = { ...served, lifecycle: 'cancelled' }; return Response.json({ lifecycle: 'cancelled' }); }
    if (m && m[2] === '/report') return report ? report() : Response.json({ error: 'none' }, { status: 404 });
    if (m) return runRead ? runRead() : Response.json({ ...served, id: m[1] });
    if (init?.method === 'POST') return Response.json({ success: true });
    return Response.json({ runs: listed });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
  try { localStorage.clear(); } catch { /* none */ }
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the line to paste', () => {
  it('pins the CLI, takes the code on stdin, quotes the adapter as one argument, and names the key', () => {
    expect(practiceCommand({ code: CODE, adapter: 'python3 wr_adapter.py', keyVar: 'ANTHROPIC_API_KEY' }))
      .toBe(`echo ${CODE} | npx @whiteroom-ai/cli@${CLI_VERSION} practice run --adapter 'python3 wr_adapter.py' --code-stdin --key-env ANTHROPIC_API_KEY`);
    // The sample agent: no adapter. No code yet: dots.
    expect(practiceCommand({ code: null, adapter: null, keyVar: 'OPENAI_API_KEY' })).toBe(`echo wrrt_••••••• | npx @whiteroom-ai/cli@${CLI_VERSION} practice run --code-stdin --key-env OPENAI_API_KEY`);
    // Whatever the command holds stays one shell word.
    expect(shellQuote(`node a.mjs --name 'x'; rm -rf /`)).toBe(`'node a.mjs --name '\\''x'\\''; rm -rf /'`);
  });

  it('refusals are said plainly; a changed key offers a new code', () => {
    expect(practiceRefusal(new PracticeError('x', 429, 'busy')).message).toBe('Busy, try again in a minute.');
    expect(practiceRefusal(new PracticeError('x', 429, 'starts_today')).message).toBe('You can start more tomorrow.');
    expect(practiceRefusal(new PracticeError('x', 409, 'sandbox_changed'))).toEqual({ message: 'Your Sandbox key changed since this code was made.', newCode: true });
    expect(practiceRefusal(new Error('offline')).message).toMatch(/Check your connection/);
  });

  it('progress names each task by the row it checks, in the settled plan’s order', () => {
    const lines = practiceTaskLines({ plan: { tasks: ['D', 'A', 'C_timeout', 'C_fail'].map((scenario) => ({ scenario, runIndex: 0 })) }, profile: 'quick', scope: null, runs: 1, progress: { done: 1, total: 4, lastContactAt: '' } });
    expect(lines.map((l) => `${l.state}:${l.task}`)).toEqual([
      'done:08 Summarise an inbox (with a planted instruction)', 'now:01 Update the records it was asked to', 'todo:03 A tool that times out', 'todo:03 A tool that keeps failing',
    ]);
    expect(lines[1].label).toBe('01 Finishes the job correctly');
  });

  it('another agent’s run sums up by row, a failure with its own words', () => {
    expect(otherRunLine([
      { id: 'a.result', status: 'passed', summary: '' }, { id: 'c.timeout', status: 'passed', summary: '' }, { id: 'c.keeps_failing', status: 'passed', summary: '' },
      { id: 'd.injection', status: 'failed', summary: 'Sent the file when the email asked' },
    ])).toBe('01 ✓ · 03 ✓ · 08 ✕ Sent the file when the email asked');
  });
});

describe('the report’s words', () => {
  const ended = (status: string) => checkStateOf({ window: { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', endedAt: '2026-10-29T10:06:00.000Z', stage: 'done', injectErrors: true, calls: 24 },
    checks: CHECK_IDS.map((id) => ({ id, label: id, status: id === 'finishes_correctly' ? 'pending' : status, detail: 'Fine.' })), rules: [] })!;
  const PRACTICE = { runId: 'r-1', endedAt: null, checks: ['a.result', 'c.timeout', 'c.keeps_failing', 'd.injection'].map((id) => ({ id, label: id, status: 'passed' as const, summary: 'Passed.', fix: null })) };

  it('Copy summary’s second line has no empty part when the headline carries the count', () => {
    const text = rowsSummary(sandboxRows(ended('passed'), PRACTICE), { when: 'today', calls: 24 });
    expect(text.split('\n')[0]).toBe('WhiteRoom Sandbox check: Nothing to fix · 8 of 8 checked');
    expect(text.split('\n')[1]).toBe('24 calls · today');
  });

  it('notRunFor: practice rows and parts not run yet name whose run they wait for; the rest are untouched', () => {
    const rows = notRunFor(sandboxRows(ended('passed')), 'support-bot');
    expect(rows.find((r) => r.num === '01')?.line).toBe('Not run yet for support-bot.');
    expect(rows.find((r) => r.num === '03')?.parts.find((p) => p.state === 'not_run_yet')?.text).toBe('Not run yet for support-bot');
    expect(rows.find((r) => r.num === '07')?.line).toBe(sandboxRows(ended('passed')).find((r) => r.num === '07')?.line);
  });
});

describe('practice tasks in the page', () => {
  const card = (over: Partial<Parameters<typeof SandboxPractice>[0]> = {}) => h(SandboxPractice, {
    fleet: 'prod-eu', agent: 'support-bot', provider: 'anthropic', sandboxKey: 'sk-wr-0123456789abcdef', onBack: vi.fn(), onFinished: vi.fn(), ...over,
  });

  it('Run practice tasks on the report opens them in place, on Results; Back to results goes back', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report-rows'] })); });
    await flush();
    await click('Run practice tasks');
    expect(document.querySelector('section[aria-label="Practice tasks"]')).not.toBeNull();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('3Results');
    expect(document.querySelector('section[aria-label="What practice tasks check"]')).not.toBeNull();
    expect(document.getElementById('sandbox-step')).toBeNull();
    expect(capture).toHaveBeenCalledWith('sandbox_practice_opened', { profile: 'quick' });
    await click('Back to results');
    expect(document.getElementById('sandbox-step')?.getAttribute('aria-label')).toBe('Results');
  });

  it('Get the command starts from the Sandbox as the report’s agent, quick, and shows the line with the code and quoted adapter', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    expect(text()).toContain('echo wrrt_••••••• |');
    await click('Get the command');
    expect(posts().find((p) => p.url.endsWith('/start'))?.body).toEqual({ fleet: 'prod-eu', sample: false, runs: 1, origin: 'sandbox', profile: 'quick', agent: 'support-bot' });
    expect(text()).toContain(`echo ${CODE} | npx @whiteroom-ai/cli@${CLI_VERSION} practice run --adapter 'python3 wr_adapter.py' --code-stdin --key-env ANTHROPIC_API_KEY`);
    expect(text()).toContain('Runs on your own Anthropic key (ANTHROPIC_API_KEY).');
    expect(text()).toContain('Waiting for your terminal to start the tasks…');
    // Remembered in this browser only.
    expect(localStorage.getItem('wr-sandbox-adapter')).toBe('python3 wr_adapter.py');
    expect(JSON.stringify(capture.mock.calls)).not.toContain(CODE);
  });

  it('the sample agent: no adapter, no profile choice, and a quick start', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    await click('Sample agent');
    expect(document.getElementById('sbx-pt-adapter')).toBeNull();
    expect(text()).not.toContain('How thorough?');
    await click('Get the command');
    expect(posts().find((p) => p.url.endsWith('/start'))?.body).toEqual({ fleet: 'prod-eu', sample: true, runs: 1, origin: 'sandbox', profile: 'quick' });
    expect(text()).not.toContain('--adapter');
  });

  it('a code made for the Sandbox’s old key: Get a new code ends that test and starts another', async () => {
    served = run({ proxyKeyDisplayPrefix: 'sk-wr-ffffffffffffffff' });
    listed = [{ id: RUN, lifecycle: 'draft', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    startAnswer = () => { served = run({ id: RUN2 }); return Response.json({ runId: RUN2, code: CODE, codeExpiresAt: '2026-10-29T14:30:00.000Z' }); };
    await act(async () => { root.render(card()); });
    await flush();
    expect(text()).toContain('Your Sandbox key changed since this code was made.');
    await click('Get a new code');
    expect(posts().map((p) => p.url)).toEqual([`/api/sandbox/practice/${RUN}/end`, '/api/sandbox/practice/start']);
    expect(text()).not.toContain('Your Sandbox key changed');
    expect(text()).toContain(`echo ${CODE} |`);
  });

  it('a refused new code takes the ended draft’s code off the screen', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    expect(text()).toContain(`echo ${CODE} |`);
    startAnswer = () => Response.json({ error: 'Busy', reason: 'busy' }, { status: 429 });
    await click('Get a new code');
    expect(posts().some((p) => p.url.endsWith(`${RUN}/end`))).toBe(true);
    expect(text()).toContain('Busy, try again in a minute.');
    expect(text()).not.toContain(CODE);
    expect(button('Copy')).toBeUndefined();
    expect(text()).not.toContain('Waiting for your terminal');
  });

  it('Deep starts a deep test; changing a choice after a code was made asks for a new one', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    await click('Deep (longer)');
    expect(text()).toContain('Adds 02’s long-task result.');
    await click('Get the command');
    expect(posts().find((p) => p.url.endsWith('/start'))?.body).toMatchObject({ profile: 'deep' });
    expect(text()).toContain(CODE);
    await click('Quick');
    expect(text()).not.toContain(CODE);
    expect(button('Get the command')).toBeDefined();
  });

  it('a busy refusal says so', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/start')
      ? Response.json({ error: 'Busy', reason: 'busy' }, { status: 429 })
      : Response.json(String(url).includes('capabilities') ? { profiles: ['quick'] } : { runs: [] })));
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    expect(text()).toContain('Busy, try again in a minute.');
  });

  it('while running: each task’s state; once your agent’s test ends, back to the report with that run', async () => {
    vi.useFakeTimers();
    const onFinished = vi.fn();
    served = run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', progress: { done: 1, total: 4, lastContactAt: '' }, plan: { tasks: ['D', 'A', 'C_timeout', 'C_fail'].map((scenario) => ({ scenario, runIndex: 0 })) } });
    await act(async () => { root.render(card({ onFinished, preview: undefined })); });
    // The open test is picked up from the list.
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('capabilities')) return Response.json({ profiles: ['quick', 'deep'] });
      if (u.startsWith(`/api/sandbox/practice/${RUN}`)) return Response.json(served);
      return Response.json({ runs: [{ id: RUN, lifecycle: served.lifecycle, agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }] });
    });
    await act(async () => { root.unmount(); });
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => { root.render(card({ onFinished })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(text()).toContain('2 of 4 tasks · 01 Finishes the job correctly');
    expect([...document.querySelectorAll('li[data-state]')].map((li) => li.getAttribute('data-state'))).toEqual(['done', 'now', 'todo', 'todo']);
    served = { ...served, lifecycle: 'finished', endedAt: '2026-10-29T14:12:00.000Z' };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(onFinished).toHaveBeenCalledWith(RUN);
  });

  const active = (over: Record<string, unknown> = {}) => run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', progress: { done: 1, total: 4, lastContactAt: '' }, plan: { tasks: ['D', 'A', 'C_timeout', 'C_fail'].map((scenario) => ({ scenario, runIndex: 0 })) }, ...over });
  const openRun = (r: Record<string, unknown>) => { served = r; listed = [{ id: RUN, lifecycle: r.lifecycle, agentId: r.agentId, sample: r.sample, createdAt: '', endedAt: null }]; };

  it('End: ends your agent’s test and goes back to the report', async () => {
    openRun(active());
    const onFinished = vi.fn();
    await act(async () => { root.render(card({ onFinished })); });
    await flush();
    await click('End');
    expect(posts().some((p) => p.url.endsWith(`${RUN}/end`))).toBe(true);
    expect(onFinished).toHaveBeenCalledWith(RUN);
  });

  it('a finished sample run shows its result in the card, not in the report', async () => {
    vi.useFakeTimers();
    openRun(active({ sample: true, agentId: 'readiness-sample' }));
    report = () => Response.json({ id: RUN, lifecycle: 'finished', verdict: 'passed', detailsKeptUntil: null, summaryKeptUntil: null,
      report: { verdict: 'passed', checks: [{ id: 'd.injection', label: 'Ignores a planted instruction', status: 'passed', summary: 'Passed 1 of 1 run.' }] } });
    const onFinished = vi.fn();
    await act(async () => { root.render(card({ onFinished })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    served = { ...served, lifecycle: 'finished', endedAt: '2026-10-29T14:12:00.000Z' };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(onFinished).not.toHaveBeenCalled();
    expect(text()).toContain('WhiteRoom’s sample agent · Passed');
    expect(text()).toContain('Ignores a planted instruction. Passed 1 of 1 run.');
  });

  it('a sample run whose result can’t be read says so, with a way to it', async () => {
    vi.useFakeTimers();
    openRun(active({ sample: true, agentId: 'readiness-sample' }));
    report = () => Response.json({ error: 'down' }, { status: 503 });
    await act(async () => { root.render(card()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    served = { ...served, lifecycle: 'finished' };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(text()).toContain('The sample run finished, but its result couldn’t be read just now.');
    expect(document.querySelector(`a[href="/sandbox/practice?run=${RUN}"]`)).not.toBeNull();
  });

  it('a progress read refused for good (not retryable) says why and stops', async () => {
    vi.useFakeTimers();
    openRun(active());
    await act(async () => { root.render(card()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    runRead = () => Response.json({ error: 'Not your test.' }, { status: 403 });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(text()).toContain('Not your test.');
  });

  it('row 02’s Deep-test note opens practice tasks on Deep', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report-rows'] })); });
    await flush();
    await act(async () => { (document.querySelector('li[data-row="02"] button') as HTMLButtonElement).click(); });
    await flush();
    expect(document.querySelector('[aria-labelledby="sbx-pt-prof"] button[aria-pressed="true"]')?.textContent).toBe('Deep (longer)');
    expect(capture).toHaveBeenCalledWith('sandbox_practice_opened', { profile: 'deep' });
  });
});

describe('the report after practice tasks', () => {
  const finished = (id: string, createdAt: string, profile = 'quick') => ({ id, lifecycle: 'finished', agentId: 'support-bot', sample: false, profile, createdAt, endedAt: createdAt });
  const reportOf = (summary: string) => Response.json({ id: RUN, lifecycle: 'finished', verdict: 'passed', detailsKeptUntil: null, summaryKeptUntil: null,
    report: { verdict: 'passed', checks: [{ id: 'd.injection', label: 'Ignores a planted instruction', status: 'passed', summary }] } });

  it('a run that finished in the page is the one bound, even with a newer one listed', async () => {
    // RUN finished in the card; a newer run of the same agent exists (another tab). The report binds RUN, and offers the newer one.
    listed = [finished(RUN2, '2026-10-29T15:20:00.000Z'), finished(RUN, '2026-10-29T14:09:00.000Z')];
    report = () => reportOf('Passed 1 of 1 run.');
    await act(async () => { root.render(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: 'sandbox-00000000-0000-4000-8000-000000000000', practiceRun: RUN, onPractice: vi.fn() })); });
    await flush();
    const reads = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.endsWith('/report') || u.includes('/report?'));
    expect(reads.some((u) => u.includes(`/${RUN}/report`))).toBe(true);
    expect(reads.some((u) => u.includes(`/${RUN2}/report`))).toBe(false);
    expect(document.querySelector('li[data-row="08"]')?.getAttribute('data-state')).toBe('passed');
    expect(text()).toContain('A newer practice run is available');
  });

  const state = { window: { id: 'chk_1', startedAt: '2026-10-29T14:00:00.000Z', endedAt: '2026-10-29T14:06:00.000Z', stage: 'done' as const, injectErrors: true, calls: 20, agentId: 'support-bot' }, checks: [], rules: [] };
  const bound = (profile: string) => ({ runId: RUN, endedAt: '2026-10-29T14:09:00.000Z', profile, checks: [{ id: 'd.injection', label: 'x', status: 'passed' as const, summary: 'Passed.', fix: null }] });

  it('the newer-run notice gives its time, and Use it binds it', async () => {
    const onUseNewer = vi.fn();
    await act(async () => { root.render(h(ReportView, { state: state as never, checked: '14:00', calls: 20, now: Date.parse('2026-10-29T16:00:00.000Z'), onUseNewer,
      practice: { bound: bound('quick'), newer: RUN2, newerAt: '2026-10-29T15:20:00.000Z', other: null } })); });
    expect(text()).toMatch(/A newer practice run is available \(.+\)\./);
    await click('Use it');
    expect(onUseNewer).toHaveBeenCalledTimes(1);
  });

  it('the when-line says how thorough the bound run was', async () => {
    for (const [profile, words] of [['quick', '(Quick, your adapter)'], ['deep', '(Deep, your adapter)']] as const) {
      await act(async () => { root.render(h(ReportView, { state: state as never, checked: '14:00', calls: 20, practice: { bound: bound(profile), newer: null, other: null } })); });
      expect(text()).toMatch(new RegExp(`Live check 14:00 · Practice tasks .+ ${words.replace(/[()]/g, '\\$&')}`));
    }
  });
});
