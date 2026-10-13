// The practice-test BFF (app/api/sandbox/practice): owner-only, same-origin
// writes, only known fields forwarded, the dashboard secret added server-side.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.fn();
const access = vi.fn();
const cookie = vi.fn();
const sameOrigin = vi.fn();
vi.mock('@/auth', () => ({ auth: () => auth() }));
vi.mock('@/lib/control-auth', () => ({ CONTROL_SECRET_HEADER: 'x-wr-dashboard-secret', controlAccessError: (...a: unknown[]) => access(...a) }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: () => cookie(), tokenFromUserFleets: async () => null }));
vi.mock('@/lib/origin-check', () => ({ checkSameOrigin: () => sameOrigin() }));

const { GET, POST } = await import('@/app/api/sandbox/practice/[[...path]]/route');
const { engineUnavailable } = await import('@/lib/sandbox/practice/server');
const { PracticeError, retryable, unavailable } = await import('@/lib/sandbox/practice/api');

const RUN = 'r-7f3a2c1e-0b4d-4e8a-9c61-2d5f8e7a1b30';
const engine = vi.fn();
const ctx = (path?: string[]) => ({ params: Promise.resolve({ path }) });
const post = (path: string[], body: unknown) => POST(new Request('https://app.example/x', { method: 'POST', body: JSON.stringify(body) }), ctx(path));
const get = (path: string[] | undefined, query: string) => GET(new Request(`https://app.example/x?${query}`), ctx(path));

beforeEach(() => {
  vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'dash-secret');
  auth.mockResolvedValue({ user: { id: 'u1' } });
  access.mockResolvedValue(null);
  cookie.mockResolvedValue('wr_placeholder_token');
  sameOrigin.mockResolvedValue(null);
  engine.mockReset().mockResolvedValue(Response.json({ ok: true }, { status: 200 }));
  vi.stubGlobal('fetch', engine);
});

const sent = () => ({ url: String(engine.mock.calls[0][0]), init: engine.mock.calls[0][1] as RequestInit });

