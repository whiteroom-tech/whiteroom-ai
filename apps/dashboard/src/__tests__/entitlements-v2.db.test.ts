import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Against a real Postgres: migration 015, the revisioned sender
// (ENTITLEMENTS_V2=on) through the outbox and the sweep, ownership transfers,
// trial activation and the trial_state backfill.
//
// Skipped unless WR_TEST_DATABASE names a scratch database you created for
// it (every table in it is dropped). Needs psql on PATH. For example:
//   createdb -h localhost -p 5433 wr_d1_test
//   WR_TEST_DATABASE=wr_d1_test DB_PORT=5433 npx vitest run src/__tests__/entitlements-v2.db.test.ts
//   dropdb -h localhost -p 5433 wr_d1_test
//
// The base users / subscriptions / user_fleets tables have no DDL in this
// repo, so a minimal stand-in with the columns this code reads is created first.
const DB = process.env.WR_TEST_DATABASE;
const HOST = process.env.DB_HOST || '127.0.0.1';
const PORT = process.env.DB_PORT || '5433';

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: actor.id, email: `${actor.id}@example.com` } }) }));
vi.mock('@/lib/fleet-ownership', () => ({ verifyFleetOwnership: async () => {} }));
vi.mock('@/lib/email', () => ({ sendEmail: async () => {} }));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'http://engine.test', tokenLogin: async () => ({}), isAuthError: () => false }));
const actor = vi.hoisted(() => ({ id: 'user-a' }));

const migration = (f: string) => fileURLToPath(new URL(`../../migrations/${f}`, import.meta.url));
const script = (f: string) => fileURLToPath(new URL(`../../scripts/${f}`, import.meta.url));

function psql(args: string[]): string {
  return execFileSync('psql', ['-h', HOST, '-p', PORT, '-d', DB!, '-v', 'ON_ERROR_STOP=1', '-qAt', ...args], { encoding: 'utf8' });
}

const BASE_SCHEMA = `
DROP TABLE IF EXISTS entitlement_outbox, user_fleets, subscriptions, users CASCADE;
DROP SEQUENCE IF EXISTS entitlement_revision;
CREATE TABLE users (
  id text PRIMARY KEY, email text, name text,
  api_key text, api_key_enc text, fleet_id text, fleet_token text, fleet_token_enc text,
  byok boolean NOT NULL DEFAULT false,
  trial_ends_at timestamptz DEFAULT now() + interval '90 days',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE subscriptions (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id text, stripe_subscription_id text, plan text NOT NULL, status text NOT NULL,
  plan_override text, current_period_end timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_fleets (
  id serial PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fleet_token text, fleet_token_enc text, fleet_id text, label text,
  created_at timestamptz NOT NULL DEFAULT now()
);`;

// ---------------------------------------------------------------------------
// A stand-in for the other side of the entitlements v2 contract, as the
// dashboard relies on it: per account, a newer revision applies, the same one
// with the same bytes is a duplicate, with other bytes a conflict, an older
// one stale. A fleet goes to an account that lists it if nobody else has it,
// or with a transfer from the account that has it; an account that stops
// listing a fleet it has releases it; an older revision never changes a fleet.
// ---------------------------------------------------------------------------
type Binding = { principal: string | null; state: 'bound' | 'revoked'; rev: number };
const engine = {
  principals: new Map<string, { revision: number; hash: string }>(),
  bindings: new Map<string, Binding>(),
  bodies: [] as string[],
  /** Apply, then answer 503 (a lost acknowledgement). */
  loseAck: 0,
  down: false,
  /** Answer every v2 push with this outcome (or this HTTP status) without applying it. */
  refuse: null as string | number | null,
  /** Leave the closing confirmation out of the result. */
  dropClosing: false,
  reset() { this.principals.clear(); this.bindings.clear(); this.bodies = []; this.loseAck = 0; this.down = false; this.refuse = null; this.dropClosing = false; },
  apply(entry: { principal: string; revision: number; fleets: Array<{ id: string }>; transfers?: Array<{ fleet: string; from: string; to: string }> }, raw: string): string {
    const hash = createHash('sha256').update(raw).digest('hex');
    const stored = this.principals.get(entry.principal);
    if (stored && entry.revision < stored.revision) return 'stale';
    if (stored && entry.revision === stored.revision) return stored.hash === hash ? 'duplicate' : 'conflict';
    const listed = new Set(entry.fleets.map((f) => f.id));
    for (const id of listed) {
      const b = this.bindings.get(id);
      const transfer = entry.transfers?.some((t) => t.fleet === id && t.to === entry.principal && b?.principal === t.from);
      const may = !b || b.state === 'revoked' || b.principal === entry.principal || transfer;
      if (may && (!b || entry.revision > b.rev)) this.bindings.set(id, { principal: entry.principal, state: 'bound', rev: entry.revision });
    }
    for (const [id, b] of this.bindings) {
      if (!listed.has(id) && b.state === 'bound' && b.principal === entry.principal && entry.revision > b.rev) {
        this.bindings.set(id, { principal: null, state: 'revoked', rev: entry.revision });
      }
    }
    this.principals.set(entry.principal, { revision: entry.revision, hash });
    return 'applied';
  },
};

