// Sandbox v2's BFF (app/api/sandbox/fleet/[action]): same-origin, the signed-in
// owner of the production fleet only, only known fields forwarded with the
// dashboard secret, and nothing but the status (plus the once-shown Sandbox
// key) passed back. Placeholder keys only.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.fn();
const access = vi.fn();
const cookie = vi.fn();
const sameOrigin = vi.fn();
vi.mock('@/auth', () => ({ auth: () => auth() }));
vi.mock('@/lib/control-auth', () => ({ CONTROL_SECRET_HEADER: 'x-wr-dashboard-secret', CONTROL_USER_HEADER: 'x-wr-dashboard-user', controlAccessError: (...a: unknown[]) => access(...a) }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: () => cookie(), tokenFromUserFleets: async () => null }));
vi.mock('@/lib/origin-check', () => ({ checkSameOrigin: () => sameOrigin() }));

const { POST } = await import('@/app/api/sandbox/fleet/[action]/route');

const PROVIDER_KEY = 'sk-ant-placeholder-not-a-real-key-WXYZ';
const FLEET_TOKEN = 'wr_placeholder_fleet_token';
const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
const STATUS = {
  success: true, exists: true, sandboxFleetId: SANDBOX_ID, createdAt: '2026-10-29T10:00:00.000Z', lastCallAt: null, expiresAt: '2026-11-12T10:00:00.000Z',
  key: { prefix: 'sk-wr-0123456789abcdef...', provider: 'anthropic', keyHint: 'WXYZ' },
};
const ISSUED = { proxyKey: 'sk-wr-placeholder-proxy-key', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-proxy-key', provider: 'anthropic', keyHint: 'WXYZ' };

const engine = vi.fn();
const post = (action: string, body: unknown) =>
  POST(new Request(`https://app.example/api/sandbox/fleet/${action}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ action }) });
const sent = () => ({ url: String(engine.mock.calls[0][0]), init: engine.mock.calls[0][1] as RequestInit, body: JSON.parse(String((engine.mock.calls[0][1] as RequestInit).body)) });
const headersSent = () => sent().init.headers as Record<string, string>;

beforeEach(() => {
  vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'dash-secret');
  auth.mockResolvedValue({ user: { id: 'u1' } });
  access.mockReset().mockResolvedValue(null);
  cookie.mockResolvedValue(FLEET_TOKEN);
  sameOrigin.mockResolvedValue(null);
  engine.mockReset().mockResolvedValue(Response.json(STATUS));
  vi.stubGlobal('fetch', engine);
});

describe('Sandbox v2 BFF: who may ask', () => {
  it('refuses cross-origin requests before anything else', async () => {
    sameOrigin.mockResolvedValue(Response.json({ error: 'Origin mismatch.' }, { status: 403 }));
    expect((await post('status', { fleet: 'prod-eu' })).status).toBe(403);
    expect(access).not.toHaveBeenCalled();
    expect(engine).not.toHaveBeenCalled();
  });

  it('refuses signed-out users, non-owners and unknown actions, without asking the engine', async () => {
    auth.mockResolvedValue(null);
    expect((await post('status', { fleet: 'prod-eu' })).status).toBe(401);
    auth.mockResolvedValue({ user: { id: 'u1' } });
    access.mockResolvedValue({ status: 403, error: 'Only this fleet’s owner can change its controls and settings.' });
    expect((await post('connect', { fleet: 'prod-eu', provider: 'anthropic', api_key: PROVIDER_KEY })).status).toBe(403);
    expect(access).toHaveBeenCalledWith('prod-eu', FLEET_TOKEN);
    expect((await post('get', { fleet: 'prod-eu' })).status).toBe(404);
    expect((await post('destroy', { fleet: 'prod-eu' })).status).toBe(404);
    expect(engine).not.toHaveBeenCalled();
  });

  it('refuses a Sandbox fleet, a missing fleet and a bad body', async () => {
    expect((await post('status', { fleet: SANDBOX_ID })).status).toBe(400);
    expect((await post('status', {})).status).toBe(400);
    expect((await post('status', 'not json')).status).toBe(400);
    expect((await post('status', [1])).status).toBe(400);
    expect(engine).not.toHaveBeenCalled();
  });

  it('refuses an oversized body', async () => {
    expect((await post('connect', { fleet: 'prod-eu', api_key: 'x'.repeat(9000) })).status).toBe(413);
    expect(engine).not.toHaveBeenCalled();
  });

  it('refuses without a fleet credential', async () => {
    cookie.mockResolvedValue(null);
    expect((await post('status', { fleet: 'prod-eu' })).status).toBe(403);
    expect(engine).not.toHaveBeenCalled();
  });
});

describe('Sandbox v2 BFF: what goes to the engine', () => {
  it('status: the production fleet with its credential, the secret and the user', async () => {
    await post('status', { fleet: 'prod-eu', api_key: PROVIDER_KEY, extra: 1 });
    expect(sent().url).toMatch(/\/api\/white-room$/);
    expect(sent().body).toEqual({ action: 'sandbox_fleet_status', fleet_id: 'prod-eu' });
    expect(headersSent()['x-wr-dashboard-secret']).toBe('dash-secret');
    expect(headersSent()['x-wr-dashboard-user']).toBe('u1');
    expect(headersSent().Authorization).toBe(`Bearer ${FLEET_TOKEN}`);
  });

  it('connect: only the key just typed, its provider and a checked endpoint', async () => {
    engine.mockResolvedValue(Response.json({ ...STATUS, created: true, ...ISSUED }));
    await post('connect', { fleet: 'prod-eu', provider: 'anthropic', api_key: `  ${PROVIDER_KEY} `, sandbox_fleet_id: 'x', startedBy: 'u2' });
    expect(sent().body).toEqual({ action: 'sandbox_fleet_connect', fleet_id: 'prod-eu', provider: 'anthropic', api_key: PROVIDER_KEY });
    engine.mockClear();
    await post('connect', { fleet: 'prod-eu', provider: 'azure-openai', api_key: 'placeholder-azure-key', endpoint: 'https://acme.openai.azure.com/' });
    expect(sent().body).toEqual({ action: 'sandbox_fleet_connect', fleet_id: 'prod-eu', provider: 'azure-openai', api_key: 'placeholder-azure-key', endpoint: 'https://acme.openai.azure.com' });
  });

  it.each([
    ['a WhiteRoom key', { provider: 'anthropic', api_key: 'sk-wr-placeholder-proxy-key' }],
    ['a fleet token', { provider: 'openai', api_key: 'wr_placeholder_fleet_token' }],
    ['an OpenAI key as Anthropic', { provider: 'anthropic', api_key: 'sk-proj-placeholder' }],
    ['an Anthropic key as OpenAI', { provider: 'openai', api_key: PROVIDER_KEY }],
    ['no key', { provider: 'anthropic' }],
    ['an unknown provider', { provider: 'bedrock-sigv4', api_key: PROVIDER_KEY }],
    ['a cloud provider without its endpoint', { provider: 'foundry', api_key: 'placeholder-foundry-key' }],
  ])('connect refuses %s', async (_, body) => {
    expect((await post('connect', { fleet: 'prod-eu', ...body })).status).toBe(400);
    expect(engine).not.toHaveBeenCalled();
  });

  it('rotate and reset name the page’s Sandbox, and only a well-formed one', async () => {
    engine.mockResolvedValue(Response.json({ ...STATUS, ...ISSUED }));
    await post('rotate', { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(sent().body).toEqual({ action: 'sandbox_fleet_rotate', fleet_id: 'prod-eu', sandbox_fleet_id: SANDBOX_ID });
    engine.mockReset().mockResolvedValue(Response.json(STATUS));
    await post('reset', { fleet: 'prod-eu' });
    expect(sent().body).toEqual({ action: 'sandbox_fleet_reset', fleet_id: 'prod-eu' });
    engine.mockClear();
    expect((await post('reset', { fleet: 'prod-eu', sandboxFleetId: 'prod-eu' })).status).toBe(400);
    expect(engine).not.toHaveBeenCalled();
  });
});

describe('Sandbox v2 BFF: what comes back', () => {
  it('status: only the status fields, never a key or token the engine might add', async () => {
    engine.mockResolvedValue(Response.json({ ...STATUS, token: FLEET_TOKEN, api_key: PROVIDER_KEY, proxyKey: 'sk-wr-should-not-pass', key: { ...STATUS.key, apiKey: PROVIDER_KEY } }));
    const res = await post('status', { fleet: 'prod-eu' });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).not.toContain(FLEET_TOKEN);
    expect(text).not.toContain('should-not-pass');
    expect(JSON.parse(text)).toEqual(STATUS);
  });

  it('a key prefix that is longer than a display prefix is dropped', async () => {
    engine.mockResolvedValue(Response.json({ ...STATUS, key: { ...STATUS.key, prefix: `sk-wr-${'a'.repeat(48)}` } }));
    expect((await (await post('status', { fleet: 'prod-eu' })).json()).key).toBeNull();
  });

  it('connect: the Sandbox key once, and never the provider key', async () => {
    engine.mockResolvedValue(Response.json({ ...STATUS, created: true, ...ISSUED, api_key: PROVIDER_KEY }));
    const res = await post('connect', { fleet: 'prod-eu', provider: 'anthropic', api_key: PROVIDER_KEY });
    const text = await res.text();
    expect(text).not.toContain(PROVIDER_KEY);
    expect(JSON.parse(text)).toEqual({ ...STATUS, created: true, ...ISSUED });
  });

  it('an engine without Sandbox v2, or no secret, reads as unavailable', async () => {
    engine.mockResolvedValue(Response.json({ error: 'Unknown action.' }, { status: 400 }));
    let res = await post('status', { fleet: 'prod-eu' });
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe('sandbox_fleet_unavailable');
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', '');
    engine.mockClear();
    res = await post('status', { fleet: 'prod-eu' });
    expect((await res.json()).reason).toBe('sandbox_fleet_unavailable');
    expect(engine).not.toHaveBeenCalled();
  });

  it('passes the engine’s refusals on, and words its failures itself', async () => {
    engine.mockResolvedValue(Response.json({ error: 'This Sandbox has no key yet. Connect a provider key first.' }, { status: 409 }));
    let res = await post('rotate', { fleet: 'prod-eu' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no key yet/);
    engine.mockResolvedValue(Response.json({ error: 'internal detail' }, { status: 503 }));
    res = await post('rotate', { fleet: 'prod-eu' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).not.toContain('internal detail');
    engine.mockRejectedValue(new Error('down'));
    expect((await post('status', { fleet: 'prod-eu' })).status).toBe(502);
    engine.mockResolvedValue(new Response('not json', { status: 200 }));
    expect((await post('status', { fleet: 'prod-eu' })).status).toBe(502);
  });
});
