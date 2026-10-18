// The owner's credential remedies (P0 #1): only the fleet's owner gets to the
// engine, the new key and token are saved encrypted, other accounts' links go,
// cloud-identity keys need their own yes, and a lost answer is recovered.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), access: vi.fn(), cookie: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/fleet-session', () => ({ setFleetAuthCookie: mocks.cookie }));
vi.mock('@/lib/control-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/control-auth')>()),
  controlAccessError: mocks.access,
}));

import { openCred, sealCred } from '@/lib/cred-seal';
import { replaceProxyUrls, rotateApiKey } from '@/lib/owner-credentials';

const fetchMock = vi.fn();
const NEW_KEYS = [{ prefix: 'sk-wr-aaaaaaaaaaaaaaaa', provider: 'anthropic', keyHint: 'abcd', cloudIdentity: false, wrKey: 'sk-wr-' + 'a'.repeat(40), replaces: 'sk-wr-bbbbbbbbbbbbbbbb' }];
const sent = () => fetchMock.mock.calls.map(([, init]) => ({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) }));
const updates = () => mocks.query.mock.calls.filter(([sql]) => /^(UPDATE|DELETE)/.test(String(sql)));

beforeEach(() => {
  vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'dash-secret');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  mocks.query.mockReset();
  mocks.cookie.mockReset().mockResolvedValue(undefined);
  mocks.access.mockReset().mockResolvedValue(null);
  mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
  mocks.query.mockImplementation(async (sql: string) => {
    if (String(sql).startsWith('SELECT')) return { rows: [{ fleet_id: 'f1', fleet_token: null, fleet_token_enc: sealCred('users.fleet_token', 'u1', 'wr_old') }] };
    return { rows: [], rowCount: 1 };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('rotateApiKey', () => {
  it('stops at the owner check: a non-owner never reaches the engine', async () => {
    mocks.access.mockResolvedValue({ status: 403, error: 'Only this fleet’s owner can change its controls and settings.' });
    expect(await rotateApiKey({ disconnect: [], reissueCloudIdentityKeys: false })).toEqual({ ok: false, error: expect.stringMatching(/owner/) });
    expect(mocks.access).toHaveBeenCalledWith('f1', 'wr_old');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rebinds to a fresh key, saves the key and token encrypted only, drops other links and moves the session', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetToken: 'wr_new', proxyKeys: NEW_KEYS, disconnected: [] }));
    const result = await rotateApiKey({ disconnect: ['sk-wr-cccccccccccccccc', 'not-a-prefix'], reissueCloudIdentityKeys: false });
    if (!result.ok) throw new Error(result.error);
    expect(result.apiKey).toMatch(/^sk-wr-[0-9a-f]{64}$/);
    expect(result.proxyKeys).toEqual(NEW_KEYS);

    const [call] = sent();
    expect(call.body).toEqual({ action: 'rebind_fleet_key', new_api_key: result.apiKey, disconnect: ['sk-wr-cccccccccccccccc'], reissue_cloud_identity_keys: false, fleet_id: 'f1' });
    expect(call.headers).toMatchObject({ Authorization: 'Bearer wr_old', 'x-wr-dashboard-secret': 'dash-secret', 'x-wr-dashboard-user': 'u1' });

    const [save, drop] = updates();
    const params = save[1] as (string | null)[];
    expect([params[1], params[3]]).toEqual([null, null]);
    expect(openCred('users.api_key', 'u1', params[2]!)).toBe(result.apiKey);
    expect(openCred('users.fleet_token', 'u1', params[4]!)).toBe('wr_new');
    expect(drop).toEqual(['DELETE FROM user_fleets WHERE fleet_id = $1 AND user_id <> $2', ['f1', 'u1']]);
    expect(mocks.cookie).toHaveBeenCalledWith('wr_new');
  });

  it('asks for separate consent for cloud-identity keys, and saves nothing until given', async () => {
    const cloud = [{ prefix: 'sk-wr-dddddddddddddddd', provider: 'bedrock-sigv4', keyHint: 'none', cloudIdentity: true }];
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'confirm', cloudIdentityKeys: cloud }, { status: 409 }));
    expect(await rotateApiKey({ disconnect: [], reissueCloudIdentityKeys: false })).toEqual({ ok: false, error: 'confirm', cloudIdentityKeys: cloud });
    expect(updates()).toEqual([]);
    expect(mocks.cookie).not.toHaveBeenCalled();
  });

  it('recovers a lost answer with find_fleet and the new key, and says the URLs need replacing again', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(Response.json({ success: true, fleetId: 'f1', fleetToken: 'wr_recovered' }));
    const result = await rotateApiKey({ disconnect: [], reissueCloudIdentityKeys: false });
    if (!result.ok) throw new Error(result.error);
    expect(result).toMatchObject({ proxyKeys: [], proxyKeysLost: true });
    const [, find] = sent();
    expect(find.body).toEqual({ action: 'find_fleet', api_key: result.apiKey, fleet_id: 'f1' });
    expect(mocks.cookie).toHaveBeenCalledWith('wr_recovered');
  });

  it('changes nothing here when the engine never made the change', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(Response.json({ error: 'Fleet not found, or this credential isn’t valid for it.' }, { status: 401 }));
    expect(await rotateApiKey({ disconnect: [], reissueCloudIdentityKeys: false })).toMatchObject({ ok: false, error: expect.stringMatching(/nothing changed/) });
    expect(updates()).toEqual([]);
  });
});

