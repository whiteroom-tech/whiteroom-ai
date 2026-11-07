// @vitest-environment happy-dom
// Sandbox checks and Run agent on /sandbox (components/sandbox/v2): the live
// checklist per status, no Resume (the check lifts its own stop), the report event,
// polling that stops when the window ends, the report, the helper code shown
// once, Run agent's request ID, the hourly limit, the forgotten-agent notice,
// the preview states, and no link to Controls. Placeholder keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics', () => ({ analytics: { capture } }));

const { IDLE_HELP_MS, SandboxChecks } = await import('@/components/sandbox/v2/SandboxChecks');
const { SandboxHelper } = await import('@/components/sandbox/v2/SandboxHelper');
const { SandboxHome } = await import('@/components/sandbox/v2/SandboxHome');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const { CHECK_IDS, QUIET_MS, SANDBOX_CHECKS_ACTIONS, activityLine, currentCheckOf, isQuiet, stageLine, checkStateOf } = await import('@/lib/sandbox/checks');
const { LISTEN_COMMAND } = await import('@/lib/sandbox/helper');
const { CLI_VERSION } = await import('@/lib/sandbox/practice/model');
const { outsideWindowText } = await import('@/lib/sandbox/fleet');

const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
type Win = { id?: string; stage: string; endedAt?: string | null; calls?: number; agentId?: string; otherAgents?: string[] } | null;
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
// The Sandbox's own calls (all POSTs); the report's best-effort read of practice runs is a GET and isn't one of them.
const calls = () => bff.mock.calls.filter(([url]) => !String(url).startsWith('/api/sandbox/practice')).map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));
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
    if (url.startsWith('/api/sandbox/practice')) return Response.json({ runs: [] });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  });
  vi.stubGlobal('fetch', bff);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); });

const checksEl = () => h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
const row = (id: string) => document.querySelector(`[data-check="${id}"]`);
/** A live test on the check's track, and its line among the tests done. */
const seg = (id: string) => document.querySelector(`ol[aria-label="Live tests"] [data-check="${id}"]`);
const doneLine = (id: string) => document.querySelector(`ul[aria-label="Done"] [data-check="${id}"]`);

describe('practice tasks on the report (eight checks C3)', () => {
  const runRow = (id: string, agentId: string, minute: number) => ({ id, agentId, lifecycle: 'finished', profile: 'quick', createdAt: `2026-10-29T10:${String(minute).padStart(2, '0')}:00.000Z`, endedAt: `2026-10-29T10:${String(minute + 3).padStart(2, '0')}:00.000Z` });
  const result = { id: 'r-1', lifecycle: 'finished', verdict: 'passed', detailsKeptUntil: null, summaryKeptUntil: null, report: { checks: [
    { id: 'a.result', label: 'Finishes a job correctly', status: 'passed', summary: 'Passed 1 of 1 run.', fix: null },
    { id: 'd.injection', label: 'Ignores a planted instruction', status: 'passed', summary: 'Passed 1 of 1 run.', fix: null },
  ] } };

  it('binds the agent’s newest finished practice run once and fills its rows; a fresh report binds the newest', async () => {
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z', agentId: 'support-bot' }, { long_task: 'passed' });
    let runs = [runRow('r-1', 'support-bot', 1)];
    const practiceUrls: string[] = [];
    bff.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/sandbox/checks/')) return Response.json(checks);
      if (url.startsWith('/api/sandbox/practice/r-')) { practiceUrls.push(url); return Response.json({ ...result, id: url.split('/')[4] }); }
      if (url.startsWith('/api/sandbox/practice')) { practiceUrls.push(url); return Response.json({ runs }); }
      if (url.startsWith('/api/sandbox/helper/')) return Response.json(helper);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    await act(async () => { root.render(checksEl()); });
    await flush();
    expect(document.querySelector('li[data-row="08"]')?.getAttribute('data-state')).toBe('passed');
    expect(document.querySelector('li[data-row="01"]')?.getAttribute('data-state')).toBe('passed');
    // One list read and one result read: binding doesn't read again by itself.
    expect(practiceUrls).toEqual(['/api/sandbox/practice?fleet=prod-eu', '/api/sandbox/practice/r-1/report?fleet=prod-eu']);
    // A newer run, and the report shown afresh: it binds the newest; "Use it" only offers within one report.
    runs = [runRow('r-2', 'support-bot', 20), runRow('r-1', 'support-bot', 1)];
    act(() => root.unmount());
    const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
    await act(async () => { root.render(checksEl()); });
    await flush();
    expect(text()).not.toContain('A newer practice run is available');
    expect(practiceUrls.at(-1)).toBe('/api/sandbox/practice/r-2/report?fleet=prod-eu');
  });

  it('the report event waits for the practice read, so a bound run is in its counts', async () => {
    checks = checkAnswer({ stage: 'observe', agentId: 'support-bot' });
    bff.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/sandbox/checks/')) return Response.json(checks);
      if (url.startsWith('/api/sandbox/practice/r-')) return Response.json(result);
      if (url.startsWith('/api/sandbox/practice')) return Response.json({ runs: [runRow('r-1', 'support-bot', 1)] });
      if (url.startsWith('/api/sandbox/helper/')) return Response.json(helper);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    await render(checksEl());
    capture.mockClear();
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z', agentId: 'support-bot' }, { long_task: 'passed' });
    await click('Finish now');
    await flush();
    // Rows 01 and 08 are filled by the bound run: none left needing practice tasks.
    expect(capture.mock.calls.filter(([name]) => name === 'sandbox_report_rows')).toEqual([['sandbox_report_rows', expect.objectContaining({ practice: 0 })]]);
  });

  it('a new report for another agent starts with nothing bound, even when reading practice runs then fails', async () => {
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z', agentId: 'support-bot' }, { long_task: 'passed' });
    let failing = false;
    bff.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/sandbox/checks/')) return Response.json(checks);
      if (url.startsWith('/api/sandbox/practice') && failing) return Response.json({ error: 'down' }, { status: 503 });
      if (url.startsWith('/api/sandbox/practice/r-')) return Response.json(result);
      if (url.startsWith('/api/sandbox/practice')) return Response.json({ runs: [runRow('r-1', 'support-bot', 1)] });
      if (url.startsWith('/api/sandbox/helper/')) return Response.json(helper);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    await render(checksEl());
    expect(document.querySelector('li[data-row="08"]')?.getAttribute('data-state')).toBe('passed');
    // Check again lands on a new ended window, for another agent; the practice read fails.
    failing = true;
    checks = checkAnswer({ id: 'chk_2', stage: 'done', endedAt: '2026-10-29T10:20:00.000Z', agentId: 'ops-bot' }, { long_task: 'passed' });
    capture.mockClear();
    await click('Check again');
    expect(document.querySelector('li[data-row="08"]')?.getAttribute('data-state')).toBe('not_run_yet');
    expect(document.querySelector('li[data-row="01"]')?.getAttribute('data-state')).toBe('not_run_yet');
    // The new report's event counts its own rows, never the last report's practice run.
    expect(capture.mock.calls.filter(([name]) => name === 'sandbox_report_rows')).toEqual([['sandbox_report_rows', expect.objectContaining({ practice: 2 })]]);
  });
});

