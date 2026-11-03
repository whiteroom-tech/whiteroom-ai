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
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const { otherRunLine, practiceCommand, practiceRefusal, practiceTaskLines, shellQuote } = await import('@/lib/sandbox/sandbox-practice');
const { PracticeError } = await import('@/lib/sandbox/practice/api');
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
const fetchMock = vi.fn();
const posts = () => fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST').map(([u, i]) => ({ url: String(u), body: JSON.parse(String((i as RequestInit).body)) }));

beforeEach(() => {
  served = run();
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/sandbox/practice/capabilities')) return Response.json({ profiles: ['quick', 'deep'] });
    if (u.startsWith('/api/sandbox/practice/start')) return Response.json({ runId: RUN, code: CODE, codeExpiresAt: '2026-10-29T14:30:00.000Z' });
    if (u.startsWith(`/api/sandbox/practice/${RUN}/end`)) { served = { ...served, lifecycle: 'cancelled' }; return Response.json({ lifecycle: 'cancelled' }); }
    if (u.startsWith(`/api/sandbox/practice/${RUN}`)) return Response.json(served);
    if (u.startsWith('/api/sandbox/practice?') || u.startsWith('/api/sandbox/practice/runs')) return Response.json({ runs: [] });
    if (init?.method === 'POST') return Response.json({ success: true });
    return Response.json({ runs: [] });
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
    fetchMock.mockImplementationOnce(async () => Response.json({ profiles: ['quick', 'deep'] }));
    await act(async () => { root.render(card({ preview: { run: served as never, code: null } })); });
    expect(text()).toContain('Your Sandbox key changed since this code was made.');
    expect(button('Get a new code')).toBeDefined();
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
});
