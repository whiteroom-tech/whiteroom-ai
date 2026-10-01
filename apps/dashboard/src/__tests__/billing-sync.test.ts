import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  countAgents: vi.fn(),
  retrieve: vi.fn(),
  updateItem: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: () => ({
    query: mocks.query,
    connect: async () => ({ query: mocks.clientQuery, release: () => {} }),
  }),
}));
vi.mock('@/lib/entitlements', () => ({ countAgents: mocks.countAgents }));
vi.mock('@/lib/stripe', () => ({
  stripe: () => ({
    subscriptions: { retrieve: mocks.retrieve },
    subscriptionItems: { update: mocks.updateItem },
  }),
}));

const { POST } = await import('@/app/api/internal/billing-sync/route');

const SECRET = 'test-secret';

function run(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set('x-wr-sync-secret', secret);
  return POST(new Request('https://app.whiteroom.tech/api/internal/billing-sync', { method: 'POST', headers }));
}

function proSubscription(quantity: number) {
  return { items: { data: [{ id: 'si_1', quantity, price: { id: 'price_pro' } }] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WR_ENTITLEMENT_SYNC_SECRET = SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_PRICE_PRO = 'price_pro';
  mocks.clientQuery.mockResolvedValue({ rows: [] });
});

describe('billing sync', () => {
  it('rejects requests without the sync secret', async () => {
    expect((await run()).status).toBe(401);
    expect((await run('wrong')).status).toBe(401);
  });

  it('queues one engine sync per newly expired trial, in the same transaction', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) =>
      sql.startsWith('UPDATE users') ? { rows: [{ id: 'u1' }, { id: 'u2' }] } : { rows: [] },
    );
    mocks.query.mockResolvedValue({ rows: [] });

    const body = await (await run(SECRET)).json();

    expect(body.trialsQueued).toBe(2);
    const sqls = mocks.clientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.some((s) => s.includes('INSERT INTO entitlement_outbox'))).toBe(true);
    expect(sqls.at(-1)).toBe('COMMIT');
  });

  it('raises the Stripe quantity when the account has added agents', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ user_id: 'u1', stripe_subscription_id: 'sub_1', billed_agents: 5 }] });
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.countAgents.mockResolvedValue(8);
    mocks.retrieve.mockResolvedValue(proSubscription(5));

    const body = await (await run(SECRET)).json();

    expect(body.pro).toEqual({ checked: 1, updated: 1, skipped: 0 });
    expect(mocks.updateItem).toHaveBeenCalledWith('si_1', { quantity: 8, proration_behavior: 'create_prorations' });
  });

  it('leaves Stripe alone when the count already matches', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ user_id: 'u1', stripe_subscription_id: 'sub_1', billed_agents: 8 }] });
    mocks.countAgents.mockResolvedValue(8);

    await run(SECRET);

    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  // An outage must not look like an account with no agents: billing 1 agent
  // because the engine was redeploying would undercharge until the next run.
  it('skips an account when the engine cannot say how many agents it has', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ user_id: 'u1', stripe_subscription_id: 'sub_1', billed_agents: 8 }] });
    mocks.countAgents.mockResolvedValue(null);

    const body = await (await run(SECRET)).json();

    expect(body.pro).toEqual({ checked: 1, updated: 0, skipped: 1 });
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('never sets a zero quantity', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ user_id: 'u1', stripe_subscription_id: 'sub_1', billed_agents: 3 }] });
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.countAgents.mockResolvedValue(0);
    mocks.retrieve.mockResolvedValue(proSubscription(3));

    await run(SECRET);

    expect(mocks.updateItem).toHaveBeenCalledWith('si_1', expect.objectContaining({ quantity: 1 }));
  });
});