describe('Check your agent', () => {
  it('no check yet: no button; it waits for the first call and picks the check up when one starts', async () => {
    vi.useFakeTimers();
    await render(checksEl());
    expect(text()).toContain('Waiting for your agent’s first call');
    expect(text()).toContain('Run your agent as you normally do. Checks start by themselves.');
    // A status row, not a box that looks like a field; no repeat of "your live agents aren't touched".
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Waiting for your agent’s first call');
    expect(text()).not.toContain('aren’t touched');
    expect(button('Start checking')).toBeUndefined();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    checks = checkAnswer({ stage: 'observe', calls: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(text()).toContain('Watching your agent’s calls…');
    expect(calls().some((c) => c.url.endsWith('/checks/start'))).toBe(false);
  });

  it('a live line says whether the agent is calling and whether this run is checked', () => {
    const now = Date.parse('2026-10-29T20:30:00.000Z');
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    const st = (stage: string | null, ended: boolean, lastCallAt: string | null) => ({
      ...checkStateOf(checkAnswer(stage ? { stage, calls: 12, ...(ended && { endedAt: at(60_000) }) } : null))!,
      activity: { lastCallAt, callsOutsideWindow24h: 0 },
    });
    expect(activityLine(st(null, false, null), now)).toBeNull();
    expect(activityLine(st('observe', false, at(4_000)), now)).toEqual({ calling: true, text: 'Your agent is calling · last call 4 s ago · 12 calls checked' });
    expect(activityLine(st('enforce', false, at(5 * 60_000)), now)).toEqual({ calling: false, text: 'Your agent stopped calling · last call 5 min ago · 12 calls checked. The check carries on when it calls again.' });
    expect(activityLine(st('done', true, at(3_000)), now)?.text).toBe('Your agent is calling the Sandbox · last call 3 s ago. This check has finished; its next run starts a new one.');
    expect(activityLine(st('done', true, at(10 * 60_000)), now)?.text).toBe('Your agent’s last call 10 min ago. A new check starts on its next run.');
    expect(activityLine(st('observe', false, at(59_900)), now)?.text).toContain('last call 59 s ago');
    expect(activityLine(st('enforce', false, at(60_000)), now)?.text).toContain('last call 1 min ago');
    // An older engine sends no activity: no line.
    expect(checkStateOf(checkAnswer({ stage: 'observe' }))!.activity).toBeUndefined();
    // Odd values from the engine are dropped, not shown.
    expect(checkStateOf({ ...checkAnswer({ stage: 'observe' }), activity: { lastCallAt: 'yesterday', callsOutsideWindow24h: -3 } })!.activity).toEqual({ lastCallAt: null, callsOutsideWindow24h: 0 });
    expect(checkStateOf({ ...checkAnswer({ stage: 'observe' }), activity: 'x' })!.activity).toBeUndefined();
  });

  it('shows the live line on the page while the agent calls', async () => {
    checks = { ...checkAnswer({ stage: 'observe', calls: 3 }), activity: { lastCallAt: new Date(Date.now() - 2_000).toISOString(), callsOutsideWindow24h: 0 } };
    await render(checksEl());
    expect(text()).toMatch(/Your agent is calling · last call \d+ s ago · 3 calls checked/);
  });

  it('shows the six live tests in the order the engine runs them, the one now with what it does, and the ones done with their results', async () => {
    checks = checkAnswer({ stage: 'enforce' }, { spend_cap: 'passed', loop_rate: 'not_triggered', long_task: 'failed', finishes_correctly: 'not_checked' }, [
      { ruleId: 'gr_1', ruleType: 'spend_cap', check: 'spend_cap', wouldAct: true, acted: true, status: 'passed', detail: 'Blocked at $0.02.' },
    ]);
    await render(checksEl());
    // Mockup Rev 3 "2 · Checking": a track of the six live tests in the engine's order, labelled with their rows.
    expect([...document.querySelectorAll('ol[aria-label="Live tests"] [data-check]')].map((e) => e.getAttribute('data-check')))
      .toEqual(['long_task', 'spend_cap', 'allowlists_keywords', 'loop_rate', 'pause_stop', 'provider_errors']);
    // Each test's label and result reach screen readers: a list, with the progressbar beside it (its children would be hidden).
    expect([...document.querySelectorAll('ol[aria-label="Live tests"] li')].map((e) => e.textContent))
      .toEqual(['✕02 Long task: Failed', '✓04 Spend: Passed', '06 Allowlists: now', '–05 Loops: Not triggered by this run', '07 Pause, stop: Waiting', '03 Fails gracefully: Waiting']);
    const bar = document.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuetext')).toBe('3 of 6 tests done');
    expect(bar.querySelector('li')).toBeNull();
    // Practice-task rows aren't on the track: 01 and 08 aren't checked here.
    expect(document.querySelector('[data-row]')).toBeNull();
    expect(row('finishes_correctly')).toBeNull();
    // Which test it's on, and the Now box: what this test does and what a good agent does.
    expect(text()).toContain('4 of 6 tests · 06 Allowlists and keyword rules');
    expect(seg('allowlists_keywords')?.getAttribute('data-status')).toBe('now');
    expect(seg('pause_stop')?.getAttribute('data-status')).toBe('pending');
    const nowBox = document.querySelector('[role="status"]')!;
    expect(nowBox.textContent).toContain('Now · 06');
    expect(nowBox.textContent).toContain('Allowlists and keyword rules');
    expect(nowBox.textContent).toContain('A good agent backs off when refused.');
    // The tests done, in the order they ran, with the engine's result.
    expect([...document.querySelectorAll('ul[aria-label="Done"] [data-check]')].map((e) => e.getAttribute('data-check'))).toEqual(['long_task', 'spend_cap', 'loop_rate']);
    expect(doneLine('spend_cap')?.textContent).toContain('04 Spend cap. Passed: Detail spend_cap');
    expect(doneLine('loop_rate')?.textContent).toContain('Not triggered by this run');
    expect(doneLine('long_task')?.textContent).toContain('Failed');
    // The enforce stage names the first rule still to test, in order: spend cap, then allowlists and keywords.
    expect(text()).toContain('Testing Label allowlists_keywords…');
    expect(button('Resume')).toBeUndefined();
    expect(button('Finish now')).toBeDefined();
  });

  it('shows the test block after the tests done when the check uses one, and names other agents as not checked', async () => {
    checks = { ...checkAnswer({ stage: 'enforce', otherAgents: ['billing-agent'] }, { long_task: 'passed' }), parts: [{ id: 'test_block', status: 'pending', detail: '' }] };
    await render(checksEl());
    const inOrder = [...document.querySelectorAll('ul[aria-label="Done"] [data-check], [data-check="test_block"]')].map((e) => e.getAttribute('data-check'));
    expect(inOrder).toEqual(['long_task', 'test_block']);
    expect(row('test_block')?.textContent).toContain('Sandbox check: a test block from WhiteRoom. Your rules didn’t change.');
    expect(row('test_block')?.textContent).toContain('Up next');
    expect(text()).toContain('Also called during this check: billing-agent (not checked).');
  });

  it('a not-proven row in the report: an amber ? and the engine\u2019s Not proven line', async () => {
    const answer = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z', agentId: 'support-bot' }, { long_task: 'passed', pause_stop: 'not_checked' });
    const ps = answer.checks.find((c) => c.id === 'pause_stop')!;
    Object.assign(ps, { notProven: true, detail: 'Not proven: we stopped your agent and let it go, then your agent made no new calls, so we can’t tell if it carried on or crashed. Run a longer task to check this.' });
    checks = answer;
    await render(checksEl());
    const r07 = document.querySelector('li[data-row="07"]');
    expect(r07?.getAttribute('data-state')).toBe('not_proven');
    expect(r07?.querySelector('[aria-hidden="true"]')?.textContent).toBe('?');
    expect(r07?.textContent).toContain('we stopped your agent and let it go, then your agent made no new calls');
  });

  it('a decided test block shows its result and detail', async () => {
    checks = { ...checkAnswer({ stage: 'pause' }, { long_task: 'passed' }), parts: [{ id: 'test_block', status: 'passed', detail: 'We blocked a call → it didn’t retry that call.' }] };
    await render(checksEl());
    expect(row('test_block')?.getAttribute('data-status')).toBe('passed');
    expect(row('test_block')?.textContent).toContain('Passed · We blocked a call → it didn’t retry that call.');
  });

  it('no test block, no other agents: neither line shows', async () => {
    checks = checkAnswer({ stage: 'observe' });
    await render(checksEl());
    expect(row('test_block')).toBeNull();
    expect(text()).not.toContain('Also called during this check');
  });

  it('currentCheckOf: the check each stage tests, while it is still pending', () => {
    const st = (stage: string, statuses: Record<string, string> = {}) => checkStateOf(checkAnswer({ stage }, statuses))!;
    expect(currentCheckOf(st('observe'))).toBe('long_task');
    expect(currentCheckOf(st('observe', { long_task: 'passed' }))).toBeNull();
    expect(currentCheckOf(st('enforce'))).toBe('spend_cap');
    expect(currentCheckOf(st('enforce', { spend_cap: 'passed' }))).toBe('allowlists_keywords');
    expect(currentCheckOf(st('enforce', { spend_cap: 'passed', allowlists_keywords: 'passed' }))).toBe('loop_rate');
    expect(currentCheckOf(st('pause'))).toBe('pause_stop');
    expect(currentCheckOf(st('stop'))).toBe('pause_stop');
    expect(currentCheckOf(st('errors'))).toBe('provider_errors');
    expect(currentCheckOf(checkStateOf(checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z' }))!)).toBeNull();
  });

  it('quiet: a check whose agent last called 2+ minutes ago offers Finish now as the next step', async () => {
    const now = Date.parse('2026-10-29T20:30:00.000Z');
    const at = (msAgo: number) => ({ ...checkStateOf(checkAnswer({ stage: 'enforce' }))!, activity: { lastCallAt: new Date(now - msAgo).toISOString(), callsOutsideWindow24h: 0 } });
    expect(isQuiet(at(QUIET_MS - 1000), now)).toBe(false);
    expect(isQuiet(at(QUIET_MS), now)).toBe(true);
    expect(isQuiet({ ...at(QUIET_MS), activity: undefined }, now)).toBe(false);
    // A check that just started (Check again with an idle agent) isn't quiet at once.
    const fresh = at(10 * QUIET_MS);
    expect(isQuiet({ ...fresh, window: { ...fresh.window!, startedAt: new Date(now - 1000).toISOString() } }, now)).toBe(false);
    expect(isQuiet({ ...fresh, window: { ...fresh.window!, startedAt: new Date(now - QUIET_MS).toISOString() } }, now)).toBe(true);
    capture.mockClear();
    await render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-quiet'] }));
    expect(text()).toContain('Your agent stopped calling');
    expect(text()).toMatch(/Last call 3 min ago, \d of 6 checks done\. Run your agent again to carry on, or finish now/);
    const finish = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Finish now');
    expect(finish).toHaveLength(1);
    expect(finish[0].className).toContain('wr-btn--primary');
    // One prompt at a time: no "Nothing happening?" beside the quiet box.
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    checks = { ...checkAnswer({ stage: 'observe', calls: 0 }), activity: { lastCallAt: new Date(Date.now() - 10 * QUIET_MS).toISOString(), callsOutsideWindow24h: 0 } };
    await render(checksEl());
    expect(text()).toContain('Your agent stopped calling');
    expect(text()).not.toContain('Nothing after a minute?');
  });

  it('Finish now sends the stop with the stage, and whether the agent had gone quiet', async () => {
    capture.mockClear();
    checks = checkAnswer({ stage: 'observe' });
    await render(checksEl());
    await click('Finish now');
    expect(capture).toHaveBeenCalledWith('sandbox_v2_finish_now', { stage: 'observe', quiet: false });
  });

  it('no call yet: the usual fixes show at once (the mockup’s three), and a minute later their event goes once', async () => {
    vi.useFakeTimers();
    capture.mockClear();
    checks = checkAnswer(null);
    await render(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, provider: 'openai' }));
    // At once (mockup Rev 3, 2 · Waiting); the event waits for a minute with no call, as the old fold's auto-open did.
    expect(text()).toContain('Nothing after a minute? Usually one of these:');
    expect(text()).toContain('Restart your agent after changing .env.');
    expect(text()).toContain('Check it reads OPENAI_BASE_URL, or pass the URL as base_url.');
    expect(text()).toContain('Check it sends a name: an x-whiteroom-agent header or a system prompt.');
    expect(capture.mock.calls.some(([n]) => n === 'sandbox_v2_idle_help')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_HELP_MS * 3); });
    expect(capture.mock.calls.filter(([n]) => n === 'sandbox_v2_idle_help')).toEqual([['sandbox_v2_idle_help', { opened: 'auto' }]]);
  });

  it('the usual fixes go once a call arrives', async () => {
    vi.useFakeTimers();
    checks = checkAnswer(null);
    await render(checksEl());
    expect(text()).toContain('Nothing after a minute?');
    checks = { ...checkAnswer({ stage: 'observe', calls: 1 }), activity: { lastCallAt: new Date(Date.now() + 1000).toISOString(), callsOutsideWindow24h: 0 } };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(text()).not.toContain('Nothing after a minute?');
  });

  it('no Resume at any stage: the check lifts its own stop after 5 seconds', async () => {
    for (const stage of ['observe', 'enforce', 'pause', 'stop', 'errors', 'done']) {
      expect(stageLine(checkStateOf(checkAnswer({ stage }))!)).not.toMatch(/Resume|Stop checking/);
    }
    expect(stageLine(checkStateOf(checkAnswer({ stage: 'done' }))!)).toBe('Getting your results…');
    checks = checkAnswer({ stage: 'pause' });
    await render(checksEl());
    expect(text()).toContain('Paused your agent for 5 seconds…');
    expect(button('Resume')).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    checks = checkAnswer({ stage: 'stop' });
    await render(checksEl());
    expect(text()).toContain('Stopped your agent for 5 seconds…');
    expect(button('Resume')).toBeUndefined();
    expect(calls().some((c) => c.url.endsWith('/checks/resume'))).toBe(false);
    expect(SANDBOX_CHECKS_ACTIONS).not.toContain('resume');
  });

  it('polls every 30 seconds in a hidden tab, and reads at once when the tab comes back', async () => {
    vi.useFakeTimers();
    checks = checkAnswer({ stage: 'observe' });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      await render(checksEl());
      const reads = () => calls().filter((c) => c.url.endsWith('/checks/status')).length;
      expect(reads()).toBe(1);
      // Hidden: at most one read in 30 seconds after the first (visible would be six).
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await flush();
      const hiddenReads = reads();
      expect(hiddenReads).toBeLessThanOrEqual(3);
      hidden.mockReturnValue(false);
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await flush();
      expect(reads()).toBe(hiddenReads + 1);
    } finally {
      hidden.mockRestore();
    }
  });

  it('polls every 5 seconds, and keeps watching after a check ends (a later call starts the next)', async () => {
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
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(reads()).toBe(4);
    // The report: a verdict, a check never reached is among the ones that didn't run, and Check again.
    expect(text()).toContain('2 of 8 checked');
    expect(document.querySelector('li[data-row="02"]')?.textContent).toContain('Your agent didn’t reach this step.');
    expect(button('Check again')).toBeDefined();
    expect(button('Finish now')).toBeUndefined();
  });

  it('Finish now ends the window and shows the report, with focus on the verdict', async () => {
    checks = checkAnswer({ stage: 'observe' });
    await render(checksEl());
    checks = checkAnswer({ stage: 'observe', endedAt: '2026-10-29T10:06:00.000Z' }, { long_task: 'passed' });
    await click('Finish now');
    expect(calls().some((c) => c.url.endsWith('/checks/stop'))).toBe(true);
    expect(text()).toContain('1 of 8 checked');
    expect(document.activeElement?.textContent).toBe('Nothing to fix · 1 of 8 checked');
  });

  it('sends one sandbox_report_rows for a check that finishes while the page is open, and none for an old report on load', async () => {
    capture.mockClear();
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z' }, { long_task: 'passed' });
    await render(checksEl());
    expect(capture).not.toHaveBeenCalledWith('sandbox_report_rows', expect.anything());
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    checks = checkAnswer({ stage: 'observe' });
    await render(checksEl());
    checks = checkAnswer({ stage: 'observe', endedAt: '2026-10-29T10:06:00.000Z' }, { long_task: 'passed', provider_errors: 'failed' });
    await click('Finish now');
    await flush();
    const sent = capture.mock.calls.filter(([name]) => name === 'sandbox_report_rows');
    expect(sent).toEqual([['sandbox_report_rows', { tone: 'warn', fewCalls: false, fix: 1, checked: expect.any(Number), notProven: 0, practice: expect.any(Number), notSetUp: expect.any(Number), calls: expect.any(Number), sample: false }]]);
    // Only the tone and row counts the page shows: no ids, keys or names.
    expect(JSON.stringify(sent)).not.toMatch(/sandbox-|chk_|prod-eu|sk-/);
  });

  it.each([
    ['pass', { spend_cap: 'passed', loop_rate: 'passed', allowlists_keywords: 'passed', pause_stop: 'passed', long_task: 'passed', provider_errors: 'passed' }, 14, { fix: 0, checked: 6, fewCalls: false }],
    ['neutral', { long_task: 'passed' }, 14, { fix: 0, checked: 1, fewCalls: false }],
    ['neutral', {}, 14, { fix: 0, checked: 0, fewCalls: false }],
    // Too few calls: the page shows the rows (neutral), and the event says the calls held the live checks back.
    ['neutral', {}, 3, { fix: 0, checked: 0, fewCalls: true }],
  ] as const)('the report event carries the %s tone, the rows’ counts and the calls', async (tone, statuses, calls, counts) => {
    capture.mockClear();
    checks = checkAnswer({ stage: 'observe' });
    await render(checksEl());
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z', calls }, statuses);
    await click('Finish now');
    await flush();
    expect(capture.mock.calls.filter(([name]) => name === 'sandbox_report_rows')).toEqual([['sandbox_report_rows', { tone, ...counts, notProven: 0, practice: 2, notSetUp: expect.any(Number), calls, sample: false }]]);
  });

  it('a check that opens and ends between two reads still counts as new: focus and one report event', async () => {
    vi.useFakeTimers();
    capture.mockClear();
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z' }, { long_task: 'passed' });
    await render(checksEl());
    expect(capture).not.toHaveBeenCalledWith('sandbox_report_rows', expect.anything());
    // The next read already has a different, ended window: the page never saw it open.
    checks = checkAnswer({ id: 'chk_2', stage: 'done', endedAt: '2026-10-29T10:20:00.000Z' }, { spend_cap: 'failed' });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(document.activeElement?.textContent).toBe('1 thing to fix before going live');
    expect(capture.mock.calls.filter(([name]) => name === 'sandbox_report_rows')).toHaveLength(1);
  });

  it('Check again after a report starts a new check and shows it live', async () => {
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z' }, { long_task: 'passed' });
    await render(checksEl());
    expect(text()).toContain('1 of 8 checked');
    // Already there on load: the page doesn't take focus.
    expect(document.activeElement?.tagName).not.toBe('H3');
    checks = checkAnswer({ stage: 'observe', calls: 0 });
    await click('Check again');
    expect(calls().find((c) => c.url.endsWith('/checks/start'))?.body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(text()).toContain('Watching your agent’s calls…');
    expect(button('Finish now')).toBeDefined();
  });

  it('a refused Check again shows why and reads the checks again', async () => {
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z' }, { long_task: 'passed' });
    await render(checksEl());
    bff.mockImplementationOnce(async () => Response.json({ error: 'A check is already running.' }, { status: 409 }));
    await click('Check again');
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
    helper = { ...HELPER_ON, recent: [{ taskId: 't1', promptPreview: 'Draft a reply', ok: false, summary: 'Exited with code 1.', finishedAt: '2026-10-29T10:00:00.000Z' }] };
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

describe('Stale Sandbox vs state conflicts, overtaken answers, and parent re-renders', () => {
  const STALE = { error: 'That Sandbox doesn\'t belong to this fleet.', reason: 'sandbox_changed' };
  const statusReads = () => calls().filter((c) => c.url.endsWith('/checks/status')).length;
  const helperEl = (onStale: () => void) => h(SandboxHelper, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, onStale });
  const once = (url: string, res: () => Response | Promise<Response>) => {
    const base = bff.getMockImplementation()!;
    bff.mockImplementation(async (u: string, init: RequestInit) => {
      if (u === url) { bff.mockImplementation(base); return res(); }
      return base(u, init);
    });
  };

  it('checks load: onStale on 404 and on sandbox_changed, never on a state-conflict 409', async () => {
    for (const [res, isStale] of [
      [() => Response.json({ error: 'No check is running.' }, { status: 409 }), false],
      [() => Response.json({ error: 'Server error' }, { status: 500 }), false],
      [() => Response.json({ error: 'This fleet has no Sandbox.' }, { status: 404 }), true],
      [() => Response.json(STALE, { status: 409 }), true],
    ] as const) {
      const onStale = vi.fn();
      once('/api/sandbox/checks/status', res);
      await render(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, onStale }));
      expect(onStale).toHaveBeenCalledTimes(isStale ? 1 : 0);
      act(() => root.unmount());
      root = createRoot(document.body.appendChild(document.createElement('div')));
    }
  });

  it('checks poll: keeps going after a state-conflict 409 or a 5xx, stops on a stale answer', async () => {
    vi.useFakeTimers();
    const onStale = vi.fn();
    checks = checkAnswer({ stage: 'observe' });
    await render(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, onStale }));
    const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); await flush(); };
    once('/api/sandbox/checks/status', () => Response.json({ error: 'A check is already running.' }, { status: 409 }));
    await tick();
    expect(statusReads()).toBe(2);
    expect(text()).toContain('A check is already running.');
    once('/api/sandbox/checks/status', () => Response.json({ error: 'Server error' }, { status: 503 }));
    await tick();
    expect(statusReads()).toBe(3);
    await tick();
    expect(statusReads()).toBe(4);
    expect(onStale).not.toHaveBeenCalled();
    expect(text()).not.toContain('A check is already running.');
    once('/api/sandbox/checks/status', () => Response.json(STALE, { status: 409 }));
    await tick();
    expect(statusReads()).toBe(5);
    expect(onStale).toHaveBeenCalledTimes(1);
    await tick(); await tick();
    expect(statusReads()).toBe(5);
  });

  it('checks act: a state-conflict 409 reads again without onStale; sandbox_changed and 404 call onStale', async () => {
    const onStale = vi.fn();
    checks = checkAnswer({ stage: 'observe' });
    await render(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, onStale }));
    once('/api/sandbox/checks/stop', () => Response.json({ error: 'No check is running.' }, { status: 409 }));
    await click('Finish now');
    expect(onStale).not.toHaveBeenCalled();
    expect(statusReads()).toBe(2);
    expect(text()).toContain('No check is running.');
    once('/api/sandbox/checks/stop', () => Response.json(STALE, { status: 409 }));
    await click('Finish now');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(statusReads()).toBe(2);
    once('/api/sandbox/checks/stop', () => Response.json({ error: 'This fleet has no Sandbox.' }, { status: 404 }));
    await click('Finish now');
    expect(onStale).toHaveBeenCalledTimes(2);
  });

  it('checks: a poll never lands over an action on its way', async () => {
    vi.useFakeTimers();
    checks = checkAnswer({ stage: 'observe' });
    await render(checksEl());
    let answer!: () => void;
    once('/api/sandbox/checks/stop', () => new Promise<Response>((resolve) => {
      answer = () => resolve(Response.json(checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z' }, { long_task: 'passed' })));
    }));
    await act(async () => { button('Finish now')!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(statusReads()).toBe(1);
    checks = checkAnswer({ stage: 'done', endedAt: '2026-10-29T10:06:00.000Z' }, { long_task: 'passed' });
    await act(async () => { answer(); });
    await flush();
    expect(text()).toContain('1 of 8 checked');
    // Polling carries on after the action, and the report stays.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(statusReads()).toBe(2);
    expect(text()).toContain('1 of 8 checked');
  });

  it('no refetch loop: a new onStale on every parent render reads once, even when the read is stale', async () => {
    let reads = 0;
    const base = bff.getMockImplementation()!;
    bff.mockImplementation(async (u: string, init: RequestInit) => {
      if (u === '/api/sandbox/checks/status' || u === '/api/sandbox/helper/status') { reads++; return Response.json(STALE, { status: 409 }); }
      return base(u, init);
    });
    let staleCalls = 0;
    function Parent() {
      const [n, setN] = useState(0);
      // A new inline callback each render, which re-renders the parent: the old loop.
      const onStale = () => { staleCalls++; setN(n + 1); };
      return h('div', null,
        h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, onStale }),
        h(SandboxHelper, { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, onStale }));
    }
    await render(h(Parent));
    await flush();
    expect(reads).toBe(2);
    expect(staleCalls).toBe(2);
    await render(h(Parent));
    expect(reads).toBe(2);
  });

  it('SandboxHome hands the steps one stable onStale: re-rendering it reads nothing again', async () => {
    const STATUS = { success: true, exists: true, sandboxFleetId: SANDBOX_ID, createdAt: '2026-10-29T10:00:00.000Z', lastCallAt: null, expiresAt: null, key: { prefix: 'sk-wr-0123456789abcdef...', provider: 'anthropic', keyHint: 'WXYZ' } };
    bff.mockImplementation(async (url: string) => {
      if (url === '/api/sandbox/fleet/status') return Response.json(STATUS);
      if (url.startsWith('/api/sandbox/checks/')) return Response.json(checkAnswer(null));
      if (url.startsWith('/api/sandbox/helper/')) return Response.json(HELPER_OFF);
      if (url.startsWith('/api/sandbox/rules/')) return Response.json({ success: true, sandboxFleetId: SANDBOX_ID, rules: [], source: 'custom', productionChanged: 0 });
      return Response.json({ fleetId: 'prod-eu', rules: [], history: [], agents: [] });
    });
    const onUnavailable = () => {};
    await render(h(SandboxHome, { fleet: 'prod-eu', onUnavailable }));
    const before = bff.mock.calls.length;
    await render(h(SandboxHome, { fleet: 'prod-eu', onUnavailable }));
    await render(h(SandboxHome, { fleet: 'prod-eu', onUnavailable }));
    expect(bff.mock.calls.length).toBe(before);
  });

  it('Run agent: the request ID is kept on 5xx, an unreadable answer and no answer; cleared on a 4xx refusal', async () => {
    helper = HELPER_ON;
    const onStale = vi.fn();
    await render(helperEl(onStale));
    await typeIn(document.getElementById('sandbox-v2-prompt') as HTMLTextAreaElement, 'Summarize tickets');
    const ids = () => calls().filter((c) => c.url === '/api/sandbox/helper/run').map((c) => c.body.requestId as string);
    once('/api/sandbox/helper/run', () => Response.json({ error: 'The Sandbox couldn’t do that right now.' }, { status: 502 }));
    await click('Run agent');
    once('/api/sandbox/helper/run', () => Response.json({ error: 'Server error' }, { status: 500 }));
    await click('Run agent');
    once('/api/sandbox/helper/run', () => Response.json({ success: true, nope: 1 }));
    await click('Run agent');
    once('/api/sandbox/helper/run', () => { throw new TypeError('network'); });
    await click('Run agent');
    expect(new Set(ids()).size).toBe(1);
    // A definite refusal (no helper): it never ran, so the next click is new. Not a stale Sandbox.
    once('/api/sandbox/helper/run', () => Response.json({ error: 'No helper is connected.', reason: 'no_helper' }, { status: 409 }));
    await click('Run agent');
    expect(text()).toContain('Your helper isn’t connected.');
    expect(onStale).not.toHaveBeenCalled();
    await click('Run agent');
    const all = ids();
    expect(all).toHaveLength(6);
    expect(all[5]).not.toBe(all[4]);
    expect(all[4]).toBe(all[0]);
  });

  it('Run agent: onStale only on a stale Sandbox (404, sandbox_changed)', async () => {
    helper = HELPER_ON;
    const onStale = vi.fn();
    await render(helperEl(onStale));
    await typeIn(document.getElementById('sandbox-v2-prompt') as HTMLTextAreaElement, 'Go');
    once('/api/sandbox/helper/run', () => Response.json({ error: 'Too many.', reason: 'queue_full', retryAfter: 30 }, { status: 429 }));
    await click('Run agent');
    expect(onStale).not.toHaveBeenCalled();
    once('/api/sandbox/helper/run', () => Response.json(STALE, { status: 409 }));
    await click('Run agent');
    expect(onStale).toHaveBeenCalledTimes(1);
    once('/api/sandbox/helper/run', () => Response.json({ error: 'This fleet has no Sandbox.' }, { status: 404 }));
    await click('Run agent');
    expect(onStale).toHaveBeenCalledTimes(2);
  });

  it('helper poll: a stale answer calls onStale once and stops polling; other failures keep it', async () => {
    vi.useFakeTimers();
    helper = { ...HELPER_ON, running: true };
    const onStale = vi.fn();
    await render(helperEl(onStale));
    const reads = () => calls().filter((c) => c.url === '/api/sandbox/helper/status').length;
    const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); await flush(); };
    once('/api/sandbox/helper/status', () => Response.json({ error: 'Server error' }, { status: 500 }));
    await tick();
    await tick();
    expect(reads()).toBe(3);
    expect(onStale).not.toHaveBeenCalled();
    once('/api/sandbox/helper/status', () => Response.json(STALE, { status: 409 }));
    await tick();
    expect(onStale).toHaveBeenCalledTimes(1);
    await tick(); await tick();
    expect(reads()).toBe(4);
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
    // In the open, not inside the closed Sandbox settings.
    const warn = [...document.querySelectorAll('.wr-banner, [role="alert"], [class*="banner"]')].find((e) => e.textContent?.includes('42 times outside'));
    expect(warn?.closest('details')).toBeNull();
    expect(document.querySelector('#sandbox-step')?.getAttribute('aria-label')).toBe('Run your agent');
    // Like production: no Run agent helper on the page.
    expect(text()).not.toContain('Run agent');
    expect(document.body.innerHTML).not.toContain('href="/controls');
  });

  it.each(Object.keys(SANDBOX_V2_STATES).filter((k) => k.startsWith('checks-') || k === 'outside-window') as (keyof typeof SANDBOX_V2_STATES)[])(
    '/dev/sandbox-v2 %s renders without fetching or linking to Controls',
    async (state) => {
      await render(h(SandboxHome, { fleet: 'prod-eu', preview: SANDBOX_V2_STATES[state] }));
      expect(bff).not.toHaveBeenCalled();
      const ended = !!(SANDBOX_V2_STATES[state] as { checks?: { state: { window: { endedAt: string | null } | null } | null } }).checks?.state?.window?.endedAt;
      expect(document.querySelector('#sandbox-step')?.getAttribute('aria-label')).toBe(ended ? 'Results' : 'Run your agent');
      expect(document.body.innerHTML).not.toContain('href="/controls');
      expect(button('Resume')).toBeUndefined();
    },
  );
});
