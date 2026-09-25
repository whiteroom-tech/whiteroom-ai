// The /api/fleet/session route: origin enforcement, cookie semantics, and
// the engine-verdict mapping (401 = credential rejected, 502 = retryable).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockHeaders = vi.fn();

interface SetCall {
  name: string;
  value: string;
  options: Record<string, unknown>;
}
let jar: Map<string, string>;
let setCalls: SetCall[];
const fakeCookieStore = {
  get: (name: string) =>
    jar.has(name) ? { name, value: jar.get(name)! } : undefined,
  set: (name: string, value: string, options: Record<string, unknown>) => {
    jar.set(name, value);
    setCalls.push({ name, value, options });
  },
  delete: (name: string) => {
    jar.delete(name);
  },
};

vi.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: async () => fakeCookieStore,
}));

const mockTokenLogin = vi.fn();
vi.mock('@/lib/whiteroom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whiteroom/client')>();
  return { ...actual, tokenLogin: (...args: unknown[]) => mockTokenLogin(...args) };
});

// The signed-in next-auth user, or null for a raw token login. The fleet
// cookie is bound to whoever this is when it's minted.
const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock('@/auth', () => ({ auth: async () => session.current }));

const mockGetUserFleets = vi.fn();
vi.mock('@/lib/user-fleets', () => ({
  getUserFleets: () => mockGetUserFleets(),
}));

import { WhiteRoomApiError } from '@/lib/whiteroom/client';
import { DELETE, GET, POST } from '@/app/api/fleet/session/route';

const HOST = 'app.whiteroom.ai';

function fakeHeaders(origin: string | null, host: string | null = HOST) {
  mockHeaders.mockResolvedValue(new Map([['origin', origin], ['host', host]]));
}

function postReq(body: unknown) {
  return new Request(`https://${HOST}/api/fleet/session`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  jar = new Map();
  setCalls = [];
  session.current = null;
  fakeHeaders(`https://${HOST}`);
  mockGetUserFleets.mockResolvedValue([]);
});

describe('POST /api/fleet/session', () => {
  it('rejects cross-origin requests before touching the engine', async () => {
    fakeHeaders('https://evil.com');
    const res = await POST(postReq({ token: 'ft-123' }));
    expect(res.status).toBe(403);
    expect(mockTokenLogin).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });

  it('rejects a missing origin header', async () => {
    fakeHeaders(null);
    const res = await POST(postReq({ token: 'ft-123' }));
    expect(res.status).toBe(403);
    expect(setCalls).toHaveLength(0);
  });

  it('sets the httpOnly cookie and returns only the fleet id on success', async () => {
    mockTokenLogin.mockResolvedValue({ success: true, fleetId: 'fleet-1' });
    const res = await POST(postReq({ token: 'ft-123' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ fleetId: 'fleet-1' });
    // The token must never come back in the response body.
    expect(JSON.stringify(body)).not.toContain('ft-123');

    expect(setCalls.map((c) => c.name)).toEqual(['wr_fleet_auth', 'wr_fleet_auth_owner']);
    const cookie = setCalls[0];
    expect(cookie.name).toBe('wr_fleet_auth');
    expect(cookie.value).toBe('ft-123');
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe('lax');
    expect(cookie.options.path).toBe('/');
  });

  it('returns 401 (no cookie) when the engine rejects the token', async () => {
    mockTokenLogin.mockRejectedValue(new WhiteRoomApiError('HTTP 401', 401));
    const res = await POST(postReq({ token: 'bad-token' }));
    expect(res.status).toBe(401);
    expect(setCalls).toHaveLength(0);
  });

  it('returns a distinguishable 502 when the engine is unreachable', async () => {
    mockTokenLogin.mockRejectedValue(new WhiteRoomApiError('fetch failed'));
    const res = await POST(postReq({ token: 'ft-123' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ retryable: true });
    expect(setCalls).toHaveLength(0);
  });

  it('returns 400 for a missing token', async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    expect(mockTokenLogin).not.toHaveBeenCalled();
  });
});

describe('GET /api/fleet/session', () => {
  it('validates the cookie token and reports the fleet id', async () => {
    jar.set('wr_fleet_auth', 'ft-cookie');
    mockTokenLogin.mockResolvedValue({ success: true, fleetId: 'fleet-9' });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fleetId: 'fleet-9' });
    expect(mockTokenLogin).toHaveBeenCalledWith('ft-cookie');
  });

  it('401s when there is neither a cookie nor a linked fleet', async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('adopts the preferred (production over sandbox) linked fleet into the cookie', async () => {
    mockGetUserFleets.mockResolvedValue([
      { id: '1', fleet_token: 'ft-sandbox', fleet_id: 'sandbox-abc', label: 's', created_at: '' },
      { id: '2', fleet_token: 'ft-prod', fleet_id: 'prod-1', label: 'p', created_at: '' },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fleetId: 'prod-1' });
    expect(setCalls[0]).toMatchObject({ name: 'wr_fleet_auth', value: 'ft-prod' });
    // fleet_id was known from the DB row — no engine round-trip needed.
    expect(mockTokenLogin).not.toHaveBeenCalled();
  });

  it('propagates 502 (session kept) when the cookie cannot be verified', async () => {
    jar.set('wr_fleet_auth', 'ft-cookie');
    mockTokenLogin.mockRejectedValue(new WhiteRoomApiError('timeout'));
    const res = await GET();
    expect(res.status).toBe(502);
    // Cookie must survive a transient failure.
    expect(jar.has('wr_fleet_auth')).toBe(true);
  });
});

