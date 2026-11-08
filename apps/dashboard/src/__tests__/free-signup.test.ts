import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@/lib/db';

const mocks = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  counts: { today: 0, from_ip: 0, same_identity: 0 },
  forwardedFor: '203.0.113.7, 198.51.100.1' as string | null,
  deleted: [] as string[],
}));

vi.mock('@/lib/db', () => ({ db: () => ({ query: vi.fn(), connect: async () => mocks.client }) }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, delete: (name: string) => { mocks.deleted.push(name); } }),
  headers: async () => ({ get: (name: string) => (name === 'x-forwarded-for' ? mocks.forwardedFor : null) }),
}));

const {
  FREE_SIGNUPS_PER_IP_PER_DAY, FREE_SIGNUPS_PER_UTC_DAY, clientIp, createFreeUser, emailKey, ipHash, nextUtcMidnight,
} = await import('@/lib/free-signup');
const { sandboxOpensLine } = await import('@/lib/sandbox-opens-line');
const { sandboxOpensAt } = await import('@/lib/sandbox-opens-at');

const NOW = new Date('2026-11-08T17:30:00Z');
const USER = { email: 'dana+test@Example.test', emailVerified: null, name: null, image: null };

const call = (prefix: string) => mocks.client.query.mock.calls.find((c) => String(c[0]).trim().startsWith(prefix));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', 'test-secret');
  mocks.counts = { today: 0, from_ip: 0, same_identity: 0 };
  mocks.forwardedFor = '203.0.113.7, 198.51.100.1';
  mocks.deleted = [];
  mocks.client.query.mockImplementation(async (sql: string) => {
    if (sql.includes('count(*)')) return { rows: [mocks.counts] };
    if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 'u-free', email: USER.email }] };
    return { rows: [] };
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('plus-address normalisation', () => {
  it('counts a+1@x.com as a@x.com', () => {
    expect(emailKey('a+1@x.com')).toBe('a@x.com');
    expect(emailKey('  A+promo+2@X.com ')).toBe('a@x.com');
    expect(emailKey('a@x.com')).toBe('a@x.com');
  });

  it('leaves a leading + and odd input alone', () => {
    expect(emailKey('+a@x.com')).toBe('+a@x.com');
    expect(emailKey('no-at-sign')).toBe('no-at-sign');
  });

  it('checks the normalised address against existing Free sign-ups', async () => {
    await createFreeUser(USER, NOW);
    const [, params] = call('SELECT count(*)')!;
    expect(params[2]).toBe('dana@example.test');
    expect(call('INSERT INTO free_signups')![1][2]).toBe('dana@example.test');
  });
});