describe('practice BFF', () => {
  it('starts a test for the fleet’s owner, forwarding only known fields with the secret and who started it', async () => {
    const res = await post(['start'], { fleet: 'prod-eu', sample: false, runs: 3, agent: 'support-bot', model: 'claude-haiku-4-5', startedBy: 'someone-else', extra: 1 });
    expect(res.status).toBe(200);
    expect(access).toHaveBeenCalledWith('prod-eu', 'wr_placeholder_token');
    const { url, init } = sent();
    expect(url).toMatch(/\/api\/readiness\/start$/);
    expect((init.headers as Record<string, string>)['x-wr-dashboard-secret']).toBe('dash-secret');
    expect(JSON.parse(String(init.body))).toEqual({ fleet: 'prod-eu', sample: false, runs: 3, agent: 'support-bot', model: 'claude-haiku-4-5', startedBy: 'u1' });
  });

  it('R7: forwards the picked Fleet key key by its display prefix, and nothing that isn’t one', async () => {
    const prefix = `sk-wr-${'0'.repeat(15)}1`;
    await post(['start'], { fleet: 'prod-eu', sample: false, runs: 1, agent: 'support-bot', model: 'support-gpt4o-mini', proxyKeyDisplayPrefix: prefix });
    expect(JSON.parse(String(sent().init.body))).toEqual({ fleet: 'prod-eu', sample: false, runs: 1, agent: 'support-bot', model: 'support-gpt4o-mini', proxyKeyDisplayPrefix: prefix, startedBy: 'u1' });
    engine.mockClear();
    for (const bad of ['sk-wr-1a2b...', `sk-wr-${'0'.repeat(40)}`, 'sk-ant-placeholder', 7]) {
      expect((await post(['start'], { fleet: 'prod-eu', sample: false, runs: 1, agent: 'support-bot', proxyKeyDisplayPrefix: bad })).status).toBe(400);
    }
    expect(engine).not.toHaveBeenCalled();
  });

  it('refuses anyone who doesn’t own the fleet, before the engine is asked', async () => {
    access.mockResolvedValue({ status: 403, error: 'Only this fleet’s owner can change its controls and settings.' });
    const res = await get(undefined, 'fleet=prod-eu');
    expect(res.status).toBe(403);
    expect(engine).not.toHaveBeenCalled();
    auth.mockResolvedValue(null);
    expect((await get(undefined, 'fleet=prod-eu')).status).toBe(401);
    expect((await get(undefined, '')).status).toBe(400);
  });

  it('refuses cross-origin writes', async () => {
    sameOrigin.mockResolvedValue(Response.json({ error: 'Origin mismatch.' }, { status: 403 }));
    expect((await post([RUN, 'end'], { fleet: 'prod-eu' })).status).toBe(403);
    expect(engine).not.toHaveBeenCalled();
  });

  it('routes reads and writes by run, and nothing else', async () => {
    await get([RUN, 'report'], 'fleet=prod-eu');
    expect(sent().url).toMatch(new RegExp(`/api/readiness/runs/${RUN}/report\\?fleet=prod-eu$`));
    engine.mockClear();
    await post([RUN, 'code'], { fleet: 'prod-eu', code: 'x' });
    expect(JSON.parse(String(sent().init.body))).toEqual({ fleet: 'prod-eu' });
    expect((await get(['../claim'], 'fleet=prod-eu')).status).toBe(404);
    expect((await post([RUN, 'claim'], { fleet: 'prod-eu' })).status).toBe(404);
    expect((await post(['start'], { fleet: 'prod-eu', sample: false, runs: 2 })).status).toBe(400);
  });

  it('passes the engine’s refusal through, and says so when practice tests aren’t set up', async () => {
    engine.mockResolvedValue(Response.json({ error: 'You can start more tomorrow (00:00 UTC).', reason: 'starts_today' }, { status: 429 }));
    const res = await post(['start'], { fleet: 'prod-eu', sample: true, runs: 1 });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'You can start more tomorrow (00:00 UTC).', reason: 'starts_today' });
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', '');
    expect((await get(undefined, 'fleet=prod-eu')).status).toBe(503);
  });

  it('refuses a body over 16 KiB without reading past it, with or without Content-Length', async () => {
    const big = JSON.stringify({ fleet: 'prod-eu', pad: 'x'.repeat(20_000) });
    expect((await POST(new Request('https://app.example/x', { method: 'POST', body: big, headers: { 'content-length': String(big.length) } }), ctx(['start']))).status).toBe(413);
    const chunked = new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1024))); c.close(); } });
    expect((await POST(new Request('https://app.example/x', { method: 'POST', body: chunked, duplex: 'half' } as RequestInit), ctx(['start']))).status).toBe(413);
    expect(engine).not.toHaveBeenCalled();
  });

  it('asks for the agent’s latest model only with a sane agent name', async () => {
    expect((await get(['source-model'], 'fleet=prod-eu')).status).toBe(400);
    expect((await get(['source-model'], `fleet=prod-eu&agent=${'a'.repeat(129)}`)).status).toBe(400);
    await get(['source-model'], 'fleet=prod-eu&agent=support%20bot');
    expect(sent().url).toMatch(/\/api\/readiness\/source-model\?fleet=prod-eu&agent=support%20bot$/);
  });

  it('never passes an unreadable engine answer on as a success, and bounds names like the engine', async () => {
    engine.mockResolvedValue(new Response('<html>proxy page</html>', { status: 200 }));
    expect((await get([RUN], 'fleet=prod-eu')).status).toBe(502);
    engine.mockClear();
    expect((await post(['start'], { fleet: 'prod-eu', sample: false, runs: 1, agent: 'a'.repeat(129) })).status).toBe(400);
    expect((await post(['start'], { fleet: 'prod-eu', sample: false, runs: 1, agent: 'bot', scope: Array(65).fill('a.result') })).status).toBe(400);
    expect(engine).not.toHaveBeenCalled();
  });

  describe('practice tests off on the engine', () => {
    const OFF = { error: 'Practice tests aren’t available yet.', reason: 'practice_unavailable' };

    it('the engine router with the feature off (current and older wording): one calm answer, never the engine’s words', async () => {
      for (const error of ["Practice tests aren't available yet. Try again later.", "Practice tests aren't available on this WhiteRoom server yet.", "Readiness tests aren't available on this WhiteRoom server yet."]) {
        engine.mockResolvedValue(Response.json({ error }, { status: 404 }));
        for (const res of [await get(undefined, 'fleet=prod-eu'), await get([RUN], 'fleet=prod-eu'), await post(['start'], { fleet: 'prod-eu', sample: true, runs: 1 })]) {
          expect(res.status).toBe(404);
          const body = await res.json();
          expect(body).toEqual(OFF);
          expect(JSON.stringify(body)).not.toMatch(/readiness/i);
        }
      }
    });

    it('an engine without the practice routes (its plain-text 404 page) reads the same', async () => {
      engine.mockResolvedValue(new Response('404 Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } }));
      const res = await get(undefined, 'fleet=prod-eu');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(OFF);
    });

    it('no dashboard secret set: unavailable too', async () => {
      vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', '');
      const res = await get(undefined, 'fleet=prod-eu');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(OFF);
    });

    it('with the feature on, a 404 for a run or fleet still passes through as it is', async () => {
      for (const error of ['Not found.', 'Fleet not found.']) {
        engine.mockResolvedValue(Response.json({ error }, { status: 404 }));
        const res = await get([RUN], 'fleet=prod-eu');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error });
      }
      // Only a 404 means off: an unreadable answer otherwise is still a 502.
      engine.mockResolvedValue(new Response('Service Unavailable', { status: 503 }));
      expect((await get([RUN], 'fleet=prod-eu')).status).toBe(502);
    });

    it('engineUnavailable: 404 and either not JSON or the router’s off message', () => {
      expect(engineUnavailable(404, null)).toBe(true);
      expect(engineUnavailable(404, 'text')).toBe(true);
      expect(engineUnavailable(404, { error: "Practice tests aren't available yet. Try again later." })).toBe(true);
      expect(engineUnavailable(404, { error: "Practice tests aren't available on this WhiteRoom server yet." })).toBe(true);
      expect(engineUnavailable(404, { error: 'Not found.' })).toBe(false);
      expect(engineUnavailable(404, {})).toBe(false);
      expect(engineUnavailable(409, { error: "Practice tests aren't available on this WhiteRoom server yet." })).toBe(false);
      expect(engineUnavailable(200, null)).toBe(false);
    });

    it('the browser side: unavailable is its own state and is never retried', () => {
      const off = new PracticeError(OFF.error, 503, OFF.reason);
      expect(unavailable(off)).toBe(true);
      expect(retryable(off)).toBe(false);
      expect(unavailable(new PracticeError('Not found.', 404))).toBe(false);
      expect(unavailable(new Error('x'))).toBe(false);
      expect(retryable(new PracticeError('Server error.', 503))).toBe(true);
    });
  });
});
