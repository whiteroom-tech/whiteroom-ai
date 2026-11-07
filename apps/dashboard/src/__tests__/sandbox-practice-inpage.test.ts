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
const { endedWords, leftWords, otherRunLine, practiceCommand, practiceRefusal, practiceTaskLines, shellQuote, taskTimes, tasksDone } = await import('@/lib/sandbox/sandbox-practice');
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
  provider: 'anthropic', proxyKeyDisplayPrefix: 'sk-wr-0000000000000000', keyHint: 'AbCd', createdAt: '2026-10-29T14:00:00.000Z', startedAt: null, endedAt: null,
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
/** A new code for the same test (POST /:id/code). */
const CODE2 = 'wrrt_placeholder-second-code-for-tests-only-111111111';
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
    if (m && m[2] === '/code') return Response.json({ code: CODE2, codeExpiresAt: '2026-10-29T15:00:00.000Z' });
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
    expect(practiceCommand({ code: CODE, adapter: 'python3 wr_adapter.py', provider: 'anthropic' }))
      .toBe(`echo ${CODE} | npx @whiteroom-ai/cli@${CLI_VERSION} practice run --adapter 'python3 wr_adapter.py' --code-stdin --key-env ANTHROPIC_API_KEY`);
    // The sample agent: no adapter. No code yet: dots.
    // The sample agent names no key (any Anthropic or OpenAI key of yours), whatever the Sandbox's provider: never a cloud one it can't use.
    expect(practiceCommand({ code: null, adapter: null, provider: 'openai' })).toBe(`echo wrrt_••••••• | npx @whiteroom-ai/cli@${CLI_VERSION} practice run --code-stdin`);
    expect(practiceCommand({ code: null, adapter: null, provider: 'azure-openai' })).not.toContain('--key-env');
    // Whatever the command holds stays one shell word.
    expect(shellQuote(`node a.mjs --name 'x'; rm -rf /`)).toBe(`'node a.mjs --name '\\''x'\\''; rm -rf /'`);
  });

  it('refusals use the engine’s own words, as on the practice page; a changed key offers a new code; an open test offers itself', () => {
    expect(practiceRefusal(new PracticeError('You can start more tomorrow (00:00 UTC).', 429, 'starts_today')).message).toBe('You can start more tomorrow (00:00 UTC).');
    expect(practiceRefusal(new PracticeError('x', 409, 'sandbox_changed'))).toEqual({ message: 'Your Sandbox key changed since this code was made.', newCode: true });
    expect(practiceRefusal(new PracticeError('You already have a practice test open.', 429, 'owner_busy', { run: { id: RUN, lifecycle: 'active' } })))
      .toEqual({ message: 'You already have a practice test open.', openRun: { id: RUN, lifecycle: 'active' } });
    expect(practiceRefusal(new PracticeError('x', 429, 'owner_busy', { run: { lifecycle: 'active', otherFleet: true } })).message)
      .toBe('You already have a practice test open on another fleet. Finish or end it there, then start this one.');
    expect(practiceRefusal(new Error('offline')).message).toMatch(/Check your connection/);
  });

  it('a test that ended without finishing is said plainly: expired, cancelled, interrupted', () => {
    expect(endedWords({ lifecycle: 'cancelled', endReason: 'code_expired', startedAt: null, sample: false }).message).toBe('The code expired. Get a new code.');
    expect(endedWords({ lifecycle: 'interrupted', endReason: 'lost_contact', startedAt: 'x', sample: false }).message).toBe('The test was interrupted. Run it again.');
    expect(endedWords({ lifecycle: 'cancelled', endReason: 'ended_by_owner', startedAt: 'x', sample: false }).message).toBe('The practice tasks ended before they finished.');
    expect(endedWords({ lifecycle: 'cancelled', endReason: 'ended_by_owner', startedAt: null, sample: false }).message).toBe('That code was cancelled before the tasks started. Get a new code.');
    expect(endedWords({ lifecycle: 'cancelled', endReason: 'ended_by_owner', startedAt: 'x', sample: true }).message).toBe('The sample run ended before it finished.');
  });

  it('times and the estimate come from tasks the page saw finish', () => {
    const t0 = 1_000_000;
    // Task 1 seen 32 s after the start, 18 s ago: 3 to go at 32 s each, less the 18 s the next has had.
    expect(taskTimes([t0 + 32_000], t0, 4, t0 + 50_000)).toEqual({ seconds: [32], left: 78 });
    expect(leftWords(78)).toBe('about 1 min left');
    // Done before the card opened: no time, no estimate.
    expect(taskTimes([null], t0, 4, t0 + 50_000)).toEqual({ seconds: [null], left: null });
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
    // ✓ only when every check in the row passed: one not checked (or a test problem) reads –.
    expect(otherRunLine([
      { id: 'a.result', status: 'passed', summary: '' },
      { id: 'c.timeout', status: 'passed', summary: '' }, { id: 'c.keeps_failing', status: 'not_checked' as never, summary: '' },
      { id: 'd.injection', status: 'error' as never, summary: '' },
    ])).toBe('01 ✓ · 03 – · 08 –');
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
    fleet: 'prod-eu', agent: 'support-bot', provider: 'anthropic', sandboxKey: 'sk-wr-0000000000000000', onBack: vi.fn(), onFinished: vi.fn(), ...over,
  });

  it('Run practice tasks on the report opens them in place, on Results; Back to results goes back', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report-rows'] })); });
    await flush();
    await click('Run practice tasks');
    expect(document.querySelector('section[aria-label="Practice tasks"]')).not.toBeNull();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('3Results');
    expect(document.querySelector('section[aria-label="What practice tasks check"]')).not.toBeNull();
    // The report stays mounted, hidden, under the practice card.
    expect(document.getElementById('sandbox-step')?.closest('[hidden]')).not.toBeNull();
    expect(capture).toHaveBeenCalledWith('sandbox_practice_opened', { profile: 'quick' });
    await click('Back to results');
    expect(document.getElementById('sandbox-step')?.closest('[hidden]')).toBeNull();
    expect(document.getElementById('sandbox-step')?.getAttribute('aria-label')).toBe('Results');
    // Focus back on the report's verdict.
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement?.tagName).toBe('H3');
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

  it('the same choices reuse the draft: Get a new code asks for a code, not a start', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    expect(posts().filter((p) => p.url.endsWith('/start'))).toHaveLength(1);
    await click('Get a new code');
    expect(posts().filter((p) => p.url.endsWith('/start'))).toHaveLength(1);
    expect(posts().some((p) => p.url.endsWith(`${RUN}/code`))).toBe(true);
    expect(text()).toContain(`echo ${CODE2} |`);
  });

  it('typing the adapter never starts a test: the line changes, the code stays', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    const input = document.getElementById('sbx-pt-adapter') as HTMLInputElement;
    for (const v of ['n', 'no', 'node a.mjs']) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    expect(posts().filter((p) => p.url.endsWith('/start'))).toHaveLength(1);
    expect(text()).toContain(`echo ${CODE} | npx @whiteroom-ai/cli@${CLI_VERSION} practice run --adapter 'node a.mjs'`);
  });

  it('a draft from before (Back to results and back) isn’t renewed on its own: Get a new code, no start spent', async () => {
    listed = [{ id: RUN, lifecycle: 'draft', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    await act(async () => { root.render(card()); });
    await flush();
    // A code already copied (or in another tab) keeps working: nothing is asked of the engine yet.
    expect(posts()).toHaveLength(0);
    await click('Get a new code');
    expect(posts().map((p) => p.url)).toEqual([`/api/sandbox/practice/${RUN}/code`]);
    expect(text()).toContain(`echo ${CODE2} |`);
  });

  it('a draft started on the practice page isn’t picked up or reused; Start’s "open test" sends you there', async () => {
    served = run({ origin: null, proxyKeyDisplayPrefix: null });
    listed = [{ id: RUN, lifecycle: 'draft', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    startAnswer = () => Response.json({ error: 'You already have a practice test open.', reason: 'owner_busy', run: { id: RUN, lifecycle: 'draft' } }, { status: 429 });
    await act(async () => { root.render(card()); });
    await flush();
    expect(button('Get the command')).toBeDefined();
    expect(posts()).toHaveLength(0);
    await click('Get the command');
    expect(posts().some((p) => p.url.endsWith(`${RUN}/code`) || p.url.endsWith(`${RUN}/end`))).toBe(false);
    await click('Open it');
    expect(text()).toContain('That test was started on the practice page.');
    expect(document.querySelector(`a[href="/sandbox/practice?run=${RUN}"]`)).not.toBeNull();
  });

  it('a Deep link with a quick draft open stays Deep: its Get starts a deep test, never the quick code', async () => {
    listed = [{ id: RUN, lifecycle: 'draft', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    await act(async () => { root.render(card({ initialProfile: 'deep' })); });
    await flush();
    expect(document.querySelector('[role="radiogroup"][aria-label="How thorough?"] [aria-checked="true"]')?.textContent).toBe('Deep (longer)');
    await click('Get the command');
    expect(posts().find((p) => p.url.endsWith('/start'))?.body).toMatchObject({ profile: 'deep', runs: 3 });
    expect(posts().some((p) => p.url.endsWith(`${RUN}/end`))).toBe(true);
  });

  it('the sample agent on a cloud Sandbox: no --key-env, and the key line says any Anthropic or OpenAI key', async () => {
    await act(async () => { root.render(card({ provider: 'azure-openai' })); });
    await flush();
    await click('Sample agent');
    expect(text()).not.toContain('--key-env');
    expect(text()).toContain('Set ANTHROPIC_API_KEY or OPENAI_API_KEY to any key of yours');
    expect(text()).not.toContain('AZURE_OPENAI_API_KEY');
  });

  it('a non-cloud key: no model is sent, and source-model isn’t asked', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    expect(posts().find((p) => p.url.endsWith('/start'))?.body).not.toHaveProperty('model');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/source-model'))).toBe(false);
  });

  it('a cloud key asks source-model for the Sandbox’s calls; an engine that ignores it (no model) leaves the field empty', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (String(url).includes('/source-model')
      ? Response.json({ model: null, provider: 'unknown', directKey: true, blocked: null, providerKeys: [], controls: null })
      : base(url, init)));
    await act(async () => { root.render(card({ provider: 'azure-openai' })); });
    await flush();
    const asked = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/source-model'))!;
    expect(asked).toContain('origin=sandbox');
    expect((document.getElementById('sbx-pt-model') as HTMLInputElement).value).toBe('');
    expect(button('Get the command')!.disabled).toBe(true);
  });

  it('a deep run’s progress counts tasks, not the control-check step: card and report agree', async () => {
    const plan = { tasks: ['D', 'A', 'controls', 'C_timeout'].map((scenario) => ({ scenario, runIndex: 0 })) };
    // Three steps done, one of them the control checks: two tasks done.
    expect(tasksDone({ plan, profile: 'deep', scope: null, runs: 1, progress: { done: 3, total: 4, lastContactAt: '' } })).toBe(2);
    expect(practiceTaskLines({ plan, profile: 'deep', scope: null, runs: 1, progress: { done: 3, total: 4, lastContactAt: '' } }).map((l) => l.state)).toEqual(['done', 'done', 'now']);
    vi.useFakeTimers();
    served = run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', profile: 'deep', progress: { done: 3, total: 4, lastContactAt: '' }, plan });
    listed = [{ id: RUN, lifecycle: 'active', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    await act(async () => { root.render(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: 'sandbox-00000000-0000-4000-8000-000000000000', onPractice: vi.fn() })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(text()).toContain('Practice tasks running · 3 of 3');
  });

  it('changing how thorough after a code ends that draft; a refused start leaves no dead code to copy', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    await click('Deep (longer)');
    startAnswer = () => Response.json({ error: 'Busy', reason: 'busy' }, { status: 429 });
    await click('Get the command');
    expect(posts().some((p) => p.url.endsWith(`${RUN}/end`))).toBe(true);
    expect(text()).toContain('Busy');
    expect(text()).not.toContain(CODE);
    expect(button('Copy')).toBeUndefined();
    expect(text()).not.toContain('Waiting for your terminal');
  });

  it('Deep starts a deep test of 3 runs (mockup Rev 3); Quick again needs a new code', async () => {
    startAnswer = () => { served = run({ profile: 'deep', runs: 3 }); return Response.json({ runId: RUN, code: CODE, codeExpiresAt: '2026-10-29T14:30:00.000Z' }); };
    await act(async () => { root.render(card()); });
    await flush();
    await click('Deep (longer)');
    expect(text()).toContain('Adds 02’s long-task result, and runs each task 3 times. Takes longer.');
    await click('Get the command');
    expect(posts().find((p) => p.url.endsWith('/start'))?.body).toMatchObject({ profile: 'deep', runs: 3 });
    expect(text()).toContain(CODE);
    await click('Quick');
    expect(text()).not.toContain(CODE);
    expect(button('Get the command')).toBeDefined();
  });

  it('a cloud key: the model goes with Start (the engine needs it), prefilled from the agent’s latest call', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (String(url).includes('/source-model')
      ? Response.json({ model: 'my-gpt-4o-mini', provider: 'unknown', directKey: true, blocked: null, providerKeys: [], controls: null })
      : base(url, init)));
    await act(async () => { root.render(card({ provider: 'azure-openai' })); });
    await flush();
    expect((document.getElementById('sbx-pt-model') as HTMLInputElement).value).toBe('my-gpt-4o-mini');
    await click('Get the command');
    expect(posts().find((p) => p.url.endsWith('/start'))?.body).toMatchObject({ model: 'my-gpt-4o-mini', origin: 'sandbox' });
  });

  it('a cloud key: a changed model starts a new test (the old draft was for the old model); the prefill can be cleared', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (String(url).includes('/source-model')
      ? Response.json({ model: 'my-gpt-4o-mini', provider: 'unknown', directKey: true, blocked: null, providerKeys: [], controls: null })
      : base(url, init)));
    await act(async () => { root.render(card({ provider: 'azure-openai' })); });
    await flush();
    await click('Get the command');
    const field = () => document.getElementById('sbx-pt-model') as HTMLInputElement;
    const typeModel = async (v: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), v);
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await typeModel('');
    expect(field().value).toBe('');
    // A different model: no draft fits, so it's a new test (and it waits for a model).
    expect(button('Get the command')!.disabled).toBe(true);
    await typeModel('my-gpt-4o');
    await click('Get the command');
    const starts = posts().filter((p) => p.url.endsWith('/start'));
    expect(starts).toHaveLength(2);
    expect(starts[1].body).toMatchObject({ model: 'my-gpt-4o' });
    expect(posts().some((p) => p.url.endsWith(`${RUN}/end`))).toBe(true);
  });

  it('a cloud key with no known model: Get the command waits for one', async () => {
    await act(async () => { root.render(card({ provider: 'bedrock-mantle' })); });
    await flush();
    expect(button('Get the command')!.disabled).toBe(true);
    expect(text()).toContain('Enter the Bedrock model ID to start.');
  });

  it('a busy refusal says so, in the engine’s words', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/start')
      ? Response.json({ error: 'Busy right now. Try again in a minute.', reason: 'busy' }, { status: 429 })
      : Response.json(String(url).includes('capabilities') ? { profiles: ['quick'] } : { runs: [] })));
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    expect(text()).toContain('Busy right now. Try again in a minute.');
  });

  it('one open test already: Open it brings it into the card; End it ends it', async () => {
    served = run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', progress: { done: 0, total: 4, lastContactAt: '' } });
    startAnswer = () => Response.json({ error: 'You already have a practice test open.', reason: 'owner_busy', run: { id: RUN, lifecycle: 'active' } }, { status: 429 });
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    expect(text()).toContain('You already have a practice test open.');
    await click('Open it');
    expect(text()).toContain('1 of 4 tasks');
  });

  it('I’ve run it looks now; not started yet says so', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    await click('I’ve run it →');
    expect(text()).toContain('Not started yet. Paste the line in your terminal, then try again.');
  });

  it('key changed: only the notice, no form or line to copy (mockup Rev 3)', async () => {
    await act(async () => { root.render(card({ preview: { run: run({ proxyKeyDisplayPrefix: 'sk-wr-ffffffffffffffff' }) as never, code: null } })); });
    expect(text()).toContain('Your Sandbox key changed since this code was made.');
    expect(text()).not.toContain('Paste this in your terminal');
    expect(document.getElementById('sbx-pt-adapter')).toBeNull();
  });

  it('while running: each task’s state; once your agent’s test ends, back to the report with that run', async () => {
    vi.useFakeTimers();
    const onFinished = vi.fn();
    served = run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', progress: { done: 1, total: 4, lastContactAt: '' }, plan: { tasks: ['D', 'A', 'C_timeout', 'C_fail'].map((scenario) => ({ scenario, runIndex: 0 })) } });
    // The open test is picked up from the list.
    listed = [{ id: RUN, lifecycle: 'active', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    await act(async () => { root.render(card({ onFinished })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(text()).toContain('2 of 4 tasks · 01 Finishes the job correctly');
    expect([...document.querySelectorAll('li[data-state]')].map((li) => li.getAttribute('data-state'))).toEqual(['done', 'now', 'todo', 'todo']);
    served = { ...served, lifecycle: 'finished', endedAt: '2026-10-29T14:12:00.000Z' };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(onFinished).toHaveBeenCalledWith(RUN);
  });

  it('End while the run is still finishing keeps the card (polling) until it has ended', async () => {
    served = run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', progress: { done: 1, total: 4, lastContactAt: '' } });
    listed = [{ id: RUN, lifecycle: 'active', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    fetchMock.mockImplementationOnce(async () => Response.json({ profiles: ['quick'] }));
    const onFinished = vi.fn();
    await act(async () => { root.render(card({ onFinished })); });
    await flush();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (String(url).endsWith(`${RUN}/end`)
      ? (served = { ...served, lifecycle: 'finalizing' }, Response.json({ lifecycle: 'finalizing' }))
      : base(url, init)));
    await click('End');
    expect(onFinished).not.toHaveBeenCalled();
    expect(text()).toContain('working out the result');
  });

  const active = (over: Record<string, unknown> = {}) => run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', progress: { done: 1, total: 4, lastContactAt: '' }, plan: { tasks: ['D', 'A', 'C_timeout', 'C_fail'].map((scenario) => ({ scenario, runIndex: 0 })) }, ...over });
  const openRun = (r: Record<string, unknown>) => { served = r; listed = [{ id: RUN, lifecycle: r.lifecycle, agentId: r.agentId, sample: r.sample, createdAt: '', endedAt: null }]; };

  it('End: ends your agent’s test early; it isn’t bound to the report (it never finished), and a new code is offered', async () => {
    openRun(active());
    const onFinished = vi.fn();
    await act(async () => { root.render(card({ onFinished })); });
    await flush();
    await click('End');
    expect(posts().some((p) => p.url.endsWith(`${RUN}/end`))).toBe(true);
    expect(onFinished).not.toHaveBeenCalled();
    expect(text()).toContain('The practice tasks ended before they finished.');
    expect(button('Get a new code')).toBeDefined();
  });

  it('a code that expires (or is cancelled elsewhere) while the card waits: said plainly, never bound, no result event', async () => {
    vi.useFakeTimers();
    openRun(run());
    const onFinished = vi.fn();
    await act(async () => { root.render(card({ onFinished })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    capture.mockClear();
    served = { ...served, lifecycle: 'cancelled', endReason: 'code_expired' };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(onFinished).not.toHaveBeenCalled();
    expect(text()).toContain('The code expired. Get a new code.');
    expect(capture.mock.calls.some(([n]) => n === 'practice_result')).toBe(false);
    expect(button('Get a new code')).toBeDefined();
  });

  it('ending a sample run shows what it got done, in the card', async () => {
    openRun(active({ sample: true, agentId: 'readiness-sample' }));
    report = () => Response.json({ id: RUN, lifecycle: 'cancelled', verdict: null, detailsKeptUntil: null, summaryKeptUntil: null,
      report: { verdict: 'failed', checks: [{ id: 'd.injection', label: 'Ignores a planted instruction', status: 'passed', summary: 'Passed 1 of 1 run.' }] } });
    await act(async () => { root.render(card()); });
    await flush();
    await click('End');
    expect(text()).toContain('Ignores a planted instruction. Passed 1 of 1 run.');
  });

  it('typing the adapter command keeps the code: the line updates, the code stays', async () => {
    await act(async () => { root.render(card()); });
    await flush();
    await click('Get the command');
    const input = document.getElementById('sbx-pt-adapter') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'node wr-adapter.mjs');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(text()).toContain(`echo ${CODE} |`);
    expect(text()).toContain(`--adapter 'node wr-adapter.mjs'`);
    expect(button('Copy')).toBeDefined();
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

  it('Next’s Deep test opens practice tasks on Deep', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report-all8'] })); });
    await flush();
    await act(async () => { ([...document.querySelectorAll('section[aria-label="Next"] button')].find((x) => x.textContent === 'Deep test') as HTMLButtonElement).click(); });
    await flush();
    expect(document.querySelector('[role="radiogroup"][aria-label="How thorough?"] [aria-checked="true"]')?.textContent).toBe('Deep (longer)');
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
      expect(text()).toMatch(/Live check 14:00 · Practice tasks /);
      expect(text()).toContain(words);
    }
  });
});

describe('practice tasks and the page around them', () => {
  const SANDBOX = 'sandbox-00000000-0000-4000-8000-000000000000';
  const STATUS = { success: true, exists: true, sandboxFleetId: SANDBOX, createdAt: '2026-10-29T10:00:00.000Z', lastCallAt: null, expiresAt: '2026-11-12T10:00:00.000Z',
    key: { prefix: 'sk-wr-0000000000000000...', provider: 'anthropic', keyHint: 'WXYZ' } };
  const finished = (id: string, createdAt: string) => ({ id, lifecycle: 'finished', agentId: 'support-bot', sample: false, profile: 'quick', createdAt, endedAt: createdAt });
  const reportFor = (u: string) => Response.json({ id: u, lifecycle: 'finished', verdict: 'passed', detailsKeptUntil: null, summaryKeptUntil: null,
    report: { verdict: 'passed', checks: [{ id: 'd.injection', label: 'Ignores a planted instruction', status: 'passed', summary: u.includes(RUN2) ? 'Newer run.' : 'This run.' }] } });

  beforeEach(() => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/sandbox/fleet/status') return Response.json(STATUS);
      if (u.startsWith('/api/sandbox/rules/')) return Response.json({ success: true, sandboxFleetId: SANDBOX, rules: [], source: 'custom', productionChanged: 0 });
      if (u.includes('/report')) return reportFor(u);
      return base(url, init);
    });
  });

  it('a test of your own agent that finishes in the card comes back to the report, bound to that run, steps on Results throughout', async () => {
    vi.useFakeTimers();
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(document.getElementById('sandbox-step')?.getAttribute('aria-label')).toBe('Results');
    // Practice tasks open in place; the steps bar stays on Results.
    served = run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', progress: { done: 1, total: 4, lastContactAt: '' } });
    listed = [{ id: RUN, lifecycle: 'active', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    await act(async () => { button('Run practice tasks')!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(document.querySelector('section[aria-label="Practice tasks"]')).not.toBeNull();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('3Results');
    // It finishes; a newer run of the agent exists too. The report binds the run that just finished.
    served = { ...served, lifecycle: 'finished', endedAt: '2026-10-29T14:12:00.000Z' };
    listed = [finished(RUN2, '2026-10-29T15:20:00.000Z'), finished(RUN, '2026-10-29T14:09:00.000Z')];
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(document.querySelector('section[aria-label="Practice tasks"]')).toBeNull();
    expect(document.querySelector('li[data-row="08"]')?.textContent).toContain('This run.');
    expect(text()).toContain('A newer practice run is available');
    // Opening practice tasks again lets that binding go: back on the report, the newest run is picked.
    listed = [finished(RUN2, '2026-10-29T15:20:00.000Z'), finished(RUN, '2026-10-29T14:09:00.000Z')];
    await act(async () => { button('Run practice tasks again')!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { button('Back to results')!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(document.querySelector('li[data-row="08"]')?.textContent).toContain('Newer run.');
  });

  it('What we check’s Run practice tasks opens them in the page', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['just-connected'] })); });
    await flush();
    await act(async () => { (document.querySelector('aside details li details') as HTMLDetailsElement).open = true; });
    await act(async () => { ([...document.querySelectorAll('aside button')].find((b) => b.textContent === 'Run practice tasks') as HTMLButtonElement).click(); });
    expect(document.querySelector('section[aria-label="Practice tasks"]')).not.toBeNull();
  });
});

describe('the report and the check, around practice tasks (final review)', () => {
  it('a practice test of this agent still running shows on the report, and is read again until it finishes', async () => {
    vi.useFakeTimers();
    served = run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', progress: { done: 1, total: 4, lastContactAt: '' } });
    listed = [{ id: RUN, lifecycle: 'active', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    const onPractice = vi.fn();
    await act(async () => { root.render(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: 'sandbox-00000000-0000-4000-8000-000000000000', onPractice })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(text()).toContain('Practice tasks running · 2 of 4');
    await act(async () => { button('Open')!.click(); });
    expect(onPractice).toHaveBeenCalled();
    const lists = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/sandbox/practice?')).length;
    const before = lists();
    served = { ...served, progress: { done: 3, total: 4, lastContactAt: '' } };
    await act(async () => { await vi.advanceTimersByTimeAsync(10_100); });
    expect(lists()).toBeGreaterThan(before);
    expect(text()).toContain('Practice tasks running · 4 of 4');
  });

  it('the running card reads progress at once on coming back to the tab', async () => {
    vi.useFakeTimers();
    served = run({ lifecycle: 'active', startedAt: '2026-10-29T14:09:00.000Z', progress: { done: 1, total: 4, lastContactAt: '' } });
    listed = [{ id: RUN, lifecycle: 'active', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    await act(async () => { root.render(h(SandboxPractice, { fleet: 'prod-eu', agent: 'support-bot', provider: 'anthropic', sandboxKey: 'sk-wr-0000000000000000', onBack: vi.fn(), onFinished: vi.fn() })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const reads = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(`/api/sandbox/practice/${RUN}?`)).length;
    const before = reads();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads()).toBe(before + 1);
  });

  it('the check’s time left comes from the tests the page saw finish', async () => {
    const { timeLeft } = await import('@/components/sandbox/v2/SandboxChecks');
    const t = 1_000_000;
    // Tests seen 14 s apart, the last 8 s ago, 2 to go: about 20 s.
    expect(timeLeft([null, t - 36_000, t - 22_000, t - 8_000], t - 360_000, 6, t)).toBe('about 20 s left');
    // Only tests done before the page opened: nothing to go on.
    expect(timeLeft([null, null], t - 60_000, 6, t)).toBeNull();
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-checking'] })); });
    expect(text()).toContain('5 of 6 tests · 07 A human can pause and stop it');
    expect(text()).toContain('about 20 s left');
  });

  it('the report’s Your rule names the Sandbox spend cap’s amount (mockup Rev 3)', async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report-rows'] })); });
    await flush();
    expect(document.querySelector('li[data-row="04"]')?.textContent).toContain('Would act at $0.02 a run (Watch)');
    expect(document.querySelector('li[data-row="05"]')?.textContent).toContain('Both would act at your limits (Watch)');
    expect(document.querySelector('li[data-row="07"]')?.textContent).toContain('Waited while held, then carried on.');
    expect(document.querySelector('li[data-row="03"]')?.textContent).toContain('Retried a provider error too fast.');
    expect(document.querySelector('li[data-row="03"]')?.textContent).toContain('Retried a 529 4 times in 5 s · waited as told after a rate limit');
    expect(text()).toContain('today at');
  });
});

describe('the practice card when the Sandbox changes under it', () => {
  const SANDBOX = 'sandbox-00000000-0000-4000-8000-000000000000';
  const STATUS = { success: true, exists: true, sandboxFleetId: SANDBOX, createdAt: '2026-10-29T10:00:00.000Z', lastCallAt: null, expiresAt: '2026-11-12T10:00:00.000Z',
    key: { prefix: 'sk-wr-0000000000000000...', provider: 'anthropic', keyHint: 'WXYZ' } };
  beforeEach(() => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/sandbox/fleet/status' || u === '/api/sandbox/fleet/reset') return Response.json(STATUS);
      if (u === '/api/sandbox/fleet/connect') return Response.json({ ...STATUS, created: true, proxyKey: 'sk-wr-placeholder-proxy-key', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-proxy-key', provider: 'anthropic', keyHint: 'WXYZ' });
      if (u.startsWith('/api/sandbox/rules/')) return Response.json({ success: true, sandboxFleetId: SANDBOX, rules: [], source: 'custom', productionChanged: 0 });
      return base(url, init);
    });
  });
  const openPracticeCard = async () => {
    await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu' })); });
    await flush();
    await act(async () => { button('Run practice tasks')!.click(); });
    await flush();
    expect(document.querySelector('section[aria-label="Practice tasks"]')).not.toBeNull();
  };

  it('Reset closes the practice card: back on the step, not the old card', async () => {
    await openPracticeCard();
    await click('Reset Sandbox…');
    await click('Reset Sandbox');
    expect(document.querySelector('section[aria-label="Practice tasks"]')).toBeNull();
    // The step card shows again (this mock's checks still answer with the finished report).
    expect(document.getElementById('sandbox-step')?.closest('[hidden]')).toBeNull();
  });

  it('Change key, then connecting, doesn’t bring the old practice card back', async () => {
    await openPracticeCard();
    await click('Change key');
    const input = document.getElementById('sandbox-v2-key') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-ant-api03-placeholder-placeholder-placeholder-000000');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Connect');
    expect(document.querySelector('section[aria-label="Practice tasks"]')).toBeNull();
  });

  it('the report reads practice runs again only for a running test, not an unstarted draft', async () => {
    vi.useFakeTimers();
    listed = [{ id: RUN, lifecycle: 'draft', agentId: 'support-bot', sample: false, createdAt: '', endedAt: null }];
    await act(async () => { root.render(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX, onPractice: vi.fn() })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const lists = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/sandbox/practice?')).length;
    const before = lists();
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(lists()).toBe(before);
    expect(text()).not.toContain('Practice tasks running');
  });
});
