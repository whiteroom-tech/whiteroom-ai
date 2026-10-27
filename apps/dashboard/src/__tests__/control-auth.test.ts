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

import { randomBytes } from 'node:crypto';
import { sealCred } from '@/lib/cred-seal';
import { recordLegacyFleetIds } from '@/lib/control-auth';
import { controlAccessError, controlActionOf, credentialGrant, DASHBOARD_ONLY_ACTIONS, fleetOwner } from '@/lib/control-auth';
import { WhiteRoomApiError } from '@/lib/whiteroom/client';
import { POST } from '@/app/api/fleet/engine/route';

const body = (b: Record<string, unknown>) => JSON.stringify(b);

type Held = { token: string; fleetId: string | null };
type Holder = { userId: string; provisioned: boolean; since: number; fleetId?: string | null; token?: string };
/**
 * Answers the access check's queries: the account's rows, then the fleet's
 * holders. Tokens are stored plain here, as D1 rows still are; the sealed
 * case has its own test.
 */
function fakeDb(held: Held[], holders: Holder[] = [{ userId: 'u1', provisioned: true, since: 1 }]) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE')) return { rows: [] };
    if (sql.includes('extract(epoch')) {
      return { rows: holders.map((h) => ({ table: 'user_fleets', ...h, fleetId: h.fleetId === undefined ? 'f1' : h.fleetId, plain: h.token ?? null, sealed: null })) };
    }
    return { rows: held.map((h, i) => ({ table: 'user_fleets', rowId: `r${i}`, plain: h.token, sealed: null, fleetId: h.fleetId })) };
  });
}

