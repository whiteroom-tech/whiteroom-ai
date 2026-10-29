// @vitest-environment happy-dom
// Sandbox checks and Run agent on /sandbox (components/sandbox/v2): the live
// checklist per status, Resume only while the check has the agent stopped,
// polling that stops when the window ends, the report, the helper code shown
// once, Run agent's request ID, the hourly limit, the forgotten-agent notice,
// the preview states, and no link to Controls. Placeholder keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SandboxChecks, RUN_NOW } = await import('@/components/sandbox/v2/SandboxChecks');
const { SandboxHelper } = await import('@/components/sandbox/v2/SandboxHelper');
const { SandboxHome } = await import('@/components/sandbox/v2/SandboxHome');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const { CHECK_IDS, stageLine, checkStateOf } = await import('@/lib/sandbox/checks');
const { LISTEN_COMMAND } = await import('@/lib/sandbox/helper');
const { CLI_VERSION } = await import('@/lib/sandbox/practice/model');
const { outsideWindowText } = await import('@/lib/sandbox/fleet');

const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
type Win = { stage: string; endedAt?: string | null; calls?: number } | null;
const checkAnswer = (win: Win, statuses: Record<string, string> = {}, rules: unknown[] = []) => ({
  success: true,
  window: win && { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', endedAt: null, injectErrors: true, calls: 4, ...win },
  checks: CHECK_IDS.map((id) => ({ id, label: `Label ${id}`, status: statuses[id] ?? 'pending', detail: statuses[id] ? `Detail ${id}` : '' })),
  rules,
});
const HELPER_OFF = { success: true, connected: false, queued: 0, recent: [], code: null, tasksThisHour: 0, tasksPerHour: 30 };
const HELPER_ON = { ...HELPER_OFF, connected: true, host: 'dev-laptop.local', tasksThisHour: 2 };

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
let root: Root;
const text = () => document.body.textContent ?? '';
const button = (name: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === name && !b.closest('dialog:not([open])')).pop() as HTMLButtonElement | undefined;
const click = async (name: string) => { await act(async () => { button(name)!.click(); }); await flush(); };
const render = async (el: ReturnType<typeof h>) => { await act(async () => { root.render(el); }); await flush(); };
const typeIn = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const bff = vi.fn();
const calls = () => bff.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));
let checks: unknown;
let helper: unknown;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  checks = checkAnswer(null);
  helper = HELPER_OFF;
  bff.mockReset().mockImplementation(async (url: string) => {
    if (url.startsWith('/api/sandbox/checks/')) return Response.json(checks);
    if (url === '/api/sandbox/helper/code') return Response.json({ success: true, code: 'ABCD-1234', codeExpiresAt: '2026-10-29T10:10:00.000Z' });
    if (url === '/api/sandbox/helper/run') return Response.json({ success: true, taskId: 'task_1', duplicate: false });
    if (url.startsWith('/api/sandbox/helper/')) return Response.json(helper);
    return Response.json({ error: 'unexpected' }, { status: 500 });
  });
  vi.stubGlobal('fetch', bff);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); });

const checksEl = () => h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
const row = (id: string) => document.querySelector(`[data-check="${id}"]`);

