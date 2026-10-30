// Sandbox checks' and helper's BFF (app/api/sandbox/{checks,helper}/[action]):
// same-origin, the signed-in owner of the production fleet only, the Sandbox
// pin passed on, only known fields forwarded, only sandbox_check_* /
// sandbox_helper_* actions ever called, and only known answer fields passed
// back. Placeholder keys only.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.fn();
const access = vi.fn();
const cookie = vi.fn();
const sameOrigin = vi.fn();
vi.mock('@/auth', () => ({ auth: () => auth() }));
vi.mock('@/lib/control-auth', () => ({ CONTROL_SECRET_HEADER: 'x-wr-dashboard-secret', CONTROL_USER_HEADER: 'x-wr-dashboard-user', controlAccessError: (...a: unknown[]) => access(...a) }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: () => cookie(), tokenFromUserFleets: async () => null }));
vi.mock('@/lib/origin-check', () => ({ checkSameOrigin: () => sameOrigin() }));

const checksRoute = await import('@/app/api/sandbox/checks/[action]/route');
const helperRoute = await import('@/app/api/sandbox/helper/[action]/route');
const { SANDBOX_CHECKS_ACTIONS, SANDBOX_CHECKS_ENGINE_ACTION, CHECK_IDS } = await import('@/lib/sandbox/checks');
const { SANDBOX_HELPER_ACTIONS, SANDBOX_HELPER_ENGINE_ACTION } = await import('@/lib/sandbox/helper');

