-- Entitlement revisions (sent only with ENTITLEMENTS_V2=on) and the trial
-- state an account's free period is in.
--
-- Additive only: a new sequence and nullable columns with no defaults, so
-- code that doesn't know about them (including the dashboard running today)
-- is unaffected. Nothing here is backfilled: trial_state NULL means "derive
-- from trial_ends_at exactly as before" (see trialStatus in src/lib/plans.ts).
-- The trial_state backfill is a separate, batched script
-- (scripts/backfill-trial-state.sql), run by hand later.
--
-- Apply BEFORE the code that reads it: to the staging DB before merging
-- (merges auto-deploy to staging), then to US prod and EU right after.
--
-- Idempotent: safe to re-run, same as 001-014. Plain psql -f (not -1) is fine.

-- Fail fast rather than queue behind live traffic on users or the outbox
-- (which would block every sign-in while waiting); on a timeout, run it again.
SET lock_timeout = '5s';

-- One revision counter for every account in this region, so revisions are
-- comparable across accounts. Taken when a push is built.
CREATE SEQUENCE IF NOT EXISTS entitlement_revision AS bigint;

-- A push's revision, the hash of what it sent and the snapshot itself,
-- frozen into the outbox row so a resend is exactly the same push. NULL on
-- rows written before this, and on rows that just record a change to send.
ALTER TABLE entitlement_outbox ADD COLUMN IF NOT EXISTS revision bigint;
ALTER TABLE entitlement_outbox ADD COLUMN IF NOT EXISTS payload_hash text;
ALTER TABLE entitlement_outbox ADD COLUMN IF NOT EXISTS snapshot jsonb;
-- Fleets moving to this account (an ownership change), named in its next
-- snapshot. NULL on every other row.
ALTER TABLE entitlement_outbox ADD COLUMN IF NOT EXISTS transfers jsonb;

-- The free period's state: 'not_started' (a Free account that hasn't gone
-- live), 'active' or 'ended'. NULL = written by code from before this, read
-- from trial_ends_at as before. trial_started_at: when it was activated.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_state text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;

-- Only the three states (or NULL). Added NOT VALID so adding it doesn't scan
-- users under a lock, then validated, which doesn't block writes. Every row is
-- NULL here, so validation always passes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_trial_state_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_trial_state_check
      CHECK (trial_state IS NULL OR trial_state IN ('not_started', 'active', 'ended')) NOT VALID;
  END IF;
END $$;
ALTER TABLE users VALIDATE CONSTRAINT users_trial_state_check;
