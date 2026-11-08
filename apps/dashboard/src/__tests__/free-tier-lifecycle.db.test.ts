import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// Against a real Postgres: Suspended in place of the ended free period, a
// paid lapse's 14-day grace then Suspended (never closed), a deletion that
// still closes, the closed-account cancel pass leaving lapses alone, the
// lapse cutover script, and the organization rules (R9).
//
// Skipped unless WR_TEST_DATABASE names a scratch database you created for
// it (every table in it is dropped). Needs psql on PATH. For example:
//   createdb -h localhost -p 5433 wr_d2_test
//   WR_TEST_DATABASE=wr_d2_test DB_PORT=5433 npx vitest run src/__tests__/free-tier-lifecycle.db.test.ts
//   dropdb -h localhost -p 5433 wr_d2_test
const DB = process.env.WR_TEST_DATABASE;
const HOST = process.env.DB_HOST || '127.0.0.1';
const PORT = process.env.DB_PORT || '5433';

const actor = vi.hoisted(() => ({ id: 'user-a' }));
const stripeApi = vi.hoisted(() => ({ retrieve: vi.fn(), cancel: vi.fn() }));
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: actor.id, email: `${actor.id}@example.com` } }), signOut: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/fleet-usage', () => ({ fetchFleetUsage: async () => ({ byFleet: new Map(), windowDays: null }) }));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'http://engine.test', tokenLogin: async () => ({}), isAuthError: () => false }));
vi.mock('@/lib/stripe', () => ({
  stripe: () => ({
    subscriptions: { retrieve: stripeApi.retrieve, cancel: stripeApi.cancel },
    invoices: { list: () => (async function* () {})(), voidInvoice: vi.fn() },
  }),
}));

const migration = (f: string) => fileURLToPath(new URL(`../../migrations/${f}`, import.meta.url));
const script = (f: string) => fileURLToPath(new URL(`../../scripts/${f}`, import.meta.url));

function psql(args: string[]): string {
  return execFileSync('psql', ['-h', HOST, '-p', PORT, '-d', DB!, '-v', 'ON_ERROR_STOP=1', '-qAt', ...args], { encoding: 'utf8' });
}

// The base tables have no DDL in this repo: a minimal stand-in with the columns this code reads.
const BASE_SCHEMA = `
DROP TABLE IF EXISTS organization_audit_log, organization_members, organizations, entitlement_outbox, email_change_requests, user_fleets, subscriptions, users CASCADE;
DROP SEQUENCE IF EXISTS entitlement_revision;
CREATE TABLE users (
  id text PRIMARY KEY, email text, name text, role text NOT NULL DEFAULT 'user',
  api_key text, api_key_enc text, fleet_id text, fleet_token text, fleet_token_enc text,
  byok boolean NOT NULL DEFAULT false, trial_expiry_synced boolean NOT NULL DEFAULT false,
  trial_ends_at timestamptz DEFAULT now() + interval '30 days',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE subscriptions (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id text, stripe_subscription_id text, plan text NOT NULL DEFAULT 'none', status text NOT NULL DEFAULT 'incomplete',
  plan_override text, current_period_end timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_fleets (
  id serial PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fleet_token text, fleet_token_enc text, fleet_id text, label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_change_requests (user_id text);`;

/** What the engine was sent, v1 bodies only (ENTITLEMENTS_V2 off, today's sender). */
const engine = { bodies: [] as Array<{ fleets: Array<Record<string, unknown>> }> };
async function engineFetch(_url: string, init: { body: string }): Promise<Response> {
  const body = JSON.parse(init.body);
  engine.bodies.push(body);
  return Response.json({ applied: (body.fleets ?? []).map((f: { fleetId: string }) => f.fleetId), unknown: [], closed: [] });
}

const suite = DB ? describe : describe.skip;

