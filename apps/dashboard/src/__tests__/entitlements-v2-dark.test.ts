import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ENTITLEMENTS_V2 off (unset or anything but "on"): every push is exactly
// today's, byte for byte, and nothing touches revisions. On: every push is
// revisioned, and nothing posts the unversioned body.
const mocks = vi.hoisted(() => ({ sql: [] as string[], owner: 'u1' as string | null, fleets: ['fleet-1'] as string[], closing: null as Record<string, unknown> | null }));

vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/db', () => ({
  lockClient: () => ({ connect: async () => {}, end: async () => {}, on: () => {}, query: async () => ({ rows: [] }) }),
  db: () => ({
    query: async (sql: string) => {
      mocks.sql.push(sql);
      if (sql.includes('AS provisioned')) return { rows: mocks.owner ? mocks.fleets.map((fleetId) => ({ fleetId, userId: mocks.owner, provisioned: true, since: 1 })) : [] };
      if (sql.includes('FROM subscriptions')) return { rows: [] };
      if (sql.includes('closes_at, close_reason, delete_after FROM users')) return { rows: mocks.closing ? [mocks.closing] : [] };
      if (sql.includes("nextval('entitlement_revision')")) return { rows: [{ r: '41' }] };
      if (sql.includes('INSERT INTO entitlement_outbox') && sql.includes('RETURNING id')) return { rows: [{ id: '9' }] };
      if (sql.includes('trial_ends_at')) return { rows: [{ trial_ends_at: new Date(Date.now() + 86_400_000).toISOString() }] };
      if (sql.includes('SELECT fleet_id FROM users')) return { rows: mocks.fleets.map((fleet_id) => ({ fleet_id })) };
      return { rows: [] };
    },
  }),
}));
vi.mock('@/lib/fleet-usage', () => ({ fetchFleetUsage: vi.fn() }));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'http://engine.test' }));

const { releaseFleet, syncEntitlementsToEngine } = await import('@/lib/entitlements');

const fetchMock = vi.fn();
const bodies = () => fetchMock.mock.calls.map((c) => String(c[1].body));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.length = 0; mocks.owner = 'u1'; mocks.fleets = ['fleet-1']; mocks.closing = null;
  process.env.WR_ENTITLEMENT_SYNC_SECRET = 'secret';
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ENTITLEMENTS_V2;
});

// What the dashboard sends today for a trial account with one fleet, exactly.
const TODAY = '{"fleets":[{"fleetId":"fleet-1","plan":"starter","status":"active","maxAgents":500,"retentionDays":30,"closesAt":null,"closeReason":null}]}';
const TODAY_REVOKE = '{"fleets":[{"fleetId":"fleet-1","plan":"starter","status":"active","maxAgents":500,"retentionDays":30,"closesAt":null}]}';

