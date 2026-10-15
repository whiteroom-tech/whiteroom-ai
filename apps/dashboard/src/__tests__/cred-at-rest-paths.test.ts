// The read and write paths that store credentials: encrypted copies are
// written beside the plain value, read back when the plain value is gone,
// and a row whose envelope won't open is left out, not returned without one.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({
  db: () => ({ query: mocks.query, connect: async () => ({ query: mocks.query, release: vi.fn() }) }),
}));

import { sealCred } from '@/lib/cred-seal';
import { getUserFleets } from '@/lib/user-fleets';
import { getUserProvisioning } from '@/lib/users';

beforeEach(() => {
  vi.stubEnv('WR_CRED_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  mocks.query.mockReset();
  mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('getUserFleets', () => {
  it('decrypts a row with no plain value and leaves out a row whose envelope will not open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockResolvedValue({
      rows: [
        { id: 1, fleet_token: 'plain-tok', fleet_token_enc: null, fleet_id: 'f1', label: null, created_at: 't' },
        { id: 2, fleet_token: null, fleet_token_enc: sealCred('user_fleets.fleet_token', 'u1', 'sealed-tok'), fleet_id: 'f2', label: null, created_at: 't' },
        { id: 3, fleet_token: null, fleet_token_enc: sealCred('user_fleets.fleet_token', 'someone-else', 'x'), fleet_id: 'f3', label: null, created_at: 't' },
      ],
    });
    const fleets = await getUserFleets();
    expect(fleets.map((f) => [f.id, f.fleet_token])).toEqual([[1, 'plain-tok'], [2, 'sealed-tok']]);
  });
});

describe('getUserProvisioning', () => {
  it('reads both credentials from their envelopes once the plain values are gone', async () => {
    mocks.query.mockResolvedValue({
      rows: [{
        api_key: null, api_key_enc: sealCred('users.api_key', 'u1', 'sk-wr-placeholder'),
        fleet_token: null, fleet_token_enc: sealCred('users.fleet_token', 'u1', 'tok'),
        fleet_id: 'f1', byok: false,
      }],
    });
    const p = await getUserProvisioning();
    expect(p).toMatchObject({ apiKey: 'sk-wr-placeholder', fleetToken: 'tok' });
  });
});

