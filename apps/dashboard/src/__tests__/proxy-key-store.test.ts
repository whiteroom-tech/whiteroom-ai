// The dashboard's encrypted copy of each proxy key, so its URL can be revealed
// again on Fleet key. All placeholders; no real keys.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as { user_id: string; fleet_id: string; key_prefix: string; proxy_key_enc: string }[], fail: false, userId: 'u1' as string | null, fleetId: 'f1' as string | null }));
const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ db: () => ({ query }) }));
vi.mock('@/auth', () => ({ auth: async () => (state.userId ? { user: { id: state.userId } } : null) }));

import { forgetProxyKey, openProxyKey, replaceProxyKeys, savedProxyKeyPrefixes, saveProxyKeys } from '@/lib/proxy-key-store';
import { dropProxyKey, rememberProxyKey, revealProxyKey, revealableProxyKeys } from '@/lib/proxy-keys';

const KEY_A = 'sk-wr-' + 'a'.repeat(40);
const KEY_B = 'sk-wr-' + 'b'.repeat(40);
const PREFIX_A = KEY_A.slice(0, 22);

beforeEach(() => {
  vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  Object.assign(state, { rows: [], fail: false, userId: 'u1', fleetId: 'f1' });
  // A small stand-in for the proxy_keys table and the users.fleet_id lookup.
  query.mockReset().mockImplementation(async (sql: string, p: string[] = []) => {
    if (state.fail) throw new Error('relation "proxy_keys" does not exist');
    if (sql.startsWith('SELECT fleet_id FROM users')) return { rows: [{ fleet_id: state.fleetId }] };
    if (sql.startsWith('INSERT')) {
      state.rows = state.rows.filter((r) => !(r.user_id === p[0] && r.fleet_id === p[1] && r.key_prefix === p[2]));
      state.rows.push({ user_id: p[0], fleet_id: p[1], key_prefix: p[2], proxy_key_enc: p[3] });
      return { rows: [] };
    }
    if (sql.startsWith('SELECT key_prefix')) return { rows: state.rows.filter((r) => r.user_id === p[0] && r.fleet_id === p[1]) };
    if (sql.startsWith('SELECT proxy_key_enc')) return { rows: state.rows.filter((r) => r.user_id === p[0] && r.fleet_id === p[1] && r.key_prefix === p[2]) };
    if (sql.startsWith('DELETE FROM proxy_keys WHERE fleet_id = $1 AND key_prefix')) { state.rows = state.rows.filter((r) => !(r.fleet_id === p[0] && r.key_prefix === p[1])); return { rows: [] }; }
    if (sql.startsWith('DELETE FROM proxy_keys WHERE fleet_id = $1')) { state.rows = state.rows.filter((r) => r.fleet_id !== p[0]); return { rows: [] }; }
    throw new Error(`unexpected query: ${sql}`);
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('proxy key store', () => {
  it('saves a key encrypted and opens it again by its prefix', async () => {
    expect(await saveProxyKeys('u1', 'f1', [KEY_A])).toBe(true);
    expect(state.rows[0].proxy_key_enc).toMatch(/^v1:/);
    expect(JSON.stringify(state.rows)).not.toContain(KEY_A);
    expect(await savedProxyKeyPrefixes('u1', 'f1')).toEqual([PREFIX_A]);
    expect(await openProxyKey('u1', 'f1', PREFIX_A)).toBe(KEY_A);
  });

  it('never saves a plain value: without the encryption key nothing is stored', async () => {
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', '');
    expect(await saveProxyKeys('u1', 'f1', [KEY_A])).toBe(false);
    expect(state.rows).toEqual([]);
  });

  it('refuses anything that is not a proxy key', async () => {
    expect(await saveProxyKeys('u1', 'f1', ['sk-ant-not-a-proxy-key'])).toBe(false);
    expect(state.rows).toEqual([]);
  });

  it('keeps one account’s keys from another account and another fleet', async () => {
    await saveProxyKeys('u1', 'f1', [KEY_A]);
    expect(await openProxyKey('u2', 'f1', PREFIX_A)).toBeNull();
    expect(await openProxyKey('u1', 'f2', PREFIX_A)).toBeNull();
    // A row copied to another account doesn't open there.
    state.rows.push({ ...state.rows[0], user_id: 'u2' });
    expect(await openProxyKey('u2', 'f1', PREFIX_A)).toBeNull();
  });

  it('answers "nothing saved" while the table is missing or the database is down', async () => {
    state.fail = true;
    expect(await saveProxyKeys('u1', 'f1', [KEY_A])).toBe(false);
    expect(await savedProxyKeyPrefixes('u1', 'f1')).toEqual([]);
    expect(await openProxyKey('u1', 'f1', PREFIX_A)).toBeNull();
    expect(await replaceProxyKeys('u1', 'f1', [KEY_A])).toBe(false);
    await expect(forgetProxyKey('f1', PREFIX_A)).resolves.toBeUndefined();
  });

  it('replacing the fleet’s URLs drops every old copy and saves the new ones', async () => {
    await saveProxyKeys('u1', 'f1', [KEY_A]);
    await saveProxyKeys('u2', 'f1', [KEY_A]);
    await saveProxyKeys('u1', 'other-fleet', [KEY_A]);
    expect(await replaceProxyKeys('u1', 'f1', [KEY_B])).toBe(true);
    expect(state.rows.map((r) => `${r.user_id}/${r.fleet_id}/${r.key_prefix}`).sort()).toEqual([`u1/f1/${KEY_B.slice(0, 22)}`, `u1/other-fleet/${PREFIX_A}`]);
  });

  it('removing a key drops its copy for every account', async () => {
    await saveProxyKeys('u1', 'f1', [KEY_A, KEY_B]);
    await saveProxyKeys('u2', 'f1', [KEY_A]);
    await forgetProxyKey('f1', PREFIX_A);
    expect(state.rows.map((r) => r.key_prefix)).toEqual([KEY_B.slice(0, 22)]);
  });
});

describe('proxy key actions', () => {
  it('save, list, reveal and drop for the signed-in account’s own fleet', async () => {
    expect(await rememberProxyKey(KEY_A)).toBe(true);
    expect(state.rows[0]).toMatchObject({ user_id: 'u1', fleet_id: 'f1' });
    expect(await revealableProxyKeys()).toEqual([PREFIX_A]);
    expect(await revealProxyKey(PREFIX_A)).toBe(KEY_A);
    await dropProxyKey(PREFIX_A);
    expect(await revealableProxyKeys()).toEqual([]);
  });

  it('does nothing signed out, or for an account with no fleet', async () => {
    await saveProxyKeys('u1', 'f1', [KEY_A]);
    for (const who of [{ userId: null }, { fleetId: null }]) {
      Object.assign(state, { userId: 'u1', fleetId: 'f1' }, who);
      expect(await rememberProxyKey(KEY_B)).toBe(false);
      expect(await revealableProxyKeys()).toEqual([]);
      expect(await revealProxyKey(PREFIX_A)).toBeNull();
      await dropProxyKey(PREFIX_A);
    }
    expect(state.rows).toHaveLength(1);
  });

  it('another account can’t reveal this one’s URL', async () => {
    await rememberProxyKey(KEY_A);
    state.userId = 'u2';
    expect(await revealProxyKey(PREFIX_A)).toBeNull();
  });

  it('refuses a malformed key or prefix', async () => {
    expect(await rememberProxyKey('sk-wr-short')).toBe(false);
    expect(await revealProxyKey("sk-wr-' OR 1=1")).toBeNull();
  });
});
