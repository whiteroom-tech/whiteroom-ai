import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  auth: vi.fn(),
  cookie: vi.fn(),
  origin: vi.fn(),
  tokenLogin: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/origin-check', () => ({ checkSameOrigin: mocks.origin }));
vi.mock('@/lib/whiteroom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whiteroom/client')>()),
  tokenLogin: mocks.tokenLogin,
}));
vi.mock('@/lib/fleet-session', () => ({
  getFleetAuthCookie: mocks.cookie,
  setFleetAuthCookie: vi.fn(),
  tokenFromUserFleets: async () => null,
}));

import { controlAccessError, controlActionOf, credentialGrant, DASHBOARD_ONLY_ACTIONS, fleetOwner } from '@/lib/control-auth';
import { WhiteRoomApiError } from '@/lib/whiteroom/client';
import { POST } from '@/app/api/fleet/engine/route';

const body = (b: Record<string, unknown>) => JSON.stringify(b);

type Held = { token: string; fleetId: string | null };
type Holder = { userId: string; provisioned: boolean; since: number };
/** Answers the access check's queries: the account's held tokens, then the fleet's holders. */
function fakeDb(held: Held[], holders: Holder[] = [{ userId: 'u1', provisioned: true, since: 1 }]) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE')) return { rows: [] };
    if (sql.includes('extract(epoch')) return { rows: holders };
    return { rows: held };
  });
}

describe('controlActionOf', () => {
  it('picks out exactly the dashboard-only actions', () => {
    expect([...DASHBOARD_ONLY_ACTIONS].sort()).toEqual(
      ['agent_new_run', 'alerts_get', 'alerts_set_slack', 'alerts_test', 'compression_mode_set', 'fleet_data_settings_get', 'fleet_data_settings_set', 'goal_get', 'goal_set_owner', 'governance_create_rule', 'governance_delete_rule', 'governance_update_rule', 'pause_agent', 'resume_agent', 'stop_agent'],
    );
    expect(controlActionOf(body({ action: 'pause_agent', fleet_id: 'f1' }))).toEqual({ action: 'pause_agent', fleetId: 'f1' });
    expect(controlActionOf(body({ action: 'fleet_report', fleet_id: 'f1' }))).toBeNull();
    expect(controlActionOf('not json')).toBeNull();
    expect(controlActionOf(body({ action: 'governance_create_rule' }))).toEqual({ action: 'governance_create_rule', fleetId: null });
  });
});

describe('credentialGrant', () => {
  it('matches token and fleet together; a row without a fleet id needs the engine', () => {
    expect(credentialGrant([{ token: 't', fleetId: 'f1' }], 'f1', 't')).toBe('linked');
    expect(credentialGrant([{ token: 't', fleetId: 'f1' }], 'f2', 't')).toBe('none');
    expect(credentialGrant([{ token: 'other', fleetId: 'f1' }], 'f1', 't')).toBe('none');
    expect(credentialGrant([{ token: 't', fleetId: null }], 'f1', 't')).toBe('unknown-fleet');
    expect(credentialGrant([{ token: 't', fleetId: null }, { token: 't', fleetId: 'f1' }], 'f1', 't')).toBe('linked');
    expect(credentialGrant([], 'f1', 't')).toBe('none');
  });
});

describe('fleetOwner', () => {
  const h = (userId: string, provisioned: boolean, since: number) => ({ userId, provisioned, since });
  it('is the provisioning account, else the first to link, ties to the lower id', () => {
    expect(fleetOwner([h('late', false, 1), h('prov', true, 9)])).toBe('prov');
    expect(fleetOwner([h('b', false, 5), h('a', false, 3)])).toBe('a');
    expect(fleetOwner([h('z', false, 3), h('y', false, 3)])).toBe('y');
    expect(fleetOwner([])).toBeNull();
  });
});

