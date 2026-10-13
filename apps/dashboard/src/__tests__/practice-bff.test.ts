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
});