describe('DELETE /api/fleet/session', () => {
  it('is origin-checked', async () => {
    fakeHeaders('https://evil.com');
    jar.set('wr_fleet_auth', 'ft-cookie');
    const res = await DELETE();
    expect(res.status).toBe(403);
    expect(jar.has('wr_fleet_auth')).toBe(true);
  });

  it('clears the cookie and its owner', async () => {
    jar.set('wr_fleet_auth', 'ft-cookie');
    jar.set('wr_fleet_auth_owner', 'u-alice');
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(jar.has('wr_fleet_auth')).toBe(false);
    expect(jar.has('wr_fleet_auth_owner')).toBe(false);
  });
});

// A fleet cookie that outlives its sign-out must not be inherited by the
// next account to sign in on the same browser.
describe('fleet cookie ownership', () => {
  it('records the signed-in user as the owner', async () => {
    session.current = { user: { id: 'u-alice' } };
    mockTokenLogin.mockResolvedValue({ success: true, fleetId: 'fleet-1' });
    await POST(postReq({ token: 'ft-123' }));
    expect(jar.get('wr_fleet_auth_owner')).toBe('u-alice');
  });

  it('records a raw token login as anonymous', async () => {
    mockTokenLogin.mockResolvedValue({ success: true, fleetId: 'fleet-1' });
    await POST(postReq({ token: 'ft-123' }));
    expect(jar.get('wr_fleet_auth_owner')).toBe('anon');
  });

  it('ignores a cookie minted for someone else and serves the current user\'s own fleet', async () => {
    jar.set('wr_fleet_auth', 'ft-alice');
    jar.set('wr_fleet_auth_owner', 'u-alice');
    session.current = { user: { id: 'u-bob' } };
    mockGetUserFleets.mockResolvedValue([
      { id: '1', fleet_token: 'ft-bob', fleet_id: 'bob-1', label: 'b', created_at: '' },
    ]);

    const res = await GET();
    expect(await res.json()).toEqual({ fleetId: 'bob-1' });
    expect(mockTokenLogin).not.toHaveBeenCalledWith('ft-alice');
    // Bob's fleet replaces Alice's cookie, now owned by Bob.
    expect(jar.get('wr_fleet_auth')).toBe('ft-bob');
    expect(jar.get('wr_fleet_auth_owner')).toBe('u-bob');
  });

  it('401s rather than serving a stranger\'s fleet when the user has none of their own', async () => {
    jar.set('wr_fleet_auth', 'ft-alice');
    jar.set('wr_fleet_auth_owner', 'u-alice');
    session.current = { user: { id: 'u-bob' } };
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockTokenLogin).not.toHaveBeenCalled();
  });

  it('ignores an anonymous cookie once someone is signed in', async () => {
    jar.set('wr_fleet_auth', 'ft-anon');
    jar.set('wr_fleet_auth_owner', 'anon');
    session.current = { user: { id: 'u-bob' } };
    expect((await GET()).status).toBe(401);
  });

  it('keeps honouring the owner\'s own cookie', async () => {
    jar.set('wr_fleet_auth', 'ft-alice');
    jar.set('wr_fleet_auth_owner', 'u-alice');
    session.current = { user: { id: 'u-alice' } };
    mockTokenLogin.mockResolvedValue({ success: true, fleetId: 'fleet-a' });
    expect(await (await GET()).json()).toEqual({ fleetId: 'fleet-a' });
  });

  // Cookies minted before owners were recorded.
  it('treats a pre-existing cookie as anonymous: kept for token logins, not for a signed-in user', async () => {
    jar.set('wr_fleet_auth', 'ft-legacy');
    mockTokenLogin.mockResolvedValue({ success: true, fleetId: 'fleet-l' });
    expect(await (await GET()).json()).toEqual({ fleetId: 'fleet-l' });

    session.current = { user: { id: 'u-bob' } };
    mockTokenLogin.mockClear();
    expect((await GET()).status).toBe(401);
    expect(mockTokenLogin).not.toHaveBeenCalled();
  });
});