describe('rotateApiKey when something after the engine fails', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const run = async () => {
    const p = rotateApiKey({ disconnect: [], reissueCloudIdentityKeys: false });
    await vi.runAllTimersAsync();
    return p;
  };

  it('a save that keeps failing still hands back the new key, marked as the only copy', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetToken: 'wr_new', proxyKeys: NEW_KEYS, disconnected: [] }));
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('SELECT')) return { rows: [{ fleet_id: 'f1', fleet_token: 'wr_old', fleet_token_enc: null }] };
      if (String(sql).startsWith('UPDATE')) throw new Error('db down');
      return { rows: [], rowCount: 1 };
    });
    const result = await run();
    expect(result).toMatchObject({ ok: true, apiKey: expect.stringMatching(/^sk-wr-/), proxyKeys: NEW_KEYS, notSaved: true });
    expect(mocks.query.mock.calls.filter(([q]) => String(q).startsWith('UPDATE'))).toHaveLength(3);
  });

  it('a cookie that fails to move doesn’t make a saved key look unsaved', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetToken: 'wr_new', proxyKeys: NEW_KEYS, disconnected: [] }));
    mocks.cookie.mockRejectedValue(new Error('headers already sent'));
    const result = await run();
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('notSaved');
    expect(mocks.query.mock.calls.filter(([q]) => String(q).startsWith('UPDATE'))).toHaveLength(1);
  });

  it('a save that fails once is retried and succeeds', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetToken: 'wr_new', proxyKeys: NEW_KEYS, disconnected: [] }));
    let failures = 1;
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('SELECT')) return { rows: [{ fleet_id: 'f1', fleet_token: 'wr_old', fleet_token_enc: null }] };
      if (String(sql).startsWith('UPDATE') && failures-- > 0) throw new Error('blip');
      return { rows: [], rowCount: 1 };
    });
    const result = await run();
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('notSaved');
    expect(mocks.cookie).toHaveBeenCalledWith('wr_new');
  });

  it('link cleanup is retried, and giving up still reports the rotation', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, fleetToken: 'wr_new', proxyKeys: NEW_KEYS, disconnected: [] }));
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('SELECT')) return { rows: [{ fleet_id: 'f1', fleet_token: 'wr_old', fleet_token_enc: null }] };
      if (String(sql).startsWith('DELETE')) throw new Error('db down');
      return { rows: [], rowCount: 1 };
    });
    expect(await run()).toMatchObject({ ok: true });
    expect(mocks.query.mock.calls.filter(([q]) => String(q).startsWith('DELETE'))).toHaveLength(3);
  });

  it('a 200 without a token is recovered like a lost answer, and missing key lists read as empty', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ success: true })).mockResolvedValueOnce(Response.json({ success: true, fleetToken: 'wr_found' }));
    mocks.query.mockImplementation(async (sql: string) => String(sql).startsWith('SELECT') ? { rows: [{ fleet_id: 'f1', fleet_token: 'wr_old', fleet_token_enc: null }] } : { rows: [], rowCount: 1 });
    expect(await run()).toMatchObject({ ok: true, proxyKeys: [], disconnected: [], proxyKeysLost: true });
    expect(mocks.cookie).toHaveBeenCalledWith('wr_found');
  });
});

describe('who may rotate', () => {
  it('no session, no fleet, or no service secret: nothing reaches the engine', async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect(await rotateApiKey({ disconnect: [], reissueCloudIdentityKeys: false })).toMatchObject({ ok: false, error: expect.stringMatching(/Sign in/) });
    mocks.query.mockResolvedValueOnce({ rows: [{ fleet_id: null, fleet_token: null, fleet_token_enc: null }] });
    expect(await rotateApiKey({ disconnect: [], reissueCloudIdentityKeys: false })).toMatchObject({ ok: false, error: expect.stringMatching(/no fleet/) });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', '');
    expect(await replaceProxyUrls({ disconnect: [], reissueCloudIdentityKeys: false })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('disconnect list', () => {
  it('passes only well-formed prefixes, at most 100', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, proxyKeys: [], disconnected: [] }));
    const prefixes = Array.from({ length: 150 }, (_, i) => `sk-wr-${i.toString(16).padStart(16, '0')}`);
    await replaceProxyUrls({ disconnect: [...prefixes, 'sk-wr-short', 'not-a-key'], reissueCloudIdentityKeys: false });
    const sentList = sent()[0].body.disconnect as string[];
    expect(sentList).toHaveLength(100);
    expect(sentList.every((p) => /^sk-wr-[0-9a-f]{16}$/.test(p))).toBe(true);
  });
});

describe('replaceProxyUrls', () => {
  it('replaces the proxy URLs only: nothing saved, the session untouched', async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true, proxyKeys: NEW_KEYS, disconnected: [] }));
    const result = await replaceProxyUrls({ disconnect: [], reissueCloudIdentityKeys: true });
    expect(result).toEqual({ ok: true, proxyKeys: NEW_KEYS, disconnected: [] });
    expect(sent()[0].body).toEqual({ action: 'rotate_proxy_keys', disconnect: [], reissue_cloud_identity_keys: true, fleet_id: 'f1' });
    expect(updates()).toEqual([]);
    expect(mocks.cookie).not.toHaveBeenCalled();
  });

  it('tells a restart from a refusal', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'switching' }, { status: 503 }));
    expect(await replaceProxyUrls({ disconnect: [], reissueCloudIdentityKeys: false })).toMatchObject({ ok: false, error: expect.stringMatching(/restarting/) });
  });
});
