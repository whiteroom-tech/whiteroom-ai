import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sync: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/entitlements', () => ({
  syncEntitlementsToEngine: mocks.sync,
}));

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
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 'u1' }, { id: 2, user_id: 'u2' }] })
      .mockResolvedValue({ rows: [] });
    mocks.sync.mockResolvedValue(undefined);

    const res = await sweep(SECRET);
    const body = await res.json();

    expect(body).toEqual({ swept: 2, pending: 2 });
    expect(mocks.sync).toHaveBeenCalledWith('u1');
    expect(mocks.sync).toHaveBeenCalledWith('u2');
    const updateCalls = mocks.query.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE entitlement_outbox'),
    );
    expect(updateCalls).toHaveLength(2);
  });

  it('continues sweeping other users when one fails', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 'u1' }, { id: 2, user_id: 'u2' }] })
      .mockResolvedValue({ rows: [] });
    mocks.sync
      .mockRejectedValueOnce(new Error('engine down'))
      .mockResolvedValueOnce(undefined);

    const res = await sweep(SECRET);
    const body = await res.json();

    expect(body).toEqual({ swept: 1, pending: 2 });
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });
});
