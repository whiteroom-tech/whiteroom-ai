// When the engine restarts it is briefly unavailable and the platform answers
// for it (429 with its own body, or 502/503/504). The platform's 429 never
// reached the engine, so any call is sent again for up to ~5 s. On a 502/503/504
// or network error only reads are asked once more. The engine's own 429s are
// never retried.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFleet, getDiagnosis, pauseAgent, tokenLogin } from '@/lib/whiteroom/client';
import { fetchFleetUsage } from '@/lib/fleet-usage';
import { verifyFleetOwnership } from '@/lib/fleet-ownership';
import { practiceEngine } from '@/lib/sandbox/practice/server';
import { isTransientEngineAnswer, withEngineReadRetry } from '@/lib/whiteroom/engine-retry';

vi.mock('server-only', () => ({}));
vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: async () => null, tokenFromUserFleets: async () => null }));

const fetchMock = vi.fn();
const platform = (status: number) => new Response('<html>Rate exceeded.</html>', { status, headers: { 'Content-Type': 'text/html' } });
const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a read during a brief engine gap', () => {
  it('a platform 429 then 200 succeeds with one retry', async () => {
    fetchMock.mockResolvedValueOnce(platform(429)).mockResolvedValueOnce(json({ success: true, fleetId: 'f1' }));
    const login = tokenLogin('test-token');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(login).resolves.toMatchObject({ fleetId: 'f1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the engine’s own JSON 429 is not retried', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Too many fleets today.', reason: 'new_fleet_limit' }, 429));
    await expect(getDiagnosis('f1', 'test-key')).rejects.toThrow('HTTP 429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('503 then 503: one retry, then the existing error', async () => {
    fetchMock.mockImplementation(async () => platform(503));
    const failed = expect(getDiagnosis('f1', 'test-key')).rejects.toThrow('HTTP 503');
    await vi.advanceTimersByTimeAsync(2_000);
    await failed;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a network error is retried once', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json({ success: true, fleetId: 'f1' }));
    const login = tokenLogin('test-token');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(login).resolves.toMatchObject({ fleetId: 'f1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a timeout is not retried: the page never waits a second full timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(tokenLogin('test-token')).rejects.toThrow('timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a slow failure is not retried', async () => {
    fetchMock.mockImplementation(() => new Promise((r) => setTimeout(() => r(platform(503)), 6_000)));
    const failed = expect(getDiagnosis('f1', 'test-key')).rejects.toThrow('HTTP 503');
    await vi.advanceTimersByTimeAsync(6_000);
    await failed;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('with the engine’s handoff retry', () => {
  const handoff = () => new Response(JSON.stringify({ whiteroom: { reason: 'whiteroom_handoff' } }), { status: 503, headers: { 'Retry-After': '0' } });

  it('a read that already waited out a handoff is not asked a second round', async () => {
    fetchMock.mockResolvedValueOnce(handoff()).mockImplementation(async () => platform(502));
    const failed = expect(getDiagnosis('f1', 'test-key')).rejects.toThrow('HTTP 502');
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('the wait', () => {
  it('is at least 1.5 s and at most 2 s', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const request = vi.fn().mockResolvedValueOnce(platform(503)).mockResolvedValueOnce(json({ ok: true }));
    const answered = withEngineReadRetry(request);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(501);
    expect(request).toHaveBeenCalledTimes(2);
    expect((await answered).status).toBe(200);
  });
});

describe('a change is never retried', () => {
  it('pause_agent on a 503', async () => {
    fetchMock.mockImplementation(async () => platform(503));
    await expect(pauseAgent('f1', 'a1', 'test-key')).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('create_fleet on the engine’s own 429', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'Too many new fleets today.', reason: 'new_fleet_limit' }, 429));
    await expect(createFleet('f1', 'test-key')).resolves.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('create_fleet on a 502', async () => {
    fetchMock.mockImplementation(async () => platform(502));
    await expect(createFleet('f1', 'test-key')).resolves.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the platform’s 429 (the request never reached the engine)', () => {
  it('a change is sent again, and goes through once the engine is back', async () => {
    fetchMock
      .mockResolvedValueOnce(platform(429)).mockResolvedValueOnce(platform(429)).mockResolvedValueOnce(platform(429))
      .mockResolvedValueOnce(json({ success: true }));
    const paused = pauseAgent('f1', 'a1', 'test-key');
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(paused).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('is asked about every second, for at most ~5.5 s of waiting, then the existing error', async () => {
    const started = Date.now();
    fetchMock.mockImplementation(async () => platform(429));
    const failed = expect(createFleet('f1', 'test-key')).resolves.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    const calls = fetchMock.mock.calls.length;
    // 0.8-1.2 s apart: 5 to 7 sends within the 5.5 s budget.
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(calls).toBeLessThanOrEqual(7);
    expect(Date.now() - started).toBeLessThanOrEqual(10_000);
  });

  it('the total wait stays within the budget, even at the longest jitter', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    let last = 0;
    fetchMock.mockImplementation(async () => { last = Date.now(); return platform(429); });
    const started = Date.now();
    const failed = expect(tokenLogin('test-token')).rejects.toThrow('HTTP 429');
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(last - started).toBeLessThanOrEqual(5_500);
    // A read that already waited out the platform isn't asked a further round.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe('which answers count as a brief gap', () => {
  it.each([
    [platform(429), true],
    [new Response('', { status: 429 }), true],
    [json({ error: 'You’ve used today’s sample runs.', reason: 'limit_fleet' }, 429), false],
    [json({ error: 'Slow down.' }, 429), false],
    [json({ reason: 'starts_today' }, 429), false],
    [platform(502), true],
    [json({ error: 'engine_unreachable', retryable: true }, 502), true],
    [platform(503), true],
    [platform(504), true],
    [json({ whiteroom: { reason: 'whiteroom_handoff' } }, 503), true],
    [json({ error: 'nope' }, 500), false],
    [json({ error: 'invalid_token' }, 401), false],
    [json({ ok: true }), false],
  ])('%#', async (res, transient) => {
    expect(await isTransientEngineAnswer(res)).toBe(transient);
  });

  it('a handoff 503 is left to a caller that retries handoffs itself', async () => {
    const handoff = () => json({ whiteroom: { reason: 'whiteroom_handoff' } }, 503);
    expect(await isTransientEngineAnswer(handoff(), { handoffRetried: true })).toBe(false);
    expect(await isTransientEngineAnswer(platform(503), { handoffRetried: true })).toBe(true);
  });

  it('the ownership check asks again after a handoff 503', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ whiteroom: { reason: 'whiteroom_handoff' } }), { status: 503, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(json({ success: true, fleetId: 'f1' }));
    const verified = verifyFleetOwnership('test-token', 'f1');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(verified).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fleet usage', () => {
  it('waits out a longer platform gap (~4 s of 429s)', async () => {
    vi.stubEnv('WR_ENTITLEMENT_SYNC_SECRET', 'test-sync-secret');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 4; i++) fetchMock.mockResolvedValueOnce(platform(429));
    fetchMock.mockResolvedValueOnce(json({ windowDays: 7, fleets: [{ fleetId: 'f1', exists: true }] }));
    const usage = fetchFleetUsage(['f1']);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await usage).windowDays).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('a platform 429 then 200 shows usage', async () => {
    vi.stubEnv('WR_ENTITLEMENT_SYNC_SECRET', 'test-sync-secret');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(platform(429)).mockResolvedValueOnce(json({ windowDays: 7, fleets: [{ fleetId: 'f1', exists: true }] }));
    const usage = fetchFleetUsage(['f1']);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await usage;
    expect(result.windowDays).toBe(7);
    expect(result.byFleet.get('f1')).toMatchObject({ exists: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('practice tests', () => {
  beforeEach(() => vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'test-dash-secret'));

  it('a GET (a poll) is asked once more after a 503', async () => {
    fetchMock.mockResolvedValueOnce(platform(503)).mockResolvedValueOnce(json({ status: 'running' }));
    const polled = practiceEngine('GET', 'runs/r1', undefined, 'u1');
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await polled;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a POST is sent again on the platform’s 429, which never reached the engine', async () => {
    fetchMock.mockResolvedValueOnce(platform(429)).mockResolvedValueOnce(json({ runId: 'r1' }));
    const started = practiceEngine('POST', 'start', { fleet: 'f1' }, 'u1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await started).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a POST (starts a test) is sent exactly once on a 503', async () => {
    fetchMock.mockImplementation(async () => platform(503));
    const started = practiceEngine('POST', 'start', { fleet: 'f1' }, 'u1');
    await vi.advanceTimersByTimeAsync(2_000);
    await started;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