suite('Free tier D2 lifecycle against Postgres', () => {
  let db: typeof import('@/lib/db').db;
  let ent: typeof import('@/lib/entitlements');
  let closing: typeof import('@/lib/account-closing');
  let account: typeof import('@/lib/account');
  let orgs: typeof import('@/lib/organizations');
  let sweep: typeof import('@/app/api/internal/entitlement-sweep/route').POST;
  let billingSync: typeof import('@/app/api/internal/billing-sync/route').POST;

  const q = async (sql: string, params: unknown[] = []) => (await db().query(sql, params)).rows;
  const secret = { headers: { 'x-wr-sync-secret': 'test-sync-secret' } };
  const runSweep = () => sweep(new Request('http://dash.test/api/internal/entitlement-sweep', { method: 'POST', ...secret }));
  const runBillingSync = () => billingSync(new Request('http://dash.test/api/internal/billing-sync', { method: 'POST', ...secret }));
  const addUser = (id: string, opts: { fleet?: string | null; trialEndsAt?: string; trialState?: string | null } = {}) => q(
    `INSERT INTO users (id, email, fleet_id, trial_ends_at, trial_state, fleet_provisioned_at)
     VALUES ($1, $1 || '@example.com', $2, COALESCE($3::timestamptz, now() + interval '20 days'), $4, now())`,
    [id, opts.fleet ?? null, opts.trialEndsAt ?? null, opts.trialState ?? null],
  );
  const addSub = (userId: string, plan: string, status: string, lapsedDaysAgo: number | null, subId: string | null = `sub_${userId}`) => q(
    `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status, lapsed_at)
     VALUES ($1, 'cus_' || $1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END)`,
    [userId, subId, plan, status, lapsedDaysAgo],
  );
  const lastPush = (fleetId: string) => [...engine.bodies].reverse().flatMap((b) => b.fleets ?? []).find((f) => f.fleetId === fleetId);
  const closingOf = async (id: string) => (await q(`SELECT closes_at IS NOT NULL AS closing, close_reason FROM users WHERE id = $1`, [id]))[0];

  beforeAll(async () => {
    Object.assign(process.env, {
      DB_HOST: HOST, DB_PORT: PORT, DB_NAME: DB, DB_USER: process.env.DB_USER || process.env.USER,
      WR_ENTITLEMENT_SYNC_SECRET: 'test-sync-secret',
      WR_CRED_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    psql(['-c', BASE_SCHEMA]);
    for (const f of ['005_entitlement_outbox.sql', '006_organizations.sql', '012_account_closing.sql', '013_outbox_not_before.sql',
      '014_fleet_provisioned_at.sql', '015_entitlement_revisions_trial_state.sql']) psql(['-f', migration(f)]);
    ({ db } = await import('@/lib/db'));
    ent = await import('@/lib/entitlements');
    closing = await import('@/lib/account-closing');
    account = await import('@/lib/account');
    orgs = await import('@/lib/organizations');
    ({ POST: sweep } = await import('@/app/api/internal/entitlement-sweep/route'));
    ({ POST: billingSync } = await import('@/app/api/internal/billing-sync/route'));
  });
  afterAll(async () => { await db?.().end(); });
  beforeEach(async () => {
    await q(`TRUNCATE organization_audit_log, organization_members, organizations, entitlement_outbox, user_fleets, subscriptions, users CASCADE`);
    engine.bodies = [];
    vi.stubGlobal('fetch', vi.fn(engineFetch));
    delete process.env.ENTITLEMENTS_V2;
    delete process.env.FREE_PLAN;
    delete process.env.STRIPE_SECRET_KEY;
    stripeApi.retrieve.mockReset();
    stripeApi.cancel.mockReset();
    actor.id = 'user-a';
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.FREE_PLAN; });

  describe('an ended free period is Suspended', () => {
    it('whether its trial state is unset (as today) or backfilled: switched off, kept, never Free', async () => {
      await addUser('u-legacy', { fleet: 'fleet-legacy', trialEndsAt: '2026-01-01T00:00:00Z' });
      await addUser('u-ended', { fleet: 'fleet-ended', trialEndsAt: '2026-01-01T00:00:00Z', trialState: 'ended' });
      for (const id of ['u-legacy', 'u-ended']) {
        expect((await ent.resolvePlan(id)).plan).toBe('suspended');
        expect(await ent.syncEntitlementsToEngine(id)).toBe(true);
        expect(await closingOf(id)).toEqual({ closing: false, close_reason: null });
      }
      expect(lastPush('fleet-legacy')).toMatchObject({ plan: 'suspended', status: 'inactive', maxAgents: 0, retentionDays: 30, closesAt: null });
      expect(lastPush('fleet-ended')).toMatchObject({ plan: 'suspended', status: 'inactive' });
    });

    it('the billing sync still queues the switch-off once the free period runs out', async () => {
      await addUser('u-running-out', { fleet: 'fleet-r', trialEndsAt: new Date(Date.now() - 60_000).toISOString() });
      expect(await (await runBillingSync()).json()).toMatchObject({ trialsQueued: 1, gracesQueued: 0 });
      await runSweep();
      expect(lastPush('fleet-r')).toMatchObject({ plan: 'suspended', status: 'inactive' });
    });

    it('with ENTITLEMENTS_V2 on, the snapshot says Suspended with no production access', async () => {
      process.env.ENTITLEMENTS_V2 = 'on';
      await addUser('u-legacy', { fleet: 'fleet-legacy', trialEndsAt: '2026-01-01T00:00:00Z' });
      const sent: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
        sent.push(init.body);
        const { principals } = JSON.parse(init.body);
        return Response.json({ results: principals.map((p: { principal: string; revision: number }) => ({ principal: p.principal, revision: p.revision, outcome: 'applied' })) });
      }));
      expect(await ent.syncEntitlementsToEngine('u-legacy')).toBe(true);
      expect(JSON.parse(sent[0]).principals[0]).toMatchObject({ plan: 'suspended', production: { access: false, maxAgentsPerFleet: 0 } });
    });
  });

  describe('a paid plan that lapses, LAPSE_SUSPEND unset (merged dark: today\'s behaviour)', () => {
    it('starts the 14-day closing window and keeps the plan running in it, as before; the billing sync queues no grace', async () => {
      await addUser('u-pro', { fleet: 'fleet-pro', trialEndsAt: '2026-01-01T00:00:00Z' });
      await addSub('u-pro', 'pro', 'canceled', 0);
      expect((await ent.resolvePlan('u-pro')).plan).toBe('suspended');
      expect(await ent.syncEntitlementsToEngine('u-pro')).toBe(true);
      expect(await closingOf('u-pro')).toEqual({ closing: true, close_reason: 'lapsed' });
      expect(lastPush('fleet-pro')).toMatchObject({ plan: 'pro', status: 'active', closeReason: 'lapsed' });
      await q(`UPDATE subscriptions SET lapsed_at = now() - interval '15 days' WHERE user_id = 'u-pro'`);
      expect(await (await runBillingSync()).json()).toMatchObject({ gracesQueued: 0 });
    });

    it('a closed account\'s subscriptions are cancelled, lapsed or not, as before', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_x';
      await addUser('u-lapse', { trialEndsAt: '2026-01-01T00:00:00Z' });
      await addSub('u-lapse', 'pro', 'unpaid', 30);
      await q(`UPDATE users SET closes_at = now() - interval '1 day', close_reason = 'lapsed' WHERE id = 'u-lapse'`);
      stripeApi.retrieve.mockResolvedValue({ status: 'unpaid' });
      stripeApi.cancel.mockResolvedValue({ status: 'canceled' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await closing.cancelClosedSubscriptions()).toEqual({ cancelled: 1, failed: 0 });
    });
  });

  describe('a paid plan that lapses, LAPSE_SUSPEND=on', () => {
    beforeEach(() => { process.env.LAPSE_SUSPEND = 'on'; });
    afterEach(() => { delete process.env.LAPSE_SUSPEND; });

    it('keeps its plan for 14 days with no window, then is Suspended once, never closed', async () => {
      await addUser('u-pro', { fleet: 'fleet-pro', trialEndsAt: '2026-01-01T00:00:00Z' });
      await addSub('u-pro', 'pro', 'canceled', 3);
      expect((await ent.resolvePlan('u-pro')).plan).toBe('pro');
      expect(await ent.syncEntitlementsToEngine('u-pro')).toBe(true);
      expect(lastPush('fleet-pro')).toMatchObject({ plan: 'pro', status: 'active', maxAgents: 500, closesAt: null, closeReason: null });
      expect(await closingOf('u-pro')).toEqual({ closing: false, close_reason: null });
      // Still in its grace: nothing for the billing sync to queue.
      expect(await (await runBillingSync()).json()).toMatchObject({ gracesQueued: 0 });

      await q(`UPDATE subscriptions SET lapsed_at = now() - interval '14 days 1 minute' WHERE user_id = 'u-pro'`);
      expect((await ent.resolvePlan('u-pro')).plan).toBe('suspended');
      expect(await (await runBillingSync()).json()).toMatchObject({ gracesQueued: 1 });
      // Once per lapse, however often the sync runs.
      expect(await (await runBillingSync()).json()).toMatchObject({ gracesQueued: 0 });
      await runSweep();
      expect(lastPush('fleet-pro')).toMatchObject({ plan: 'suspended', status: 'inactive', maxAgents: 0, closesAt: null, closeReason: null });
      expect(await closingOf('u-pro')).toEqual({ closing: false, close_reason: null });
      expect(await q(`SELECT count(*)::int AS n FROM entitlement_outbox WHERE user_id = 'u-pro' AND delivered_at IS NULL`)).toEqual([{ n: 0 }]);

      // A new lapse after paying again gets its own grace end queued.
      await q(`UPDATE subscriptions SET status = 'active', lapsed_at = NULL WHERE user_id = 'u-pro'`);
      await q(`UPDATE subscriptions SET status = 'canceled', lapsed_at = now() - interval '15 days' WHERE user_id = 'u-pro'`);
      await q(`UPDATE entitlement_outbox SET created_at = now() - interval '20 days' WHERE user_id = 'u-pro'`);
      expect(await (await runBillingSync()).json()).toMatchObject({ gracesQueued: 1 });
    });

    it('a lapse window started before this is cancelled on the next push; the engine gets no closing time', async () => {
      await addUser('u-old', { fleet: 'fleet-old', trialEndsAt: '2026-01-01T00:00:00Z' });
      await addSub('u-old', 'starter', 'canceled', 5);
      await q(`UPDATE users SET closes_at = now() + interval '9 days', close_reason = 'lapsed' WHERE id = 'u-old'`);
      expect(await ent.syncEntitlementsToEngine('u-old')).toBe(true);
      expect(await closingOf('u-old')).toEqual({ closing: false, close_reason: null });
      expect(lastPush('fleet-old')).toMatchObject({ plan: 'starter', status: 'active', closesAt: null, closeReason: null });
    });

    it('an account already closed by an old lapse window still has its subscription cancelled', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_x';
      await addUser('u-lapse', { trialEndsAt: '2026-01-01T00:00:00Z' });
      await addSub('u-lapse', 'pro', 'unpaid', 30);
      await q(`UPDATE users SET closes_at = now() - interval '1 day', close_reason = 'lapsed' WHERE id = 'u-lapse'`);
      stripeApi.retrieve.mockResolvedValue({ status: 'unpaid' });
      stripeApi.cancel.mockResolvedValue({ status: 'canceled' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await closing.cancelClosedSubscriptions()).toEqual({ cancelled: 1, failed: 0 });
      expect(await q(`SELECT status FROM subscriptions WHERE user_id = 'u-lapse'`)).toEqual([{ status: 'canceled' }]);
    });
  });

  describe('a deletion', () => {
    it('LAPSE_SUSPEND unset: cancelling it during a lapse goes back to the lapse window, as before', async () => {
      actor.id = 'u-del';
      await addUser('u-del', { fleet: 'fleet-del', trialEndsAt: '2026-01-01T00:00:00Z' });
      await addSub('u-del', 'pro', 'canceled', 2, null);
      expect(await account.deleteAccount('u-del@example.com')).toEqual({ ok: true });
      expect(await account.cancelAccountDeletion()).toEqual({ ok: true });
      expect(await closingOf('u-del')).toEqual({ closing: true, close_reason: 'lapsed' });
    });

    it('LAPSE_SUSPEND=on: still starts its 14-day window, reaches the engine, and cancels without going back to a lapse', async () => {
      process.env.LAPSE_SUSPEND = 'on';
      onTestFinished(() => { delete process.env.LAPSE_SUSPEND; });
      actor.id = 'u-del';
      await addUser('u-del', { fleet: 'fleet-del', trialEndsAt: '2026-01-01T00:00:00Z' });
      await addSub('u-del', 'pro', 'canceled', 2, null);
      expect(await account.deleteAccount('u-del@example.com')).toEqual({ ok: true });
      const [row] = await q(`SELECT close_reason, round(extract(epoch FROM closes_at - now()) / 86400)::int AS days, closes_at = delete_after AS same FROM users WHERE id = 'u-del'`);
      expect(row).toEqual({ close_reason: 'deleted', days: 14, same: true });
      // In its grace the fleet keeps running on Pro while the deletion window runs.
      expect(lastPush('fleet-del')).toMatchObject({ plan: 'pro', status: 'active', closeReason: 'deleted' });
      expect(lastPush('fleet-del')?.closesAt).toBeTruthy();

      expect(await account.cancelAccountDeletion()).toEqual({ ok: true });
      expect(await closingOf('u-del')).toEqual({ closing: false, close_reason: null });
      expect(lastPush('fleet-del')).toMatchObject({ closesAt: null, closeReason: null });
    });
  });

  describe('the lapse cutover script', () => {
    it('exports first, clears running lapses and listed unclosed ones, never a deletion or a closed fleet, queues pushes, and re-runs cleanly', async () => {
      await addUser('u-pending', { fleet: 'fleet-p' });
      await addUser('u-ended-open', { fleet: 'fleet-eo' });
      await addUser('u-linked', {});
      await q(`INSERT INTO user_fleets (user_id, fleet_id, label) VALUES ('u-linked', 'fleet-l', 'x')`);
      await addUser('u-closed', { fleet: 'fleet-c' });
      await addUser('u-deleting', { fleet: 'fleet-d' });
      await q(`UPDATE users SET closes_at = now() + interval '5 days', close_reason = 'lapsed' WHERE id = 'u-pending'`);
      await q(`UPDATE users SET closes_at = now() - interval '2 days', close_reason = 'lapsed' WHERE id IN ('u-ended-open', 'u-linked', 'u-closed')`);
      await q(`UPDATE users SET closes_at = now() + interval '5 days', close_reason = 'deleted', delete_after = now() + interval '5 days' WHERE id = 'u-deleting'`);

      const dir = mkdtempSync(join(tmpdir(), 'wr-lapse-'));
      const exportFile = join(dir, 'export.csv');
      psql(['-v', `export=${exportFile}`, '-v', 'fleets=fleet-eo, fleet-l', '-f', script('clear-pending-lapses.sql')]);

      const csv = readFileSync(exportFile, 'utf8').trim().split('\n');
      expect(csv[0]).toMatch(/^id,closes_at,close_reason,/);
      expect(csv.slice(1).map((l) => l.split(',')[0]).sort()).toEqual(['u-closed', 'u-ended-open', 'u-linked', 'u-pending']);
      expect(await q(`SELECT id, close_reason FROM users WHERE closes_at IS NOT NULL ORDER BY id`)).toEqual([
        { id: 'u-closed', close_reason: 'lapsed' },
        { id: 'u-deleting', close_reason: 'deleted' },
      ]);
      expect(await q(`SELECT user_id, reason FROM entitlement_outbox ORDER BY user_id`)).toEqual([
        { user_id: 'u-ended-open', reason: 'lapse_cleared' },
        { user_id: 'u-linked', reason: 'lapse_cleared' },
        { user_id: 'u-pending', reason: 'lapse_cleared' },
      ]);

      // Again, without a fleet list: nothing left to clear.
      psql(['-v', `export=${join(dir, 'again.csv')}`, '-f', script('clear-pending-lapses.sql')]);
      expect(await q(`SELECT count(*)::int AS n FROM entitlement_outbox`)).toEqual([{ n: 3 }]);
      expect(await closingOf('u-closed')).toEqual({ closing: true, close_reason: 'lapsed' });
    });
  });

  describe('organizations (R9)', () => {
    const makeOrg = async (ownerId: string) => {
      const [{ id }] = await q(`INSERT INTO organizations (name) VALUES ('Acme') RETURNING id`);
      await q(`INSERT INTO organization_members (org_id, user_id, role, status, accepted_at) VALUES ($1, $2, 'owner', 'active', now())`, [id, ownerId]);
      return id as string;
    };
    const invite = (orgId: string, userId: string) => q(`INSERT INTO organization_members (org_id, user_id, role, status) VALUES ($1, $2, 'member', 'invited')`, [orgId, userId]);

    it('a Free invitee joins an org whose owner pays, and its own plan stays Free', async () => {
      await addUser('u-owner', { trialEndsAt: '2026-01-01T00:00:00Z' });
      await addSub('u-owner', 'pro', 'active', null);
      await addUser('u-free', { trialEndsAt: '2026-01-01T00:00:00Z', trialState: 'not_started' });
      const orgId = await makeOrg('u-owner');
      await invite(orgId, 'u-free');
      await orgs.acceptInvitation({ id: 'u-free', email: 'u-free@example.com' }, orgId);
      expect(await q(`SELECT status FROM organization_members WHERE user_id = 'u-free'`)).toEqual([{ status: 'active' }]);
      expect((await ent.resolvePlan('u-free')).plan).toBe('free');
      expect(await q(`SELECT count(*)::int AS n FROM entitlement_outbox`)).toEqual([{ n: 0 }]);
    });

    it('an org whose owner is Free refuses the invitee; a Suspended owner only once the Free plan is on', async () => {
      await addUser('u-free-owner', { trialEndsAt: '2026-01-01T00:00:00Z', trialState: 'not_started' });
      await addUser('u-susp-owner', { trialEndsAt: '2026-01-01T00:00:00Z' });
      await addUser('u-invitee', {});
      const freeOrg = await makeOrg('u-free-owner');
      const suspOrg = await makeOrg('u-susp-owner');
      await invite(freeOrg, 'u-invitee');
      await invite(suspOrg, 'u-invitee');
      const me = { id: 'u-invitee', email: 'u-invitee@example.com' };
      await expect(orgs.acceptInvitation(me, freeOrg)).rejects.toThrow(/owner needs a paid plan/);

      process.env.FREE_PLAN = 'invite';
      await expect(orgs.acceptInvitation(me, suspOrg)).rejects.toThrow(/owner needs a paid plan/);
      delete process.env.FREE_PLAN;
      await orgs.acceptInvitation(me, suspOrg);
      expect(await q(`SELECT org_id FROM organization_members WHERE user_id = 'u-invitee' AND status = 'active'`)).toEqual([{ org_id: suspOrg }]);
    });
  });
});
