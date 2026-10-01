import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  auth: vi.fn(),
  cookie: vi.fn(),
  origin: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/origin-check', () => ({ checkSameOrigin: mocks.origin }));
vi.mock('@/lib/fleet-session', () => ({
  getFleetAuthCookie: mocks.cookie,
  setFleetAuthCookie: vi.fn(),
  tokenFromUserFleets: async () => null,
}));

import { controlAccessError, controlActionOf, DASHBOARD_ONLY_ACTIONS } from '@/lib/control-auth';
import { POST } from '@/app/api/fleet/engine/route';

const body = (b: Record<string, unknown>) => JSON.stringify(b);

describe('controlActionOf', () => {
  it('picks out exactly the dashboard-only actions', () => {
    expect([...DASHBOARD_ONLY_ACTIONS].sort()).toEqual(
      ['governance_create_rule', 'governance_delete_rule', 'governance_update_rule', 'pause_agent', 'resume_agent'],
    );
    expect(controlActionOf(body({ action: 'pause_agent', fleet_id: 'f1' }))).toEqual({ action: 'pause_agent', fleetId: 'f1' });
    expect(controlActionOf(body({ action: 'fleet_report', fleet_id: 'f1' }))).toBeNull();
    expect(controlActionOf('not json')).toBeNull();
    expect(controlActionOf(body({ action: 'governance_create_rule' }))).toEqual({ action: 'governance_create_rule', fleetId: null });
  });
});

describe('controlAccessError', () => {
  beforeEach(() => { mocks.query.mockReset(); mocks.auth.mockReset(); });

  it('needs a signed-in WhiteRoom account (a pasted fleet key is not enough)', async () => {
    mocks.auth.mockResolvedValue(null);
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403, error: expect.stringMatching(/Sign in with your WhiteRoom account/) });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('needs the account to be linked to that fleet', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await controlAccessError('someone-elses-fleet', 'tok')).toMatchObject({ status: 403, error: expect.stringMatching(/isn’t linked to this fleet/) });
    // The fleet and the forwarded token are checked together.
    expect(mocks.query.mock.calls[0][1]).toEqual(['u1', 'someone-elses-fleet', 'tok']);
  });

  it('accepts the account’s own API key and rows saved before fleet ids were recorded', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockResolvedValue({ rows: [] });
    await controlAccessError('f1', 'sk-key');
    const sql = String(mocks.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    // Sessions migrated from older logins can hold the fleet's API key.
    expect(sql).toContain('(fleet_token = $3 OR api_key = $3)');
    // The engine still checks the credential grants the body's fleet.
    expect(sql.match(/\(fleet_id = \$2 OR fleet_id IS NULL\)/g)).toHaveLength(2);
  });

  it('allows a linked account', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    expect(await controlAccessError('f1', 'tok')).toBeNull();
  });

  it('asks for a fleet_id', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    expect(await controlAccessError(null, 'tok')).toEqual({ status: 400, error: 'fleet_id is required.' });
  });

  it('fails closed when the lookup fails', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockRejectedValue(new Error('connection refused'));
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 503 });
  });
});

describe('the engine BFF', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response('{"success":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    mocks.origin.mockResolvedValue(null);
    mocks.cookie.mockResolvedValue('wr_fleet_token');
    mocks.auth.mockReset();
    mocks.query.mockReset();
    process.env.WR_DASHBOARD_SERVICE_SECRET = 'dash-secret';
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.WR_DASHBOARD_SERVICE_SECRET; });

  const call = (b: Record<string, unknown>) => POST(new Request('http://localhost/api/fleet/engine', { method: 'POST', body: body(b) }));
  const sentHeaders = () => fetchMock.mock.calls[0][1].headers as Record<string, string>;

  it('passes ordinary actions through without the dashboard secret', async () => {
    expect((await call({ action: 'fleet_report', fleet_id: 'f1' })).status).toBe(200);
    expect(sentHeaders()['x-wr-dashboard-secret']).toBeUndefined();
  });

  it('refuses a control action from a fleet-key-only session, before reaching the engine', async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await call({ action: 'pause_agent', fleet_id: 'f1', agent_id: 'a' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds the secret for a linked, signed-in user', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockResolvedValue({ rows: [{}] });
    expect((await call({ action: 'governance_update_rule', fleet_id: 'f1', rule_id: 'r' })).status).toBe(200);
    expect(sentHeaders()['x-wr-dashboard-secret']).toBe('dash-secret');
  });

  it('refuses a token the account doesn’t hold for that fleet, before reaching the engine', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockResolvedValue({ rows: [] });
    const res = await call({ action: 'pause_agent', fleet_id: 'fleet-a', agent_id: 'a' });
    expect(res.status).toBe(403);
    expect(mocks.query.mock.calls[0][1]).toEqual(['u1', 'fleet-a', 'wr_fleet_token']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a failed lookup with JSON 503, not an unhandled error', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockRejectedValue(new Error('db down'));
    const res = await call({ action: 'governance_delete_rule', fleet_id: 'f1', rule_id: 'r' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a control action with no fleet_id with 400', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    expect((await call({ action: 'pause_agent', agent_id: 'a' })).status).toBe(400);
  });

  it('forwards without the secret while it isn’t configured (old engines accept, new ones refuse)', async () => {
    delete process.env.WR_DASHBOARD_SERVICE_SECRET;
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockResolvedValue({ rows: [{}] });
    await call({ action: 'resume_agent', fleet_id: 'f1', agent_id: 'a' });
    expect(sentHeaders()['x-wr-dashboard-secret']).toBeUndefined();
  });
});
