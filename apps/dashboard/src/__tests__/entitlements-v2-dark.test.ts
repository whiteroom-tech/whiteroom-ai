import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ENTITLEMENTS_V2 off (unset or anything but "on"): every push is exactly
// today's, byte for byte, and nothing touches revisions. On: every push is
// revisioned, and nothing posts the unversioned body.
const mocks = vi.hoisted(() => ({ sql: [] as string[], owner: 'u1' as string | null, fleets: ['fleet-1'] as string[] }));

vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/db', () => ({
  lockClient: () => ({ connect: async () => {}, end: async () => {}, on: () => {}, query: async () => ({ rows: [] }) }),
  db: () => ({
    query: async (sql: string) => {
      mocks.sql.push(sql);
      if (sql.includes('AS provisioned')) return { rows: mocks.owner ? mocks.fleets.map((fleetId) => ({ fleetId, userId: mocks.owner, provisioned: true, since: 1 })) : [] };
      if (sql.includes('FROM subscriptions')) return { rows: [] };
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

const { releaseFleet, revokeFleetEntitlement, syncEntitlementsToEngine } = await import('@/lib/entitlements');

const fetchMock = vi.fn();
const bodies = () => fetchMock.mock.calls.map((c) => String(c[1].body));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.length = 0; mocks.owner = 'u1'; mocks.fleets = ['fleet-1'];
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
    expect(mocks.sql.join('\n')).not.toMatch(/entitlement_revision|revision|payload_hash|snapshot|trial_state|pg_advisory_xact_lock/);
  });

  it('an unacknowledged push still queues the delayed re-push (not_before)', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(mocks.sql.some((s) => s.includes('not_before') && s.includes('INSERT INTO entitlement_outbox'))).toBe(true);
  });
});

describe('ENTITLEMENTS_V2=on', () => {
  beforeEach(() => {
    process.env.ENTITLEMENTS_V2 = 'on';
    fetchMock.mockResolvedValue(Response.json({ results: [{ principal: 'u1', revision: 41, outcome: 'applied' }] }));
  });

  it('sends a version 2 snapshot, revision taken before the account is read', async () => {
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    const sent = JSON.parse(bodies()[0]);
    expect(sent.version).toBe(2);
    expect(sent).not.toHaveProperty('fleets');
    expect(sent.principals).toEqual([expect.objectContaining({ principal: 'u1', revision: 41, plan: 'trial', fleets: [{ id: 'fleet-1', role: 'production' }] })]);
    const at = (needle: string) => mocks.sql.findIndex((s) => s.includes(needle));
    expect(at("nextval('entitlement_revision')")).toBeLessThan(at('SELECT fleet_id FROM users'));
    // Frozen into the outbox before it's sent.
    expect(at('INSERT INTO entitlement_outbox (user_id, reason, revision, payload_hash, snapshot)')).toBeGreaterThan(at("nextval('entitlement_revision')"));
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

  it('an engine that answers 400 (no revisions yet) is not delivered', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'fleets must be an array.' }, { status: 400 }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
  });

  it.each(['conflict', 'rejected'])('%s is logged as an alert and not delivered', async (outcome) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(Response.json({ results: [{ principal: 'u1', revision: 41, outcome }] }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
    expect(err.mock.calls.some((c) => String(c[0]).includes('ALERT') && String(c[0]).includes(outcome))).toBe(true);
    err.mockRestore();
  });

  it.each(['applied', 'duplicate', 'stale'])('%s is delivered', async (outcome) => {
    fetchMock.mockResolvedValue(Response.json({ results: [{ principal: 'u1', revision: 41, outcome }] }));
    expect(await syncEntitlementsToEngine('u1')).toBe(true);
    expect(mocks.sql.some((s) => s.includes('UPDATE entitlement_outbox SET delivered_at'))).toBe(true);
  });

  it('a 200 without this revision’s result is not delivered', async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [{ principal: 'u1', revision: 40, outcome: 'applied' }] }));
    expect(await syncEntitlementsToEngine('u1')).toBe(false);
  });

  it('no direct unversioned post: a fleet nobody owns is not revoked by releaseFleet', async () => {
    mocks.owner = null;
    await releaseFleet('fleet-1');
    await revokeFleetEntitlement('fleet-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('every body sent is version 2', async () => {
    await syncEntitlementsToEngine('u1');
    mocks.owner = null;
    await releaseFleet('fleet-1');
    expect(bodies().length).toBeGreaterThan(0);
    for (const b of bodies()) expect(JSON.parse(b).version).toBe(2);
  });
});

// The grep half of "no direct v1 post remains on the v2 path": the revisioned
// code builds no unversioned body, and the one function that does is guarded.
describe('source', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/entitlements.ts', import.meta.url)), 'utf8');
  it('the revisioned section posts only v2Body', () => {
    const v2 = src.slice(src.indexOf('// Revisioned entitlements (ENTITLEMENTS_V2=on)'));
    expect(v2.length).toBeGreaterThan(1000);
    // The unversioned body's fields (fleets: [...], maxAgents, closeReason).
    expect(v2).not.toMatch(/fleets:\s*\[|maxAgents:|closeReason:|JSON\.stringify\(payload\)/);
    expect(v2.match(/body: /g)).toEqual(['body: ']);
    expect(v2).toContain('body: v2Body(snapshot)');
  });
  it('revokeFleetEntitlement returns before posting when the flag is on', () => {
    const fn = src.slice(src.indexOf('export async function revokeFleetEntitlement'));
    expect(fn.indexOf('if (entitlementsV2Enabled())')).toBeGreaterThan(-1);
    expect(fn.indexOf('if (entitlementsV2Enabled())')).toBeLessThan(fn.indexOf('await fetch('));
  });
});
