-- Starter / Pro / Enterprise.
--
-- Replaces the Free / Pro / Team catalogue with the tiers published on
-- whiteroom.tech: Starter is free for 90 days and then $10 a month, Pro is
-- $200 a month for 5 agents plus $10 for each one after that, Enterprise is a
-- hand-sold contract applied as a plan override.
--
-- Idempotent: safe to re-run, same as 001-006.

-- 1. The free Starter period.
--
--    Stored per user rather than derived from created_at, so an admin can
--    extend one account's trial without touching anything else. Existing
--    accounts start their 90 days on the day this runs: they signed up when
--    the free tier had no end date, and starting the clock at their real
--    sign-up date would expire some of them on the spot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
UPDATE users SET trial_ends_at = now() + interval '90 days' WHERE trial_ends_at IS NULL;
ALTER TABLE users ALTER COLUMN trial_ends_at SET DEFAULT now() + interval '90 days';
ALTER TABLE users ALTER COLUMN trial_ends_at SET NOT NULL;

--    Set once the billing sync has queued the engine update for an expired
--    trial, so that update is sent once rather than on every run. The trigger
--    below clears it whenever a trial is extended into the future, so an
--    extended trial is synced again when it ends.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_expiry_synced boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION users_reset_trial_expiry_synced() RETURNS trigger AS $$
BEGIN
  IF NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at AND NEW.trial_ends_at > now() THEN
    NEW.trial_expiry_synced := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_reset_trial_expiry_synced ON users;
CREATE TRIGGER users_reset_trial_expiry_synced
  BEFORE UPDATE OF trial_ends_at ON users
  FOR EACH ROW EXECUTE FUNCTION users_reset_trial_expiry_synced();

-- 2. The agent count a Pro subscription is currently billed for.
--
--    A copy of the Stripe subscription item's quantity, written by the
--    webhook. The billing sync compares the live agent count against this and
--    only calls Stripe when they differ, instead of fetching every Pro
--    subscription on every run.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billed_agents integer;

-- 3. Legacy plan values.
--
--    `plan` holds what Stripe last reported. The old 'free' default isn't a
--    plan any more; 'none' means "no paid plan" and lets the trial decide.
--    Overrides are mapped to the nearest new tier rather than dropped, so a
--    comped account keeps what it was given.
--
--    A subscription still billing on a retired price (Team) must not lose
--    access because its price id stopped meaning anything: it is comped to
--    Pro first, before its plan is cleared. Production had no Stripe
--    subscriptions when this was written, so this is a guard, not a fix.
ALTER TABLE subscriptions ALTER COLUMN plan SET DEFAULT 'none';
UPDATE subscriptions SET plan_override = 'pro'
  WHERE plan = 'team' AND plan_override IS NULL
    AND stripe_subscription_id IS NOT NULL
    AND status IN ('active', 'trialing', 'past_due');
UPDATE subscriptions SET plan = 'none' WHERE plan NOT IN ('starter', 'pro', 'none');
UPDATE subscriptions SET plan_override = 'pro' WHERE plan_override = 'team';
UPDATE subscriptions SET plan_override = 'starter' WHERE plan_override = 'free';
