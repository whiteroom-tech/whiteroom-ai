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

    expect(setCalls).toHaveLength(1);
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
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].value).toBe('ft-prod');
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

  it('clears the cookie', async () => {
    jar.set('wr_fleet_auth', 'ft-cookie');
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(jar.has('wr_fleet_auth')).toBe(false);
  });
});
