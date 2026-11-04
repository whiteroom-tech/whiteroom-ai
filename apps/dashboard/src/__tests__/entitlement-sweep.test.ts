import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sync: vi.fn(),
  mark: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ lockClient: () => ({ connect: async () => {}, query: async () => ({ rows: [] }), end: async () => {} }), db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/entitlements', () => ({
  syncEntitlementsToEngine: mocks.sync,
  // Its SQL (only rows that are due) is tested in entitlements-sync.test.ts.
  markOutboxDelivered: mocks.mark,
}));

/** The outbox query answers with `pending`; the prune and the updates answer with nothing. */
const outbox = (pending: unknown[]) => mocks.query.mockImplementation(async (sql: string) => (sql.includes('SELECT user_id') ? { rows: pending } : { rows: [], rowCount: 0 }));

const { POST } = await import('@/app/api/internal/entitlement-sweep/route');

const SECRET = 'test-secret';

function sweep(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set('x-wr-sync-secret', secret);
  return POST(new Request('https://app.whiteroom.tech/api/internal/entitlement-sweep', {
    method: 'POST',
    headers,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WR_ENTITLEMENT_SYNC_SECRET = SECRET;
});

describe('entitlement sweep', () => {
  it('rejects requests without the sync secret', async () => {
    const res = await sweep();
    expect(res.status).toBe(401);
  });

  it('rejects requests with the wrong secret', async () => {
    const res = await sweep('wrong-secret');
    expect(res.status).toBe(401);
  });

  it('returns swept: 0 when the outbox is empty', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const res = await sweep(SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swept: 0 });
  });

  it('syncs each user and marks rows delivered', async () => {
    outbox([{ max_id: 1, user_id: 'u1' }, { max_id: 2, user_id: 'u2' }]);
    mocks.sync.mockResolvedValue(true);

    const res = await sweep(SECRET);
    const body = await res.json();

    expect(body).toEqual({ swept: 2, pending: 2 });
    expect(mocks.sync).toHaveBeenCalledWith('u1');
    expect(mocks.sync).toHaveBeenCalledWith('u2');
    // Only rows up to the newest one seen before the sync are acknowledged.
    expect(mocks.mark.mock.calls).toEqual([['u1', 1], ['u2', 2]]);
  });

  it('leaves rows pending when the engine does not acknowledge the sync', async () => {
    outbox([{ max_id: 1, user_id: 'u1' }, { max_id: 2, user_id: 'u2' }]);
    mocks.sync.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const res = await sweep(SECRET);
    const body = await res.json();

    expect(body).toEqual({ swept: 1, pending: 2 });
    expect(mocks.mark.mock.calls).toEqual([['u2', 2]]);
  });

  it('continues sweeping other users when one fails', async () => {
    outbox([{ max_id: 1, user_id: 'u1' }, { max_id: 2, user_id: 'u2' }]);
    mocks.sync
      .mockRejectedValueOnce(new Error('engine down'))
      .mockResolvedValueOnce(true);

    const res = await sweep(SECRET);
    const body = await res.json();

    expect(body).toEqual({ swept: 1, pending: 2 });
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it('picks only rows that are due', async () => {
    outbox([{ max_id: 7, user_id: 'u1' }]);
    mocks.sync.mockResolvedValue(true);
    await sweep(SECRET);
    const select = mocks.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('SELECT user_id'))!;
    expect(select[0]).toContain('not_before IS NULL OR not_before <= now()');
    expect(mocks.mark).toHaveBeenCalledWith('u1', 7);
  });

  it('prunes rows delivered over a month ago, even when nothing is pending', async () => {
    outbox([]);
    await sweep(SECRET);
    expect(mocks.query.mock.calls.some((c: unknown[]) => String(c[0]).includes("DELETE FROM entitlement_outbox WHERE delivered_at < now() - interval '30 days'"))).toBe(true);
  });
});