const FLEET_TOKEN = 'wr_placeholder_fleet_token';
const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
const REQUEST_ID = '00000000-0000-4000-8000-0000000000aa';
const WINDOW = { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', endedAt: null, stage: 'observe', injectErrors: true, calls: 3, internal: 'x' };
const CHECKS = CHECK_IDS.map((id) => ({ id, label: id, status: 'pending', detail: '', secret: 'no' }));
const STATE = { success: true, window: WINDOW, checks: CHECKS, rules: [{ ruleId: 'gr_1', ruleType: 'spend_cap', check: 'spend_cap', wouldAct: true, acted: false, status: 'pending', detail: 'Would block at $0.02.', raw: 'no' }] };
const HELPER = {
  connected: true, host: 'dev-laptop.local', connectedAt: '2026-10-29T10:00:00.000Z', lastSeenAt: '2026-10-29T10:05:00.000Z', queued: 0, running: false,
  recent: [{ taskId: 'task_1', promptPreview: 'Summarize tickets', ok: true, summary: 'Done in 40 s.', finishedAt: '2026-10-29T10:04:00.000Z', adapter: 'node agent.js' }],
  code: null, tasksThisHour: 2, tasksPerHour: 30, sessionToken: 'wr_placeholder_session_token',
};

const engine = vi.fn();
const post = (route: 'checks' | 'helper', action: string, body: unknown) =>
  (route === 'checks' ? checksRoute : helperRoute).POST(
    new Request(`https://app.example/api/sandbox/${route}/${action}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ action }) },
  );
const sentBodies = () => engine.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));

beforeEach(() => {
  vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'dash-secret');
  auth.mockResolvedValue({ user: { id: 'u1' } });
  access.mockReset().mockResolvedValue(null);
  cookie.mockResolvedValue(FLEET_TOKEN);
  sameOrigin.mockResolvedValue(null);
  engine.mockReset().mockImplementation(async (_url: string, init: RequestInit) => {
    const action = JSON.parse(String(init.body)).action as string;
    if (action.startsWith('sandbox_check_')) return Response.json(STATE);
    if (action === 'sandbox_helper_code') return Response.json({ code: 'ABCD-1234', codeExpiresAt: '2026-10-29T10:10:00.000Z', sessionToken: 'wr_placeholder_session_token' });
    if (action === 'sandbox_helper_run') return Response.json({ taskId: 'task_2', duplicate: false, prompt: 'echo' });
    return Response.json(HELPER);
  });
  vi.stubGlobal('fetch', engine);
});

describe('Sandbox checks and helper BFF: who may ask', () => {
  it.each(['checks', 'helper'] as const)('%s: refuses cross-origin, signed-out, non-owners, Sandbox fleets and unknown actions without asking the engine', async (route) => {
    sameOrigin.mockResolvedValueOnce(Response.json({ error: 'Origin mismatch.' }, { status: 403 }));
    expect((await post(route, 'status', { fleet: 'prod-eu' })).status).toBe(403);
    auth.mockResolvedValueOnce(null);
    expect((await post(route, 'status', { fleet: 'prod-eu' })).status).toBe(401);
    access.mockResolvedValueOnce({ status: 403, error: 'Only this fleet’s owner can change its controls and settings.' });
    expect((await post(route, 'status', { fleet: 'prod-eu' })).status).toBe(403);
    expect(access).toHaveBeenCalledWith('prod-eu', FLEET_TOKEN);
    expect((await post(route, 'status', { fleet: SANDBOX_ID })).status).toBe(400);
    expect((await post(route, 'governance_pause', { fleet: 'prod-eu' })).status).toBe(404);
    // The page no longer sends resume (a check lifts its own stop), so the route doesn't take it.
    if (route === 'checks') expect((await post(route, 'resume', { fleet: 'prod-eu' })).status).toBe(404);
    expect((await post(route, 'status', 'not json')).status).toBe(400);
    expect((await post(route, 'status', { fleet: 'prod-eu', sandboxFleetId: 'prod-eu' })).status).toBe(400);
    expect(engine).not.toHaveBeenCalled();
  });

  it('passes the Sandbox pin, the secret and the user; a pin mismatch (409) and no Sandbox (404) come through', async () => {
    await post('checks', 'status', { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(sentBodies()[0]).toEqual({ action: 'sandbox_check_status', fleet_id: 'prod-eu', sandbox_fleet_id: SANDBOX_ID });
    const headers = (engine.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-wr-dashboard-secret']).toBe('dash-secret');
    expect(headers['x-wr-dashboard-user']).toBe('u1');
    engine.mockResolvedValueOnce(Response.json({ error: 'Your Sandbox changed. Reload the page.' }, { status: 409 }));
    expect((await post('checks', 'stop', { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID })).status).toBe(409);
    engine.mockResolvedValueOnce(Response.json({ error: 'No Sandbox for this fleet.' }, { status: 404 }));
    expect((await post('helper', 'status', { fleet: 'prod-eu' })).status).toBe(404);
  });
});

describe('Sandbox checks and helper BFF: a fixed action map', () => {
  it('maps every action to a sandbox_check_ / sandbox_helper_ engine action', () => {
    for (const a of SANDBOX_CHECKS_ACTIONS) expect(SANDBOX_CHECKS_ENGINE_ACTION[a]).toBe(`sandbox_check_${a}`);
    for (const a of SANDBOX_HELPER_ACTIONS) expect(SANDBOX_HELPER_ENGINE_ACTION[a]).toBe(`sandbox_helper_${a}`);
  });

  it('forwards known fields only, whatever the body says', async () => {
    const extra = { action: 'governance_pause', fleet_id: 'other', command: 'rm -rf /', adapter: 'sh' };
    await post('checks', 'status', { fleet: 'prod-eu', ...extra });
    await post('checks', 'start', { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, injectErrors: false, ...extra });
    await post('checks', 'start', { fleet: 'prod-eu' });
    await post('checks', 'stop', { fleet: 'prod-eu', injectErrors: true, ...extra });
    await post('helper', 'status', { fleet: 'prod-eu', ...extra });
    await post('helper', 'code', { fleet: 'prod-eu', ...extra });
    await post('helper', 'run', { fleet: 'prod-eu', prompt: '  Summarize tickets  ', requestId: REQUEST_ID, ...extra });
    await post('helper', 'disconnect', { fleet: 'prod-eu', ...extra });
    expect(sentBodies()).toEqual([
      { action: 'sandbox_check_status', fleet_id: 'prod-eu' },
      { action: 'sandbox_check_start', fleet_id: 'prod-eu', sandbox_fleet_id: SANDBOX_ID, inject_errors: false },
      { action: 'sandbox_check_start', fleet_id: 'prod-eu' },
      { action: 'sandbox_check_stop', fleet_id: 'prod-eu' },
      { action: 'sandbox_helper_status', fleet_id: 'prod-eu' },
      { action: 'sandbox_helper_code', fleet_id: 'prod-eu' },
      { action: 'sandbox_helper_run', fleet_id: 'prod-eu', task: { kind: 'prompt', prompt: 'Summarize tickets' }, request_id: REQUEST_ID },
      { action: 'sandbox_helper_disconnect', fleet_id: 'prod-eu' },
    ]);
  });

  it('refuses bad fields before the engine', async () => {
    expect((await post('checks', 'start', { fleet: 'prod-eu', injectErrors: 'yes' })).status).toBe(400);
    expect((await post('helper', 'run', { fleet: 'prod-eu', prompt: '', requestId: REQUEST_ID })).status).toBe(400);
    expect((await post('helper', 'run', { fleet: 'prod-eu', prompt: 'x'.repeat(4001), requestId: REQUEST_ID })).status).toBe(400);
    expect((await post('helper', 'run', { fleet: 'prod-eu', prompt: 'Go' })).status).toBe(400);
    expect((await post('helper', 'run', { fleet: 'prod-eu', prompt: 'Go', requestId: 'bad id!' })).status).toBe(400);
    expect((await post('helper', 'run', { fleet: 'prod-eu', prompt: 'x'.repeat(21_000), requestId: REQUEST_ID })).status).toBe(413);
    expect(engine).not.toHaveBeenCalled();
  });
});

describe('Sandbox checks and helper BFF: what comes back', () => {
  it('check status: the window, seven checks and rules, with known fields only', async () => {
    const body = await (await post('checks', 'status', { fleet: 'prod-eu' })).json();
    expect(body.window).toEqual({ id: 'chk_1', startedAt: WINDOW.startedAt, endedAt: null, stage: 'observe', injectErrors: true, calls: 3 });
    expect(body.checks.map((c: { id: string }) => c.id)).toEqual([...CHECK_IDS]);
    expect(JSON.stringify(body)).not.toMatch(/secret|"raw"|internal/);
    engine.mockResolvedValueOnce(Response.json({ success: true }));
    expect((await post('checks', 'status', { fleet: 'prod-eu' })).status).toBe(502);
    // Start may answer without the state: the page reads it next.
    engine.mockResolvedValueOnce(Response.json({ success: true, windowId: 'chk_2' }));
    expect(await (await post('checks', 'start', { fleet: 'prod-eu' })).json()).toEqual({ success: true });
  });

  it('helper: status, the code once, and the run answer — never a session token or the agent command', async () => {
    const status = await (await post('helper', 'status', { fleet: 'prod-eu' })).text();
    expect(status).not.toContain('wr_placeholder_session_token');
    expect(status).not.toContain('node agent.js');
    expect(JSON.parse(status).recent).toEqual([{ id: 'task_1', prompt: 'Summarize tickets', ok: true, summary: 'Done in 40 s.', at: '2026-10-29T10:04:00.000Z' }]);
    expect(await (await post('helper', 'code', { fleet: 'prod-eu' })).json()).toEqual({ success: true, code: 'ABCD-1234', codeExpiresAt: '2026-10-29T10:10:00.000Z' });
    expect(await (await post('helper', 'run', { fleet: 'prod-eu', prompt: 'Go', requestId: REQUEST_ID })).json()).toEqual({ success: true, taskId: 'task_2', duplicate: false });
  });

  it('passes a 429’s reason and wait on, and a 409’s reason', async () => {
    engine.mockResolvedValueOnce(Response.json({ error: 'Too many tasks this hour.', reason: 'tasks_per_hour' }, { status: 429, headers: { 'Retry-After': '720' } }));
    const limited = await post('helper', 'run', { fleet: 'prod-eu', prompt: 'Go', requestId: REQUEST_ID });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('720');
    expect(await limited.json()).toEqual({ error: 'Too many tasks this hour.', reason: 'tasks_per_hour', retryAfter: 720 });
    engine.mockResolvedValueOnce(Response.json({ error: 'No helper connected.', reason: 'no_helper' }, { status: 409 }));
    expect(await (await post('helper', 'run', { fleet: 'prod-eu', prompt: 'Go', requestId: REQUEST_ID })).json()).toEqual({ error: 'No helper connected.', reason: 'no_helper' });
    engine.mockResolvedValueOnce(Response.json({ error: 'Nope.', reason: 'Not A Reason <x>' }, { status: 409 }));
    expect(await (await post('helper', 'code', { fleet: 'prod-eu' })).json()).toEqual({ error: 'Nope.' });
  });
});

describe('Sandbox checks and helper BFF: stale Sandbox vs state conflicts, and Retry-After bounds', () => {
  it('names the engine’s pin refusal sandbox_changed; a state-conflict 409 gets no such reason', async () => {
    engine.mockResolvedValueOnce(Response.json({ error: 'That Sandbox doesn\'t belong to this fleet.' }, { status: 409 }));
    expect(await (await post('checks', 'status', { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID })).json())
      .toEqual({ error: 'That Sandbox doesn\'t belong to this fleet.', reason: 'sandbox_changed' });
    for (const error of ['A check is already running. Stop it first.', 'No check is running.', 'Nothing is stopped by the check right now.']) {
      engine.mockResolvedValueOnce(Response.json({ error }, { status: 409 }));
      expect(await (await post('checks', 'stop', { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID })).json()).toEqual({ error });
    }
    // The engine's own reason wins; the same words on a non-409 aren't the pin refusal.
    engine.mockResolvedValueOnce(Response.json({ error: 'That Sandbox doesn\'t belong to this fleet.', reason: 'no_helper' }, { status: 409 }));
    expect((await (await post('helper', 'run', { fleet: 'prod-eu', prompt: 'Go', requestId: REQUEST_ID })).json()).reason).toBe('no_helper');
    engine.mockResolvedValueOnce(Response.json({ error: 'That Sandbox doesn\'t belong to this fleet.' }, { status: 400 }));
    expect((await (await post('checks', 'status', { fleet: 'prod-eu' })).json()).reason).toBeUndefined();
  });

  it.each([['0'], ['-5'], ['1.5'], ['abc'], ['86401'], ['']])('a 429 with Retry-After %j carries no wait', async (value) => {
    engine.mockResolvedValueOnce(Response.json({ error: 'Too many tasks this hour.', reason: 'tasks_per_hour' }, { status: 429, headers: { 'Retry-After': value } }));
    const res = await post('helper', 'run', { fleet: 'prod-eu', prompt: 'Go', requestId: REQUEST_ID });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toEqual({ error: 'Too many tasks this hour.', reason: 'tasks_per_hour' });
  });

  it('a 429 with Retry-After at the 86400 bound passes it on', async () => {
    engine.mockResolvedValueOnce(Response.json({ error: 'Limit.', reason: 'tasks_per_hour' }, { status: 429, headers: { 'Retry-After': '86400' } }));
    const res = await post('helper', 'run', { fleet: 'prod-eu', prompt: 'Go', requestId: REQUEST_ID });
    expect(res.headers.get('retry-after')).toBe('86400');
    expect((await res.json()).retryAfter).toBe(86_400);
  });

  it('Retry-After on a refusal that isn’t a 429 is dropped', async () => {
    engine.mockResolvedValueOnce(Response.json({ error: 'No helper connected.', reason: 'no_helper' }, { status: 409, headers: { 'Retry-After': '60' } }));
    const res = await post('helper', 'run', { fleet: 'prod-eu', prompt: 'Go', requestId: REQUEST_ID });
    expect(res.status).toBe(409);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toEqual({ error: 'No helper connected.', reason: 'no_helper' });
  });
});
