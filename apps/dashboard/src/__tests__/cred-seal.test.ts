import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ db: () => ({ query }) }));

import { openCred, readCred, sealCred, sealStoredCreds } from '@/lib/cred-seal';

beforeEach(() => { vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64')); query.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

describe('sealCred / openCred', () => {
  it('round-trips, with a fresh IV each time', () => {
    const a = sealCred('users.api_key', 'u1', 'sk-wr-placeholder')!;
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain('placeholder');
    expect(sealCred('users.api_key', 'u1', 'sk-wr-placeholder')).not.toBe(a);
    expect(openCred('users.api_key', 'u1', a)).toBe('sk-wr-placeholder');
  });

  it('refuses a tampered envelope, another column or user, and another key', () => {
    const sealed = sealCred('users.fleet_token', 'u1', 'tok')!;
    const buf = Buffer.from(sealed.slice(3), 'base64');
    buf[buf.length - 1] ^= 1;
    expect(() => openCred('users.fleet_token', 'u1', 'v1:' + buf.toString('base64'))).toThrow();
    expect(() => openCred('user_fleets.fleet_token', 'u1', sealed)).toThrow();
    expect(() => openCred('users.fleet_token', 'u2', sealed)).toThrow();
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    expect(() => openCred('users.fleet_token', 'u1', sealed)).toThrow();
  });

  it('seals nothing without a key, and refuses a key of the wrong size', () => {
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', '');
    expect(sealCred('users.api_key', 'u1', 'k')).toBeNull();
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(16).toString('base64'));
    expect(() => sealCred('users.api_key', 'u1', 'k')).toThrow(/32 bytes/);
  });
});

describe('readCred', () => {
  it('uses the plain value while present, else decrypts', () => {
    const sealed = sealCred('users.fleet_token', 'u1', 'tok')!;
    expect(readCred('users.fleet_token', 'u1', 'newer', sealed)).toBe('newer');
    expect(readCred('users.fleet_token', 'u1', null, sealed)).toBe('tok');
    expect(readCred('users.fleet_token', 'u1', null, null)).toBeNull();
  });
});

describe('sealStoredCreds', () => {
  it('encrypts each plain value that has no envelope, only if it is unchanged', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE')) return { rowCount: 1 };
      if (sql.includes('FROM user_fleets')) return { rows: [{ id: 7, userId: 'u2', value: 'tok-2' }] };
      if (sql.includes('api_key AS value')) return { rows: [{ id: 'u1', userId: 'u1', value: 'sk-wr-placeholder' }] };
      return { rows: [] };
    });
    expect(await sealStoredCreds()).toBe(2);
    const updates = query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE'));
    expect(updates.map(([sql]) => sql)).toEqual([
      'UPDATE users SET api_key_enc = $2 WHERE id = $1 AND api_key = $3 AND api_key_enc IS NULL',
      'UPDATE user_fleets SET fleet_token_enc = $2 WHERE id = $1 AND fleet_token = $3 AND fleet_token_enc IS NULL',
    ]);
    const [, [id, sealed, plain]] = updates[1];
    expect([id, plain]).toEqual([7, 'tok-2']);
    expect(openCred('user_fleets.fleet_token', 'u2', sealed)).toBe('tok-2');
  });

  it('does nothing without a key', async () => {
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', '');
    expect(await sealStoredCreds()).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('instrumentation register', () => {
  it('exits in production without the key, and otherwise starts the backfill', async () => {
    const { register } = await import('@/instrumentation');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', '');
    await expect(register()).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);

    vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    query.mockResolvedValue({ rows: [] });
    await register();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3));
    vi.restoreAllMocks();
  });
});