describe('Check your agent', () => {
  it('no check yet: Start checking sends the provider-error toggle, on by default', async () => {
    await render(checksEl());
    expect(text()).toContain('Test how my agent handles provider errors');
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    checks = checkAnswer({ stage: 'observe', calls: 0 });
    await click('Start checking');
    expect(calls().find((c) => c.url.endsWith('/checks/start'))?.body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, injectErrors: true });
    expect(text()).toContain('Watching your agent’s calls…');
    expect(text()).toContain(RUN_NOW);
  });

  it('turning the toggle off sends injectErrors: false', async () => {
    await render(checksEl());
    await act(async () => { (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    await click('Start checking');
    expect(calls().find((c) => c.url.endsWith('/checks/start'))?.body.injectErrors).toBe(false);
  });

  it('renders each check with its status and detail, and the rules under it', async () => {
    checks = checkAnswer({ stage: 'enforce' }, { spend_cap: 'passed', loop_rate: 'not_triggered', long_task: 'failed', finishes_correctly: 'not_checked' }, [
      { ruleId: 'gr_1', ruleType: 'spend_cap', check: 'spend_cap', wouldAct: true, acted: true, status: 'passed', detail: 'Blocked at $0.02.' },
    ]);
    await render(checksEl());
    expect(document.querySelectorAll('[data-check]')).toHaveLength(7);
    expect(row('spend_cap')?.textContent).toContain('Passed · Detail spend_cap');
    expect(row('loop_rate')?.textContent).toContain('Not triggered by this run');
    expect(row('long_task')?.textContent).toContain('Failed');
    expect(row('finishes_correctly')?.textContent).toContain('Not checked');
    expect(row('pause_stop')?.textContent).toContain('Checking…');
    expect(row('spend_cap')?.querySelector('details')?.textContent).toContain('Spend cap · Passed');
    expect(row('spend_cap')?.textContent).toContain('Blocked at $0.02.');
    // The enforce stage names the first rule still to test, in order: spend cap, then allowlists and keywords.
    expect(text()).toContain('Testing Label allowlists_keywords…');
    expect(button('Resume')).toBeUndefined();
    expect(button('Stop checking')).toBeDefined();
  });

  it('Resume shows only while the check has the agent stopped, and sends resume', async () => {
    for (const stage of ['observe', 'enforce', 'pause', 'errors', 'done']) {
      expect(stageLine(checkStateOf(checkAnswer({ stage }))!)).not.toContain('Press Resume');
    }
    checks = checkAnswer({ stage: 'pause' });
    await render(checksEl());
    expect(text()).toContain('Paused your agent for 10 seconds…');
    expect(button('Resume')).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    checks = checkAnswer({ stage: 'stop' });
    await render(checksEl());
    expect(text()).toContain('Your agent is stopped. Press Resume to show a person can bring it back.');
    checks = checkAnswer({ stage: 'errors' }, { pause_stop: 'passed' });
    await click('Resume');
    expect(calls().find((c) => c.url.endsWith('/checks/resume'))?.body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(text()).toContain('Sending a provider error…');
    expect(button('Resume')).toBeUndefined();
  });

  it('polls every 5 seconds while the window is open, and stops when it ends', async () => {
    vi.useFakeTimers();
    checks = checkAnswer({ stage: 'observe' });
    await render(checksEl());
    const reads = () => calls().filter((c) => c.url.endsWith('/checks/status')).length;
    expect(reads()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(reads()).toBe(2);
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z' }, { spend_cap: 'passed', pause_stop: 'passed', loop_rate: 'not_triggered' });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(reads()).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await flush();
    expect(reads()).toBe(3);
    // The report: N of 7 passed, a check never reached reads Not checked, and Check again.
    expect(text()).toContain('2 of 7 passed');
    expect(row('long_task')?.textContent).toContain('Not checked');
    expect(button('Check again')).toBeDefined();
    expect(button('Stop checking')).toBeUndefined();
  });

  it('Stop checking ends the window and shows the report', async () => {
    checks = checkAnswer({ stage: 'observe' });
    await render(checksEl());
    checks = checkAnswer({ stage: 'observe', endedAt: '2026-10-29T10:06:00.000Z' }, { long_task: 'passed' });
    await click('Stop checking');
    expect(calls().some((c) => c.url.endsWith('/checks/stop'))).toBe(true);
    expect(text()).toContain('1 of 7 passed');
  });

  it('a refused Start shows why and reads the checks again', async () => {
    await render(checksEl());
    bff.mockImplementationOnce(async () => Response.json({ error: 'A check is already running.' }, { status: 409 }));
    await click('Start checking');
    expect(text()).toContain('A check is already running.');
    expect(calls().filter((c) => c.url.endsWith('/checks/status')).length).toBe(2);
  });
});

describe('Run agent', () => {
  const helperEl = () => h(SandboxHelper, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });

  it('not connected: the listen command at the CLI version, and the helper code shown once', async () => {
    await render(helperEl());
    expect(LISTEN_COMMAND).toBe(`npx @whiteroom-ai/cli@${CLI_VERSION} sandbox listen --adapter "<your agent command>"`);
    expect(text()).toContain(LISTEN_COMMAND);
    expect(text()).not.toContain('ABCD-1234');
    await click('Get a helper code');
    expect(text()).toContain('ABCD-1234');
    expect(text()).toContain('shown only once');
    // A fresh page never shows it again: the status has only the code's expiry.
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    helper = { ...HELPER_OFF, code: { expiresAt: '2026-10-29T10:10:00.000Z', triesLeft: 3 } };
    await render(helperEl());
    expect(text()).not.toContain('ABCD-1234');
    expect(text()).toContain('A code is waiting to be used.');
    expect(button('Get a new code')).toBeDefined();
  });

  it('connected: sends the prompt with a request ID, reused on a retry of the same click and new for the next one', async () => {
    helper = HELPER_ON;
    await render(helperEl());
    expect(text()).toContain('Helper connected · dev-laptop.local');
    expect(text()).toContain('2 of 30 tasks this hour');
    await typeIn(document.getElementById('sandbox-v2-prompt') as HTMLTextAreaElement, 'Summarize tickets');
    bff.mockImplementationOnce(async () => { throw new TypeError('network'); });
    await click('Run agent');
    expect(text()).toContain('Couldn’t reach WhiteRoom');
    await click('Run agent');
    expect(text()).toContain('Sent to your helper.');
    const runs = bff.mock.calls.filter(([url]) => url === '/api/sandbox/helper/run').map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, prompt: 'Summarize tickets', requestId: runs[0].requestId });
    expect(runs[1].requestId).toBe(runs[0].requestId);
    await click('Run agent');
    const third = calls().filter((c) => c.url === '/api/sandbox/helper/run')[2];
    expect(third.body.requestId).not.toBe(runs[0].requestId);
  });

  it('a duplicate says it was already sent', async () => {
    helper = HELPER_ON;
    await render(helperEl());
    await typeIn(document.getElementById('sandbox-v2-prompt') as HTMLTextAreaElement, 'Go');
    bff.mockImplementationOnce(async () => Response.json({ success: true, taskId: 'task_1', duplicate: true }));
    await click('Run agent');
    expect(text()).toContain('Already sent.');
  });

  it('the hourly limit (429) and a full queue say so in plain words', async () => {
    helper = HELPER_ON;
    await render(helperEl());
    await typeIn(document.getElementById('sandbox-v2-prompt') as HTMLTextAreaElement, 'Go');
    bff.mockImplementationOnce(async () => Response.json({ error: 'rate', reason: 'tasks_per_hour', retryAfter: 700 }, { status: 429 }));
    await click('Run agent');
    expect(text()).toContain('That’s the limit for this hour. Try again in 12 min.');
    bff.mockImplementationOnce(async () => Response.json({ error: 'full', reason: 'queue_full', retryAfter: 30 }, { status: 429 }));
    await click('Run agent');
    expect(text()).toContain('Your helper already has tasks waiting.');
  });

  it('recent tasks show their result, and Disconnect sends disconnect', async () => {
    helper = { ...HELPER_ON, recent: [{ id: 't1', promptPreview: 'Draft a reply', ok: false, summary: 'Exited with code 1.', finishedAt: '2026-10-29T10:00:00.000Z' }] };
    await render(helperEl());
    expect(text()).toContain('Draft a reply');
    expect(text()).toContain('Failed');
    expect(text()).toContain('Exited with code 1.');
    helper = HELPER_OFF;
    await click('Disconnect');
    expect(calls().some((c) => c.url === '/api/sandbox/helper/disconnect')).toBe(true);
    expect(text()).toContain('Get a helper code');
  });
});

describe('Sandbox page', () => {
  const STATUS = {
    success: true, exists: true, sandboxFleetId: SANDBOX_ID, createdAt: '2026-10-29T10:00:00.000Z', lastCallAt: null, expiresAt: '2026-11-12T10:00:00.000Z',
    key: { prefix: 'sk-wr-0123456789abcdef...', provider: 'anthropic', keyHint: 'WXYZ' },
  };

  it('the forgotten-agent notice shows only when the agent called outside a check', async () => {
    expect(outsideWindowText({ ...STATUS, callsOutsideWindow24h: 0 })).toBeNull();
    expect(outsideWindowText({ ...STATUS, callsOutsideWindow24h: 1 })).toContain('called the Sandbox once outside a check');
    bff.mockImplementation(async (url: string) => {
      if (url === '/api/sandbox/fleet/status') return Response.json({ ...STATUS, callsOutsideWindow24h: 42, lastCallOutsideWindowAt: '2026-10-29T10:00:00.000Z' });
      if (url.startsWith('/api/sandbox/checks/')) return Response.json(checkAnswer(null));
      if (url.startsWith('/api/sandbox/helper/')) return Response.json(HELPER_OFF);
      if (url.startsWith('/api/sandbox/rules/')) return Response.json({ success: true, sandboxFleetId: SANDBOX_ID, rules: [], source: 'custom', productionChanged: 0 });
      return Response.json({ fleetId: 'prod-eu', rules: [], history: [], agents: [] });
    });
    await render(h(SandboxHome, { fleet: 'prod-eu' }));
    expect(text()).toContain('Your agent called the Sandbox 42 times outside a check in the last day. Sandbox rules only watch then, so nothing was blocked.');
    expect(text()).toContain('4. Check your agent');
    expect(text()).toContain('Run agent');
    expect(document.body.innerHTML).not.toContain('href="/controls');
  });

  it.each(Object.keys(SANDBOX_V2_STATES).filter((k) => k.startsWith('checks-') || k.startsWith('helper-') || k === 'outside-window') as (keyof typeof SANDBOX_V2_STATES)[])(
    '/dev/sandbox-v2 %s renders without fetching or linking to Controls',
    async (state) => {
      await render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES[state] }));
      expect(bff).not.toHaveBeenCalled();
      expect(text()).toContain('4. Check your agent');
      expect(document.body.innerHTML).not.toContain('href="/controls');
      if (state === 'checks-stopped') expect(button('Resume')).toBeDefined();
      else expect(button('Resume')).toBeUndefined();
    },
  );
});