describe('client address', () => {
  it('takes the client from behind the load balancer, ignoring what the client sent', () => {
    expect(clientIp('6.6.6.6, 203.0.113.7, 198.51.100.1')).toBe('203.0.113.7');
    expect(clientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(clientIp(null)).toBe('');
  });

  it('isn\'t counted when unknown, so headerless sign-ups don\'t share one bucket', async () => {
    mocks.forwardedFor = null;
    mocks.counts.from_ip = 99;
    await createFreeUser(USER, NOW);
    expect(call('INSERT INTO users')![1][4]).toBeNull();
    expect(call('SELECT count(*)')![1][1]).toBeNull();
    expect(call('INSERT INTO free_signups')![1][1]).toBeNull();
  });

  it('isn\'t stored at all without a key', () => {
    vi.stubEnv('AUTH_SECRET', '');
    expect(ipHash('203.0.113.7')).toBeNull();
  });

  it('is stored only as a keyed hash', async () => {
    await createFreeUser(USER, NOW);
    const stored = call('INSERT INTO free_signups')![1][1];
    expect(stored).toBe(ipHash('203.0.113.7'));
    expect(stored).not.toContain('203.0.113.7');
  });
});

describe('limits never turn anyone away', () => {
  const opensAt = () => call('INSERT INTO users')![1][4] as Date | null;

  it('opens the Sandbox now under every limit', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await createFreeUser(USER, NOW)).id).toBe('u-free');
    expect(opensAt()).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });

  it(`over the day's cap (${FREE_SIGNUPS_PER_UTC_DAY}): made as Free, opens at the next 00:00 UTC, alerts`, async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.counts.today = FREE_SIGNUPS_PER_UTC_DAY;
    expect((await createFreeUser(USER, NOW)).id).toBe('u-free');
    expect(opensAt()?.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(err.mock.calls[0][0]).toMatch(/\[signup\] ALERT: .*cap of 200/);
    // No address or email in the alert.
    expect(err.mock.calls[0][0]).not.toMatch(/203\.0\.113\.7|dana/);
  });

  it(`one under the cap still opens now`, async () => {
    mocks.counts.today = FREE_SIGNUPS_PER_UTC_DAY - 1;
    await createFreeUser(USER, NOW);
    expect(opensAt()).toBeNull();
  });

  it(`over ${FREE_SIGNUPS_PER_IP_PER_DAY} from one address today: opens tomorrow, alerts`, async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.counts.from_ip = FREE_SIGNUPS_PER_IP_PER_DAY;
    await createFreeUser(USER, NOW);
    expect(opensAt()?.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(err.mock.calls[0][0]).toMatch(/ALERT: .*from one address/);
  });

  it(`the ${FREE_SIGNUPS_PER_IP_PER_DAY}th from one address still opens now`, async () => {
    mocks.counts.from_ip = FREE_SIGNUPS_PER_IP_PER_DAY - 1;
    await createFreeUser(USER, NOW);
    expect(opensAt()).toBeNull();
  });

  it('a plus-address of an existing Free account: opens tomorrow, alerts', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.counts.same_identity = 1;
    await createFreeUser(USER, NOW);
    expect(opensAt()).not.toBeNull();
    expect(err.mock.calls[0][0]).toMatch(/ALERT: .*plus-address/);
  });

  it('counts under one lock, from the start of the UTC day', async () => {
    await createFreeUser(USER, NOW);
    const sql = mocks.client.query.mock.calls.map((c) => String(c[0]));
    expect(sql.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(sql.findIndex((s) => s.includes('count(*)')));
    expect((call('SELECT count(*)')![1][0] as Date).toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });
});

describe('the invite cookie', () => {
  it('is cleared once it has made a Free account', async () => {
    await createFreeUser(USER, NOW);
    expect(mocks.deleted).toEqual(['wr_free_invite']);
  });
});

describe('the next 00:00 UTC', () => {
  it('rolls over months and years', () => {
    expect(nextUtcMidnight(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-11-08T00:00:00Z')).toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });
});

describe('the over-cap line (§3.10)', () => {
  const opens = Date.parse('2026-11-09T00:00:00Z');

  it('says the time in the viewer\'s zone, same day', () => {
    expect(sandboxOpensLine(opens, Date.parse('2026-11-08T17:30:00Z'), 'America/New_York'))
      .toBe("Your account is ready. We'll open your Sandbox at 7:00 PM your time.");
  });

  it('says tomorrow when it opens on the viewer\'s next day', () => {
    expect(sandboxOpensLine(opens, Date.parse('2026-11-08T17:30:00Z'), 'Asia/Kolkata'))
      .toBe("Your account is ready. We'll open your Sandbox tomorrow at 5:30 AM your time.");
  });
});

describe('sandboxOpensAt', () => {
  const q = (row: unknown) => ({ query: vi.fn(async () => ({ rows: row ? [row] : [] })) }) as unknown as Queryable;

  it('returns a time still to come', async () => {
    const at = new Date('2026-11-09T00:00:00Z');
    expect(await sandboxOpensAt('u', q({ sandbox_opens_at: at }), NOW)).toEqual(at);
  });

  it('is null when never deferred, already open, or unreadable', async () => {
    expect(await sandboxOpensAt('u', q({ sandbox_opens_at: null }), NOW)).toBeNull();
    expect(await sandboxOpensAt('u', q({ sandbox_opens_at: new Date('2026-11-08T00:00:00Z') }), NOW)).toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sandboxOpensAt('u', { query: vi.fn(async () => { throw new Error('down'); }) } as unknown as Queryable, NOW)).toBeNull();
  });
});