describe('controlAccessError', () => {
  beforeEach(() => { mocks.query.mockReset(); mocks.auth.mockReset(); mocks.tokenLogin.mockReset(); });

  it('needs a signed-in WhiteRoom account (a pasted fleet key is not enough)', async () => {
    mocks.auth.mockResolvedValue(null);
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403, error: expect.stringMatching(/Sign in with your WhiteRoom account/) });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  const signedIn = () => mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
  const holds = (...rows: Held[]) => fakeDb(rows);

  it('allows the fleet token the account holds for that fleet, without asking the engine', async () => {
    signedIn();
    holds({ token: 'tok', fleetId: 'f1' });
    expect(await controlAccessError('f1', 'tok')).toBeNull();
    expect(mocks.query.mock.calls[0][1]).toEqual(['u1', 'tok']);
    expect(mocks.tokenLogin).not.toHaveBeenCalled();
  });

  it('refuses a token the account doesn’t hold', async () => {
    signedIn();
    holds();
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403, error: expect.stringMatching(/isn’t linked to this fleet/) });
    expect(mocks.tokenLogin).not.toHaveBeenCalled();
  });

  it('refuses the account’s token for a different fleet', async () => {
    signedIn();
    holds({ token: 'tok', fleetId: 'f1' });
    expect(await controlAccessError('f2', 'tok')).toMatchObject({ status: 403 });
    expect(mocks.tokenLogin).not.toHaveBeenCalled();
  });

  it('for a row saved without a fleet id, allows only the fleet the engine says the token is for', async () => {
    signedIn();
    holds({ token: 'tok', fleetId: null });
    mocks.tokenLogin.mockResolvedValue({ success: true, fleetId: 'f1' });
    expect(await controlAccessError('f1', 'tok')).toBeNull();
    expect(mocks.tokenLogin).toHaveBeenCalledWith('tok');
    expect(await controlAccessError('f2', 'tok')).toMatchObject({ status: 403 });
  });

  it('refuses a fleet-id-less row when the engine answers without confirming the fleet', async () => {
    signedIn();
    holds({ token: 'tok', fleetId: null });
    mocks.tokenLogin.mockResolvedValueOnce({ success: false, error: 'Invalid fleet token.' });
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403 });
    mocks.tokenLogin.mockResolvedValueOnce({ success: true });
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403 });
  });

  it('fails closed (503) when the engine errors on a fleet-id-less row', async () => {
    signedIn();
    holds({ token: 'tok', fleetId: null });
    mocks.tokenLogin.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 500', 500));
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 503 });
  });

  it('refuses an account that holds the fleet but isn’t its owner', async () => {
    signedIn();
    // An agent's own account that linked the fleet after the person who provisioned it.
    fakeDb([{ token: 'tok', fleetId: 'f1' }], [
      { userId: 'u-owner', provisioned: true, since: 100 },
      { userId: 'u1', provisioned: false, since: 50 },
    ]);
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403, error: expect.stringMatching(/Only this fleet’s owner/) });
  });

  it('allows the account that linked the fleet first when nobody provisioned it', async () => {
    signedIn();
    fakeDb([{ token: 'tok', fleetId: 'f1' }], [
      { userId: 'u-later', provisioned: false, since: 200 },
      { userId: 'u1', provisioned: false, since: 100 },
    ]);
    expect(await controlAccessError('f1', 'tok')).toBeNull();
  });

  it('records the engine-verified fleet id on a fleet-id-less row, then judges ownership with it', async () => {
    signedIn();
    fakeDb([{ token: 'tok', fleetId: null }], [{ userId: 'u1', provisioned: false, since: 1 }]);
    mocks.tokenLogin.mockResolvedValue({ success: true, fleetId: 'f1' });
    expect(await controlAccessError('f1', 'tok')).toBeNull();
    const updates = mocks.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE'));
    expect(updates.map(([, params]) => params)).toEqual([['u1', 'tok', 'f1'], ['u1', 'tok', 'f1']]);
  });

  it('counts holders by fleet id or, for rows without one, by this fleet’s token', async () => {
    signedIn();
    fakeDb([{ token: 'tok', fleetId: 'f1' }]);
    await controlAccessError('f1', 'tok');
    const [sql, params] = mocks.query.mock.calls.find(([q]) => String(q).includes('extract(epoch'))!;
    expect(params).toEqual(['f1', 'tok']);
    expect(String(sql).match(/fleet_id = \$1 OR \(fleet_id IS NULL AND fleet_token = \$2\)/g)).toHaveLength(2);
  });

  it('refuses when nobody can be shown to own the fleet, and fails closed if the owner lookup fails', async () => {
    signedIn();
    fakeDb([{ token: 'tok', fleetId: 'f1' }], []);
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403 });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('extract(epoch')) throw new Error('db down');
      return { rows: [{ token: 'tok', fleetId: 'f1' }] };
    });
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 503 });
  });

  it('never matches the account’s API key: only fleet tokens are held credentials', async () => {
    signedIn();
    holds();
    expect(await controlAccessError('f1', 'sk-ant-api-key')).toMatchObject({ status: 403 });
    expect(String(mocks.query.mock.calls[0][0])).not.toContain('api_key');
    expect(mocks.tokenLogin).not.toHaveBeenCalled();
  });

  it('refuses a fleet-id-less row when the engine rejects the token, and fails closed when it can’t be reached', async () => {
    signedIn();
    holds({ token: 'tok', fleetId: null });
    mocks.tokenLogin.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 401', 401));
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403 });
    mocks.tokenLogin.mockRejectedValueOnce(new Error('network'));
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 503 });
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
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'dash-secret');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

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
    // Marked so the client shows the reason instead of signing the user out.
    expect(await res.json()).toMatchObject({ code: 'control_denied', error: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds the secret for a linked, signed-in user', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    fakeDb([{ token: 'wr_fleet_token', fleetId: 'f1' }]);
    expect((await call({ action: 'governance_update_rule', fleet_id: 'f1', rule_id: 'r' })).status).toBe(200);
    expect(sentHeaders()['x-wr-dashboard-secret']).toBe('dash-secret');
    // So the engine records who acted, not just "dashboard".
    expect(sentHeaders()['x-wr-dashboard-user']).toBe('u1');
  });

  it('never sends a user on ordinary actions', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    await call({ action: 'fleet_report', fleet_id: 'f1' });
    expect(sentHeaders()['x-wr-dashboard-user']).toBeUndefined();
  });

  it('refuses a token the account doesn’t hold for that fleet, before reaching the engine', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockResolvedValue({ rows: [] });
    const res = await call({ action: 'pause_agent', fleet_id: 'fleet-a', agent_id: 'a' });
    expect(res.status).toBe(403);
    expect(mocks.query.mock.calls[0][1]).toEqual(['u1', 'wr_fleet_token']);
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
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', '');
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    fakeDb([{ token: 'wr_fleet_token', fleetId: 'f1' }]);
    await call({ action: 'resume_agent', fleet_id: 'f1', agent_id: 'a' });
    expect(sentHeaders()['x-wr-dashboard-secret']).toBeUndefined();
    expect(sentHeaders()['x-wr-dashboard-user']).toBeUndefined();
  });
});