describe('controlActionOf', () => {
  it('picks out exactly the dashboard-only actions', () => {
    expect([...DASHBOARD_ONLY_ACTIONS].sort()).toEqual(
      ['agent_budget_set', 'agent_new_run', 'alerts_get', 'alerts_set_slack', 'alerts_set_teams', 'alerts_test', 'compression_mode_set', 'compression_preview', 'delete_bedrock_role', 'deregister_agent', 'fleet_data_settings_get', 'fleet_data_settings_set', 'goal_get', 'goal_set_owner', 'governance_create_rule', 'governance_delete_rule', 'governance_update_rule', 'pause_agent', 'rebind_fleet_key', 'resume_agent', 'rotate_proxy_keys', 'stop_agent', 'store_bedrock_role'],
    );
    // A key on the engine's cloud identity is the owner's to mint; any other key isn't a control action.
    expect(controlActionOf(body({ action: 'store_key', fleet_id: 'f1', provider: 'bedrock-sigv4' }))).toEqual({ action: 'store_key', fleetId: 'f1' });
    expect(controlActionOf(body({ action: 'store_key', fleet_id: 'f1', provider: 'foundry-entra' }))).toEqual({ action: 'store_key', fleetId: 'f1' });
    expect(controlActionOf(body({ action: 'store_key', fleet_id: 'f1', provider: 'azure-openai' }))).toBeNull();
    expect(controlActionOf(body({ action: 'store_key', fleet_id: 'f1' }))).toBeNull();
    expect(controlActionOf(body({ action: 'store_key', fleet_id: 'f1', provider: ' Bedrock-SigV4 ' }))).toEqual({ action: 'store_key', fleetId: 'f1' });
    expect(controlActionOf(body({ action: 'store_key', fleet_id: 'f1', provider: ['bedrock-sigv4'] }))).toBeNull();
    expect(controlActionOf(body({ action: 'pause_agent', fleet_id: 'f1' }))).toEqual({ action: 'pause_agent', fleetId: 'f1' });
    // Removing an agent is an owner's call, like a hold.
    expect(controlActionOf(body({ action: 'deregister_agent', fleet_id: 'f1', agent_id: 'a' }))).toEqual({ action: 'deregister_agent', fleetId: 'f1' });
    // An agent's budget is its owner's to set.
    expect(controlActionOf(body({ action: 'agent_budget_set', fleet_id: 'f1', agent_id: 'a', budget_usd: 5 }))).toEqual({ action: 'agent_budget_set', fleetId: 'f1' });
    expect(controlActionOf(body({ action: 'agent_budgets_get', fleet_id: 'f1' }))).toBeNull();
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
    expect(mocks.query.mock.calls[0][1]).toEqual(['u1']);
    expect(mocks.tokenLogin).not.toHaveBeenCalled();
  });

  it('matches a token stored only encrypted (credentials-at-rest D2)', async () => {
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    signedIn();
    const sealed = sealCred('user_fleets.fleet_token', 'u1', 'tok');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('extract(epoch')) return { rows: [{ table: 'user_fleets', userId: 'u1', provisioned: false, since: 1, fleetId: null, plain: null, sealed }] };
      return { rows: [{ table: 'user_fleets', rowId: 'r0', plain: null, sealed, fleetId: 'f1' }] };
    });
    expect(await controlAccessError('f1', 'tok')).toBeNull();
    expect(await controlAccessError('f1', 'other')).toMatchObject({ status: 403 });
    vi.unstubAllEnvs();
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
    expect(updates).toEqual([['UPDATE user_fleets SET fleet_id = $2 WHERE id = $1 AND fleet_id IS NULL', ['r0', 'f1']]]);
  });

  it('counts holders by fleet id or, for rows without one, by this fleet’s token', async () => {
    signedIn();
    // An earlier account's fleet-id-less row holding this fleet's token outranks the caller.
    fakeDb([{ token: 'tok', fleetId: 'f1' }], [
      { userId: 'u-other-fleet', provisioned: false, since: 1, fleetId: null, token: 'not-this-fleet' },
      { userId: 'u-legacy', provisioned: false, since: 2, fleetId: null, token: 'tok' },
      { userId: 'u1', provisioned: false, since: 3 },
    ]);
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403, error: expect.stringMatching(/Only this fleet’s owner/) });
    const [, params] = mocks.query.mock.calls.find(([q]) => String(q).includes('extract(epoch'))!;
    expect(params).toEqual(['f1']);
  });

  it('records a users row’s fleet id too, by row id', async () => {
    signedIn();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE')) return { rows: [] };
      if (sql.includes('extract(epoch')) return { rows: [{ table: 'users', userId: 'u1', provisioned: true, since: 1, fleetId: 'f1', plain: null, sealed: null }] };
      return { rows: [
        { table: 'users', rowId: 'u1', plain: 'tok', sealed: null, fleetId: null },
        { table: 'user_fleets', rowId: 'r9', plain: 'tok', sealed: null, fleetId: null },
        { table: 'user_fleets', rowId: 'r8', plain: 'other', sealed: null, fleetId: null },
      ] };
    });
    mocks.tokenLogin.mockResolvedValue({ success: true, fleetId: 'f1' });
    expect(await controlAccessError('f1', 'tok')).toBeNull();
    const updates = mocks.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE'));
    expect(updates).toEqual([
      ['UPDATE users SET fleet_id = $2 WHERE id = $1 AND fleet_id IS NULL', ['u1', 'f1']],
      ['UPDATE user_fleets SET fleet_id = $2 WHERE id = $1 AND fleet_id IS NULL', ['r9', 'f1']],
    ]);
  });

  it('refuses when nobody can be shown to own the fleet, and fails closed if the owner lookup fails', async () => {
    signedIn();
    fakeDb([{ token: 'tok', fleetId: 'f1' }], []);
    expect(await controlAccessError('f1', 'tok')).toMatchObject({ status: 403 });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('extract(epoch')) throw new Error('db down');
      return { rows: [{ table: 'user_fleets', rowId: 'r0', plain: 'tok', sealed: null, fleetId: 'f1' }] };
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
    mocks.auth.mockReset().mockResolvedValue(null);
    mocks.query.mockReset();
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'dash-secret');
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

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

  it('refuses a non-owner the credential actions and a cloud-identity key, before reaching the engine', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    // u1 holds the fleet but linked it after the account that provisioned it.
    fakeDb([{ token: 'wr_fleet_token', fleetId: 'f1' }], [
      { userId: 'u-owner', provisioned: true, since: 1 },
      { userId: 'u1', provisioned: false, since: 2 },
    ]);
    for (const b of [
      { action: 'rebind_fleet_key', fleet_id: 'f1', new_api_key: 'sk-wr-new-key-123' },
      { action: 'rotate_proxy_keys', fleet_id: 'f1' },
      { action: 'store_bedrock_role', fleet_id: 'f1' },
      { action: 'delete_bedrock_role', fleet_id: 'f1' },
      { action: 'store_key', fleet_id: 'f1', provider: 'foundry-entra' },
    ]) {
      const res = await call(b);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'control_denied', error: expect.stringMatching(/Only this fleet’s owner/) });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // An ordinary key is not an owner's action.
    expect((await call({ action: 'store_key', fleet_id: 'f1', provider: 'azure-openai', api_key: 'k' })).status).toBe(200);
  });

  it('adds the secret for a linked, signed-in user', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    fakeDb([{ token: 'wr_fleet_token', fleetId: 'f1' }]);
    expect((await call({ action: 'governance_update_rule', fleet_id: 'f1', rule_id: 'r' })).status).toBe(200);
    expect(sentHeaders()['x-wr-dashboard-secret']).toBe('dash-secret');
    // So the engine records who acted, not just "dashboard".
    expect(sentHeaders()['x-wr-dashboard-user']).toBe('u1');
  });

  it('names the user on ordinary actions by signature only, so the engine rate-limits per user', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'user-1' } });
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'test-dashboard-secret');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(29_000_000 * 60_000 + 5_000);
    await call({ action: 'fleet_report', fleet_id: 'f1' });
    expect(sentHeaders()['x-wr-dashboard-secret']).toBeUndefined();
    expect(sentHeaders()['x-wr-dashboard-user']).toBe('user-1');
    // The engine's rateLimitUserSig for the same secret and id (engine rate-limit test pins it too).
    expect(sentHeaders()['x-wr-dashboard-user-sig']).toBe('1ff71fe9070decd59b9af8e54f93f1c55df9c4d5ebdca305214c1b30cc5ef698');
  });

  it('names no one for a session with only a fleet cookie, which isn’t checked here and mustn’t mint buckets', async () => {
    mocks.auth.mockResolvedValue(null);
    await call({ action: 'fleet_report', fleet_id: 'f1' });
    expect(sentHeaders()['x-wr-dashboard-user']).toBeUndefined();
    expect(sentHeaders()['x-wr-dashboard-user-sig']).toBeUndefined();
  });

  it('names no one without the service secret', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', '');
    await call({ action: 'fleet_report', fleet_id: 'f1' });
    expect(sentHeaders()['x-wr-dashboard-user-sig']).toBeUndefined();
  });

  it('refuses a token the account doesn’t hold for that fleet, before reaching the engine', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockResolvedValue({ rows: [] });
    const res = await call({ action: 'pause_agent', fleet_id: 'fleet-a', agent_id: 'a' });
    expect(res.status).toBe(403);
    expect(mocks.query.mock.calls[0][1]).toEqual(['u1']);
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

describe('recordLegacyFleetIds', () => {
  beforeEach(() => { mocks.query.mockReset(); mocks.tokenLogin.mockReset(); });

  it('saves the engine-verified fleet id on users and user_fleets rows saved without one', async () => {
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE')) return { rows: [] };
      return { rows: [
        { table: 'users', rowId: 'u1', userId: 'u1', plain: null, sealed: sealCred('users.fleet_token', 'u1', 'tok-a') },
        { table: 'user_fleets', rowId: 'r2', userId: 'u2', plain: 'tok-b', sealed: null },
        { table: 'user_fleets', rowId: 'r3', userId: 'u3', plain: 'tok-dead', sealed: null },
        { table: 'user_fleets', rowId: 'r4', userId: 'u4', plain: null, sealed: sealCred('user_fleets.fleet_token', 'someone-else', 'x') },
      ] };
    });
    mocks.tokenLogin.mockImplementation(async (t: string) => {
      if (t === 'tok-dead') throw new WhiteRoomApiError('HTTP 401', 401);
      return { success: true, fleetId: t === 'tok-a' ? 'fa' : 'fb' };
    });
    expect(await recordLegacyFleetIds()).toBe(2);
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE'))).toEqual([
      ['UPDATE users SET fleet_id = $2 WHERE id = $1 AND fleet_id IS NULL', ['u1', 'fa']],
      ['UPDATE user_fleets SET fleet_id = $2 WHERE id = $1 AND fleet_id IS NULL', ['r2', 'fb']],
    ]);
    // An undecryptable row never reaches the engine.
    expect(mocks.tokenLogin).toHaveBeenCalledTimes(3);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
});