describe.each([undefined, '', 'off', 'OFF', 'true', 'yes', 'on '])('ENTITLEMENTS_V2=%j: today’s pushes, unchanged', (flag) => {
  beforeEach(() => {
    if (flag === undefined) delete process.env.ENTITLEMENTS_V2; else process.env.ENTITLEMENTS_V2 = flag;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  it('a push is the unversioned body, byte for byte', async () => {
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(bodies()).toEqual([TODAY]);
  });

  it('a zero-fleet account still sends nothing', async () => {
    mocks.fleets = [];
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a fleet nobody owns is revoked by the direct post, as today', async () => {
    mocks.owner = null;
    await releaseFleet('fleet-1');
    expect(bodies()).toEqual([TODAY_REVOKE]);
  });

  it('nothing reads or writes revisions, hashes or snapshots', async () => {
    await syncEntitlementsToEngine('u1');
    mocks.owner = null;
    await releaseFleet('fleet-1');
    // trial_state is read (plan resolution: Free vs Suspended), never written here.
    expect(mocks.sql.join('\n')).not.toMatch(/entitlement_revision|revision|payload_hash|snapshot|SET trial_state|pg_advisory_xact_lock/);
  });

  it('an unacknowledged push still queues the delayed re-push (not_before)', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(mocks.sql.some((s) => s.includes('not_before') && s.includes('INSERT INTO entitlement_outbox'))).toBe(true);
  });
});

describe('ENTITLEMENTS_V2=on', () => {
  const answer = (result: Record<string, unknown>) => fetchMock.mockResolvedValue(Response.json({ results: [{ principal: 'u1', revision: 41, ...result }] }));
  const alerts = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ALERT'));
  beforeEach(() => {
    process.env.ENTITLEMENTS_V2 = 'on';
    answer({ outcome: 'applied' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.mocked(console.error).mockRestore());

  it('sends a version 2 snapshot, frozen into the outbox before it is sent', async () => {
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    const sent = JSON.parse(bodies()[0]);
    expect(sent.version).toBe(2);
    expect(sent).not.toHaveProperty('fleets');
    expect(sent.principals).toEqual([expect.objectContaining({ principal: 'u1', revision: 41, plan: 'trial', fleets: [{ id: 'fleet-1', role: 'production' }] })]);
    expect(mocks.sql.some((s) => s.includes('INSERT INTO entitlement_outbox (user_id, reason, revision, payload_hash, snapshot)'))).toBe(true);
  });

  it('runs the lapse check on every push', async () => {
    await syncEntitlementsToEngine('u1');
    expect(mocks.sql.some((s) => s.includes('closes_at, close_reason, delete_after FROM users'))).toBe(true);
  });

  it('a zero-fleet account gets its snapshot too', async () => {
    mocks.fleets = [];
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(JSON.parse(bodies()[0]).principals[0].fleets).toEqual([]);
  });

  it('no delayed re-push: a late older push is answered stale', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(mocks.sql.some((s) => s.includes('not_before') && s.includes('INSERT INTO entitlement_outbox'))).toBe(false);
  });

  it('a 4xx (an engine without revisions answers 400) is an alert, not delivered', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'fleets must be an array.' }, { status: 400 }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(alerts()).toEqual([expect.stringContaining('HTTP 400')]);
  });

  it.each(['conflict', 'rejected'])('%s is an alert, not delivered', async (outcome) => {
    answer({ outcome });
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(alerts()).toEqual([expect.stringContaining(outcome)]);
  });

  it('a 200 without this revision’s result is an alert, not delivered', async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [{ principal: 'u1', revision: 40, outcome: 'applied' }] }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(alerts()).toEqual([expect.stringContaining('no result')]);
  });

  it.each(['applied', 'duplicate', 'stale'])('%s is delivered', async (outcome) => {
    answer({ outcome });
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(mocks.sql.some((s) => s.includes('UPDATE entitlement_outbox SET delivered_at'))).toBe(true);
  });

  describe('a deletion’s closing time', () => {
    beforeEach(() => { mocks.closing = { closes_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), close_reason: 'deleted', delete_after: null }; });

    it('is delivered only when the engine confirms it stored it (closing: "stored")', async () => {
      answer({ outcome: 'applied', closing: 'stored' });
      expect(await syncEntitlementsToEngine('u1')).toBe(true);
      expect(JSON.parse(bodies()[0]).principals[0].closing).toMatchObject({ reason: 'deleted' });
    });

    it.each([{}, { closing: 'ignored' }])('anything else is an alert, not delivered: %j', async (extra) => {
      answer({ outcome: 'applied', ...extra });
      expect(await syncEntitlementsToEngine('u1')).toBe(false);
      expect(alerts()).toEqual([expect.stringContaining('closing: "stored"')]);
    });
  });
});

// The grep half of "no direct v1 post remains on the v2 path": the revisioned
// code builds no unversioned body.
describe('source', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/entitlements.ts', import.meta.url)), 'utf8');
  it('the revisioned section posts only v2Body', () => {
    const v2 = src.slice(src.indexOf('// Revisioned entitlements (ENTITLEMENTS_V2=on)'));
    expect(v2.length).toBeGreaterThan(1000);
    // The unversioned body's fields (fleets: [...], maxAgents, closeReason).
    expect(v2).not.toMatch(/fleets:\s*\[|maxAgents:|closeReason:|JSON\.stringify\(payload\)|revokeFleetEntitlement\(|releaseFleet\(/);
    expect(v2.match(/body: /g)).toEqual(['body: ']);
    expect(v2).toContain('body: v2Body(snapshot)');
  });
});