async function engineFetch(_url: string, init: { body: string }): Promise<Response> {
  if (engine.down) throw new Error('connect ECONNREFUSED');
  engine.bodies.push(init.body);
  const body = JSON.parse(init.body);
  if (body.version !== 2) return Response.json({ applied: (body.fleets ?? []).map((f: { fleetId: string }) => f.fleetId), unknown: [], closed: [] });
  // The entry's own bytes, as the sender canonicalised them.
  const raw = init.body.slice(init.body.indexOf('[') + 1, init.body.lastIndexOf(']'));
  if (typeof engine.refuse === 'number') return Response.json({ error: 'refused' }, { status: engine.refuse });
  type Entry = Parameters<typeof engine.apply>[0] & { closing: unknown };
  const results = body.principals.map((p: Entry) => {
    const outcome = engine.refuse ?? engine.apply(p, raw);
    const stored = p.closing && !engine.dropClosing && (outcome === 'applied' || outcome === 'duplicate');
    return { principal: p.principal, revision: p.revision, outcome, ...(stored ? { closing: 'stored' } : {}) };
  });
  if (engine.loseAck > 0) { engine.loseAck--; return new Response('', { status: 503 }); }
  return Response.json({ results });
}

const suite = DB ? describe : describe.skip;

suite('entitlements v2 against Postgres', () => {
  let db: typeof import('@/lib/db').db;
  let ent: typeof import('@/lib/entitlements');
  let users: typeof import('@/lib/users');
  let sweep: typeof import('@/app/api/internal/entitlement-sweep/route').POST;

  const q = async (sql: string, params: unknown[] = []) => (await db().query(sql, params)).rows;
  const runSweep = () => sweep(new Request('http://dash.test/api/internal/entitlement-sweep', { method: 'POST', headers: { 'x-wr-sync-secret': 'test-sync-secret' } }));
  const pending = async (userId: string) => q(`SELECT id, reason, revision::int AS revision FROM entitlement_outbox WHERE user_id = $1 AND delivered_at IS NULL ORDER BY id`, [userId]);
  const addUser = (id: string, opts: { fleet?: string | null; trialEndsAt?: string; trialState?: string | null; since?: string } = {}) => q(
    `INSERT INTO users (id, email, fleet_id, trial_ends_at, trial_state, created_at, fleet_provisioned_at)
     VALUES ($1, $1 || '@example.com', $2, COALESCE($3::timestamptz, now() + interval '20 days'), $4, COALESCE($5::timestamptz, now()), COALESCE($5::timestamptz, now()))`,
    [id, opts.fleet ?? null, opts.trialEndsAt ?? null, opts.trialState ?? null, opts.since ?? null],
  );
  const enqueue = (userId: string, reason = 'test') => q(`INSERT INTO entitlement_outbox (user_id, reason) VALUES ($1, $2)`, [userId, reason]);

  beforeAll(async () => {
    Object.assign(process.env, {
      DB_HOST: HOST, DB_PORT: PORT, DB_NAME: DB, DB_USER: process.env.DB_USER || process.env.USER,
      WR_ENTITLEMENT_SYNC_SECRET: 'test-sync-secret',
      WR_CRED_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    psql(['-c', BASE_SCHEMA]);
    for (const f of ['005_entitlement_outbox.sql', '012_account_closing.sql', '013_outbox_not_before.sql', '014_fleet_provisioned_at.sql',
      '015_entitlement_revisions_trial_state.sql', '015_entitlement_revisions_trial_state.sql']) psql(['-f', migration(f)]);
    ({ db } = await import('@/lib/db'));
    ent = await import('@/lib/entitlements');
    users = await import('@/lib/users');
    ({ POST: sweep } = await import('@/app/api/internal/entitlement-sweep/route'));
  });
  afterAll(async () => { await db?.().end(); });
  beforeEach(async () => {
    await q(`TRUNCATE entitlement_outbox, user_fleets, subscriptions, users CASCADE`);
    engine.reset();
    vi.stubGlobal('fetch', vi.fn(engineFetch));
    process.env.ENTITLEMENTS_V2 = 'on';
    actor.id = 'user-a';
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.ENTITLEMENTS_V2; vi.restoreAllMocks(); });

  describe('migration 015', () => {
    it('is additive: nullable columns with no defaults, and re-runs cleanly (applied twice above)', async () => {
      const cols = await q(
        `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE (table_name = 'entitlement_outbox' AND column_name IN ('revision', 'payload_hash', 'snapshot'))
             OR (table_name = 'users' AND column_name IN ('trial_state', 'trial_started_at'))
          ORDER BY table_name, column_name`,
      );
      expect(cols).toEqual([
        { table_name: 'entitlement_outbox', column_name: 'payload_hash', data_type: 'text', is_nullable: 'YES', column_default: null },
        { table_name: 'entitlement_outbox', column_name: 'revision', data_type: 'bigint', is_nullable: 'YES', column_default: null },
        { table_name: 'entitlement_outbox', column_name: 'snapshot', data_type: 'jsonb', is_nullable: 'YES', column_default: null },
        { table_name: 'users', column_name: 'trial_started_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
        { table_name: 'users', column_name: 'trial_state', data_type: 'text', is_nullable: 'YES', column_default: null },
      ]);
      const [{ a }] = await q(`SELECT nextval('entitlement_revision') AS a`);
      const [{ b }] = await q(`SELECT nextval('entitlement_revision') AS b`);
      expect(BigInt(b)).toBeGreaterThan(BigInt(a));
    });

    it('accepts only the three trial states', async () => {
      await addUser('u-check');
      for (const s of ['not_started', 'active', 'ended', null]) await q(`UPDATE users SET trial_state = $1 WHERE id = 'u-check'`, [s]);
      await expect(q(`UPDATE users SET trial_state = 'paused' WHERE id = 'u-check'`)).rejects.toThrow(/users_trial_state_check/);
    });
  });

  describe('ENTITLEMENTS_V2 off, on the migrated schema', () => {
    it('the sweep sends today’s body and writes no revision', async () => {
      delete process.env.ENTITLEMENTS_V2;
      await addUser('user-a', { fleet: 'fleet-a' });
      await enqueue('user-a');
      await runSweep();
      expect(engine.bodies.map((b) => JSON.parse(b))).toEqual([{ fleets: [{ fleetId: 'fleet-a', plan: 'starter', status: 'active', maxAgents: 500, retentionDays: 30, closesAt: null, closeReason: null }] }]);
      expect(await q(`SELECT count(*)::int AS n FROM entitlement_outbox WHERE revision IS NOT NULL OR snapshot IS NOT NULL`)).toEqual([{ n: 0 }]);
      expect(await pending('user-a')).toEqual([]);
    });
  });

  const frozenRows = async (userId: string) => q(`SELECT revision::int AS revision, delivered_at IS NOT NULL AS delivered FROM entitlement_outbox WHERE user_id = $1 AND revision IS NOT NULL ORDER BY revision`, [userId]);

  describe('the revisioned sender', () => {
    it('sends a zero-fleet account through the sweep and delivers its rows', async () => {
      await addUser('user-z');
      await enqueue('user-z');
      expect(await (await runSweep()).json()).toEqual({ swept: 1, pending: 1 });
      const [sent] = engine.bodies.map((b) => JSON.parse(b));
      expect(sent.version).toBe(2);
      expect(sent.principals[0]).toMatchObject({ principal: 'user-z', plan: 'trial', fleets: [], transfers: [], closing: null });
      expect(await pending('user-z')).toEqual([]);
      // Frozen: the row holds the revision, the hash and the snapshot that went out.
      const [row] = await q(`SELECT revision::int AS revision, payload_hash, snapshot FROM entitlement_outbox WHERE user_id = 'user-z' AND revision IS NOT NULL`);
      expect(row.revision).toBe(sent.principals[0].revision);
      expect(row.snapshot).toEqual(sent.principals[0]);
      expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('an unchanged, delivered account is not pushed again: no revision, no row, no request', async () => {
      await addUser('user-a', { fleet: 'fleet-a' });
      await ent.syncEntitlementsToEngine('user-a');
      for (let i = 0; i < 3; i++) { await enqueue('user-a'); await runSweep(); }
      expect(engine.bodies).toHaveLength(1);
      expect(await frozenRows('user-a')).toHaveLength(1);
      expect(await pending('user-a')).toEqual([]);
    });

    it('a lost acknowledgement: the same row is resent byte for byte, answered duplicate, delivered', async () => {
      await addUser('user-a', { fleet: 'fleet-a' });
      await enqueue('user-a');
      engine.loseAck = 1;
      await runSweep();
      expect((await pending('user-a')).map((r) => r.reason)).toEqual(['test', 'push']);
      await runSweep();
      expect(engine.bodies).toHaveLength(2);
      expect(engine.bodies[1]).toBe(engine.bodies[0]);
      expect(await frozenRows('user-a')).toEqual([expect.objectContaining({ delivered: true })]);
      expect(await pending('user-a')).toEqual([]);
      expect(engine.bindings.get('fleet-a')).toMatchObject({ principal: 'user-a', state: 'bound' });
    });

    it('an engine that is down: nothing delivered, nothing lost, no extra rows', async () => {
      await addUser('user-a', { fleet: 'fleet-a' });
      await enqueue('user-a');
      engine.down = true;
      await runSweep();
      await runSweep();
      expect(await frozenRows('user-a')).toHaveLength(1);
      engine.down = false;
      await runSweep();
      expect(await pending('user-a')).toEqual([]);
    });

    it.each(['conflict', 'rejected', 400])('repeated %s: an alert each time, one row, no growth; the next change supersedes it', async (refuse) => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await addUser('user-a', { fleet: 'fleet-a' });
      engine.refuse = refuse;
      for (let i = 0; i < 4; i++) { await enqueue('user-a'); await runSweep(); }
      expect(await frozenRows('user-a')).toEqual([{ revision: expect.any(Number), delivered: false }]);
      expect(err.mock.calls.filter((c) => String(c[0]).includes('ALERT')).length).toBe(4);
      // One request per push: only the newest row is ever sent.
      expect(engine.bodies).toHaveLength(4);
      expect(new Set(engine.bodies).size).toBe(1);

      // A change: a new revision; the refused row is replaced (delivered).
      engine.refuse = null;
      await q(`INSERT INTO subscriptions (user_id, plan, status) VALUES ('user-a', 'pro', 'active')`);
      await enqueue('user-a', 'subscription_active');
      await runSweep();
      const rows = await frozenRows('user-a');
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.delivered)).toBe(true);
      expect(JSON.parse(engine.bodies.at(-1)!).principals[0]).toMatchObject({ plan: 'pro', revision: rows[1].revision });
      expect(await pending('user-a')).toEqual([]);
    });

    it('a stale answer is dropped', async () => {
      await addUser('user-a', { fleet: 'fleet-a' });
      engine.refuse = 'stale';
      expect(await ent.syncEntitlementsToEngine('user-a')).toBe(true);
      expect(await pending('user-a')).toEqual([]);
    });

    it('each change takes a new, higher revision', async () => {
      await addUser('user-a', { fleet: 'fleet-a' });
      await ent.syncEntitlementsToEngine('user-a');
      await q(`INSERT INTO subscriptions (user_id, plan, status) VALUES ('user-a', 'pro', 'active')`);
      await enqueue('user-a', 'subscription_active');
      await runSweep();
      const sent = engine.bodies.map((b) => JSON.parse(b).principals[0]);
      expect(sent.map((s) => s.plan)).toEqual(['trial', 'pro']);
      expect(sent[1].revision).toBeGreaterThan(sent[0].revision);
      expect(sent[1].production).toMatchObject({ maxFleets: 10, retentionDays: 365 });
    });

    it('a deletion is delivered only once the engine confirms the closing time was stored', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await addUser('user-a', { fleet: 'fleet-a' });
      await q(`UPDATE users SET closes_at = now() + interval '14 days', close_reason = 'deleted', delete_after = now() + interval '14 days' WHERE id = 'user-a'`);
      await enqueue('user-a', 'account_closing');
      engine.dropClosing = true;
      await runSweep();
      expect(JSON.parse(engine.bodies[0]).principals[0].closing).toMatchObject({ reason: 'deleted' });
      expect(err.mock.calls.some((c) => String(c[0]).includes('closing: "stored"'))).toBe(true);
      expect((await pending('user-a')).length).toBe(2);
      engine.dropClosing = false;
      await runSweep();
      expect(await pending('user-a')).toEqual([]);
    });

    it('runs the lapse check on every push: a lapsed paid plan starts its window', async () => {
      await addUser('user-a', { fleet: 'fleet-a', trialEndsAt: '2026-01-01T00:00:00Z' });
      await ent.syncEntitlementsToEngine('user-a');
      await q(`INSERT INTO subscriptions (user_id, plan, status, lapsed_at) VALUES ('user-a', 'pro', 'canceled', now())`);
      await ent.syncEntitlementsToEngine('user-a');
      expect(await q(`SELECT close_reason, closes_at > now() AS future FROM users WHERE id = 'user-a'`)).toEqual([{ close_reason: 'lapsed', future: true }]);
      // A lapse is never sent as closing; the plan runs on during the window.
      expect(JSON.parse(engine.bodies.at(-1)!).principals[0]).toMatchObject({ plan: 'pro', closing: null });
      // Nothing changed since: the check still runs, nothing is sent.
      await ent.syncEntitlementsToEngine('user-a');
      expect(engine.bodies).toHaveLength(2);
    });
  });

  describe('ownership transfer', () => {
    const provision = (id: string, fleetId: string) => { actor.id = id; return users.upsertUserProvisioning({ apiKey: 'sk-wr-placeholder0000000000', fleetId, fleetToken: 'wr_placeholder_token' }); };

    it('provisioning a new fleet hands the old one to the next holder: old owner pushed first, the grant names the transfer', async () => {
      await addUser('user-a', { fleet: 'fleet-old', since: '2026-01-01' });
      await addUser('user-b');
      await q(`INSERT INTO user_fleets (user_id, fleet_id, label, created_at) VALUES ('user-b', 'fleet-old', 'shared', '2026-02-01')`);
      await ent.syncEntitlementsToEngine('user-a');
      expect(engine.bindings.get('fleet-old')).toMatchObject({ principal: 'user-a' });

      expect(await provision('user-a', 'fleet-new')).toEqual({ ok: true });

      const sent = engine.bodies.slice(1).map((b) => JSON.parse(b).principals[0]);
      expect(sent.map((p) => p.principal)).toEqual(['user-a', 'user-b']);
      expect(sent[1].revision).toBeGreaterThan(sent[0].revision);
      expect(sent[0].fleets).toEqual([{ id: 'fleet-new', role: 'production' }]);
      expect(sent[1]).toMatchObject({ fleets: [{ id: 'fleet-old', role: 'production' }], transfers: [{ fleet: 'fleet-old', from: 'user-a', to: 'user-b' }] });
      expect(engine.bindings.get('fleet-old')).toMatchObject({ principal: 'user-b', state: 'bound' });
      expect(engine.bindings.get('fleet-new')).toMatchObject({ principal: 'user-a', state: 'bound' });
      expect(await q(`SELECT count(*)::int AS n FROM entitlement_outbox WHERE delivered_at IS NULL`)).toEqual([{ n: 0 }]);
      for (const b of engine.bodies) expect(JSON.parse(b).version).toBe(2);
    });

    it('if the old owner’s push fails, the new owner still gets the fleet (the transfer), and the old owner’s later push doesn’t take it back', async () => {
      await addUser('user-a', { fleet: 'fleet-old', since: '2026-01-01' });
      await addUser('user-b');
      await q(`INSERT INTO user_fleets (user_id, fleet_id, label, created_at) VALUES ('user-b', 'fleet-old', 'shared', '2026-02-01')`);
      await ent.syncEntitlementsToEngine('user-a');
      const late = JSON.parse(engine.bodies[0]).principals[0];

      engine.down = true;
      await provision('user-a', 'fleet-new');
      engine.down = false;
      // The new owner first this time.
      await ent.syncEntitlementsToEngine('user-b');
      expect(engine.bindings.get('fleet-old')).toMatchObject({ principal: 'user-b' });
      await ent.syncEntitlementsToEngine('user-a');
      expect(engine.bindings.get('fleet-old')).toMatchObject({ principal: 'user-b', state: 'bound' });
      expect(engine.apply(late, JSON.stringify(late))).toBe('stale');
      expect(await q(`SELECT count(*)::int AS n FROM entitlement_outbox WHERE delivered_at IS NULL`)).toEqual([{ n: 0 }]);
    });

    it('two crossing transfers at once don’t deadlock', async () => {
      // a provisioned fleet-a, b provisioned fleet-b; each also linked the other's.
      await addUser('user-a', { fleet: 'fleet-a', since: '2026-01-01' });
      await addUser('user-b', { fleet: 'fleet-b', since: '2026-01-01' });
      await q(`INSERT INTO user_fleets (user_id, fleet_id, label, created_at) VALUES ('user-b', 'fleet-a', 'x', '2026-02-01'), ('user-a', 'fleet-b', 'x', '2026-02-01')`);
      // Each provisions a new fleet at the same moment, handing its old one to the other.
      const both = (async () => {
        const one = provision('user-a', 'fleet-a2');
        const two = provision('user-b', 'fleet-b2');
        return Promise.all([one, two]);
      })();
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlocked')), 10_000));
      expect(await Promise.race([both, timeout])).toEqual([{ ok: true }, { ok: true }]);
      await runSweep();
      expect(engine.bindings.get('fleet-a')).toMatchObject({ principal: 'user-b', state: 'bound' });
      expect(engine.bindings.get('fleet-b')).toMatchObject({ principal: 'user-a', state: 'bound' });
      expect(await q(`SELECT count(*)::int AS n FROM entitlement_outbox WHERE delivered_at IS NULL`)).toEqual([{ n: 0 }]);
    }, 20_000);

    it('a fleet nobody else holds is released by the old owner’s snapshot, with no unversioned post', async () => {
      await addUser('user-a', { fleet: 'fleet-old' });
      await ent.syncEntitlementsToEngine('user-a');
      await provision('user-a', 'fleet-new');
      expect(engine.bindings.get('fleet-old')).toMatchObject({ principal: null, state: 'revoked' });
      expect(engine.bindings.get('fleet-new')).toMatchObject({ principal: 'user-a', state: 'bound' });
      for (const b of engine.bodies) expect(JSON.parse(b)).not.toHaveProperty('fleets');
    });

    it('the account is pushed right after any fleet change, even one it still holds by a link', async () => {
      await addUser('user-a', { fleet: 'fleet-old' });
      await q(`INSERT INTO user_fleets (user_id, fleet_id, label) VALUES ('user-a', 'fleet-old', 'mine')`);
      await provision('user-a', 'fleet-new');
      expect(engine.bodies).toHaveLength(1);
      expect(JSON.parse(engine.bodies[0]).principals[0].fleets.map((f: { id: string }) => f.id)).toEqual(['fleet-new', 'fleet-old']);
    });
  });

  describe('trial_state backfill script', () => {
    it('sets active / ended from trial_ends_at, in batches, leaves trial_ends_at and set states alone, and re-runs cleanly', async () => {
      await q(`INSERT INTO users (id, trial_ends_at) SELECT 'bulk-' || g, now() + (CASE WHEN g % 2 = 0 THEN 1 ELSE -1 END) * interval '3 days' FROM generate_series(1, 2500) g`);
      await addUser('u-null-ends');
      await q(`UPDATE users SET trial_ends_at = NULL WHERE id = 'u-null-ends'`);
      await addUser('u-free', { trialState: 'not_started', trialEndsAt: '2026-11-01T00:00:00Z' });
      const before = await q(`SELECT id, trial_ends_at FROM users ORDER BY id`);

      const out = psql(['-f', script('backfill-trial-state.sql')]);
      expect(out.trim().split('\n').at(-1)).toBe('0|1250|1251|1');
      expect(await q(`SELECT trial_state FROM users WHERE id = 'u-null-ends'`)).toEqual([{ trial_state: 'ended' }]);
      expect(await q(`SELECT id, trial_ends_at FROM users ORDER BY id`)).toEqual(before);
      expect(psql(['-f', script('backfill-trial-state.sql')]).trim().split('\n').at(-1)).toBe('0|1250|1251|1');
    });
  });
});
