import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Against a real Postgres: who the trial-ending reminder claims, and which
// email each gets. The claim query carries all of it (window, comped,
// closing, the choose/billing split, re-arming on an extended free period),
// so it is checked by its results rather than its text.
//
// Skipped unless WR_TEST_DATABASE names a scratch database you created for
// it (its users and subscriptions tables are dropped). Needs psql on PATH.
// For example:
//   createdb -h localhost -p 5433 wr_reminder_test
//   WR_TEST_DATABASE=wr_reminder_test DB_PORT=5433 npx vitest run src/__tests__/trial-ending-email.db.test.ts
//   dropdb -h localhost -p 5433 wr_reminder_test
const DB = process.env.WR_TEST_DATABASE;
const HOST = process.env.DB_HOST || '127.0.0.1';
const PORT = process.env.DB_PORT || '5433';

const send = vi.hoisted(() => vi.fn());
vi.mock('@/lib/email', () => ({ sendEmail: send }));

const migration = (f: string) => fileURLToPath(new URL(`../../migrations/${f}`, import.meta.url));

function psql(args: string[]): string {
  return execFileSync('psql', ['-h', HOST, '-p', PORT, '-d', DB!, '-v', 'ON_ERROR_STOP=1', '-qAt', ...args], { encoding: 'utf8' });
}

// The base tables have no DDL in this repo: a minimal stand-in with the
// columns this code reads (closes_at and trial_state come from 012 and 015).
const BASE_SCHEMA = `
DROP TABLE IF EXISTS subscriptions, users CASCADE;
CREATE TABLE users (
  id text PRIMARY KEY, email text,
  trial_ends_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  trial_state text, closes_at timestamptz
);
CREATE TABLE subscriptions (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id text, stripe_subscription_id text, plan text NOT NULL DEFAULT 'none', status text NOT NULL DEFAULT 'incomplete',
  plan_override text, cancel_at_period_end boolean NOT NULL DEFAULT false
);`;

const suite = DB ? describe : describe.skip;

suite('trial-ending reminders against Postgres', () => {
  let db: typeof import('@/lib/db').db;
  let sendTrialEndingEmails: typeof import('@/lib/trial-ending-email').sendTrialEndingEmails;

  const q = async (sql: string, params: unknown[] = []) => (await db().query(sql, params)).rows;
  const addUser = (id: string, opts: { endsInDays?: number; trialState?: string | null; closing?: boolean } = {}) => q(
    `INSERT INTO users (id, email, trial_ends_at, trial_state, closes_at)
     VALUES ($1, $1 || '@example.com', now() + make_interval(secs => $2::float8 * 86400), $3,
             CASE WHEN $4 THEN now() + interval '14 days' END)`,
    [id, opts.endsInDays ?? 3, opts.trialState ?? 'active', opts.closing ?? false],
  );
  const addSub = (userId: string, plan: string, status: string, opts: { override?: string; cancelAtPeriodEnd?: boolean } = {}) => q(
    `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status, plan_override, cancel_at_period_end)
     VALUES ($1, 'cus_' || $1, 'sub_' || $1, $2, $3, $4, $5)`,
    [userId, plan, status, opts.override ?? null, opts.cancelAtPeriodEnd ?? false],
  );
  /** Recipient -> subject, for the emails the last run sent. */
  const sent = () => Object.fromEntries(send.mock.calls.map(([m]) => [m.to.split('@')[0], m.subject as string]));

  beforeAll(async () => {
    Object.assign(process.env, {
      DB_HOST: HOST, DB_PORT: PORT, DB_NAME: DB, DB_USER: process.env.DB_USER || process.env.USER,
      AUTH_URL: 'https://app.whiteroom.tech',
    });
    psql(['-c', BASE_SCHEMA]);
    psql(['-f', migration('017_trial_ending_email.sql')]);
    ({ db } = await import('@/lib/db'));
    ({ sendTrialEndingEmails } = await import('@/lib/trial-ending-email'));
  });
  afterAll(async () => { await db?.().end(); });
  beforeEach(async () => {
    await q(`TRUNCATE subscriptions, users CASCADE`);
    send.mockReset().mockResolvedValue(undefined);
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_STARTER_SHARE = 'price_starter_share';
  });

  it('sends a plan choice to an unpaid account and a billing notice to a card-backed one, and nothing to anyone else', async () => {
    await addUser('no-plan');
    await addUser('legacy-state', { trialState: null });
    await addUser('pro-card'); await addSub('pro-card', 'pro', 'trialing');
    await addUser('starter-card'); await addSub('starter-card', 'starter', 'trialing');
    await addUser('abandoned-checkout'); await addSub('abandoned-checkout', 'none', 'incomplete');
    // None of these:
    await addUser('pro-cancelling'); await addSub('pro-cancelling', 'pro', 'trialing', { cancelAtPeriodEnd: true });
    await addUser('already-billing'); await addSub('already-billing', 'pro', 'active');
    await addUser('comped'); await addSub('comped', 'none', 'incomplete', { override: 'pro' });
    await addUser('closing', { closing: true });
    await addUser('free-not-live', { trialState: 'not_started' });
    await addUser('too-early', { endsInDays: 8 });
    await addUser('already-ended', { endsInDays: -1, trialState: 'ended' });

    expect(await sendTrialEndingEmails()).toEqual({ sent: 5, failed: 0 });
    const s = sent();
    expect(Object.keys(s).sort()).toEqual(['abandoned-checkout', 'legacy-state', 'no-plan', 'pro-card', 'starter-card']);
    expect(s['no-plan']).toMatch(/^Your WhiteRoom free period ends on /);
    expect(s['abandoned-checkout']).toMatch(/^Your WhiteRoom free period ends on /);
    expect(s['pro-card']).toMatch(/^Your WhiteRoom Teams plan starts billing on /);
    expect(s['starter-card']).toMatch(/^Your WhiteRoom Individual plan starts billing on /);
  });

  it('sends once per free-period end, and once more when the free period is extended', async () => {
    await addUser('u1');
    await sendTrialEndingEmails();
    expect(send).toHaveBeenCalledTimes(1);

    send.mockClear();
    expect(await sendTrialEndingEmails()).toEqual({ sent: 0, failed: 0 });

    await q(`UPDATE users SET trial_ends_at = trial_ends_at + interval '2 days' WHERE id = 'u1'`);
    expect(await sendTrialEndingEmails()).toEqual({ sent: 1, failed: 0 });
  });

  it('retries a failed send on the next run', async () => {
    await addUser('u1');
    send.mockRejectedValueOnce(new Error('resend down'));
    expect(await sendTrialEndingEmails()).toEqual({ sent: 0, failed: 1 });
    expect((await q(`SELECT trial_ending_email_for FROM users WHERE id = 'u1'`))[0].trial_ending_email_for).toBeNull();
    expect(await sendTrialEndingEmails()).toEqual({ sent: 1, failed: 0 });
  });

  it('holds plan choices, but not billing notices, while no plan can be bought, then sends them once one can', async () => {
    delete process.env.STRIPE_PRICE_STARTER_SHARE;
    await addUser('no-plan');
    await addUser('pro-card'); await addSub('pro-card', 'pro', 'trialing');
    expect(await sendTrialEndingEmails()).toEqual({ sent: 1, failed: 0 });
    expect(Object.keys(sent())).toEqual(['pro-card']);

    send.mockClear();
    process.env.STRIPE_PRICE_STARTER_SHARE = 'price_starter_share';
    expect(await sendTrialEndingEmails()).toEqual({ sent: 1, failed: 0 });
    expect(Object.keys(sent())).toEqual(['no-plan']);
  });
});
