-- Account deletion and plan lapse (redesign Phase 7c, decision Q4).
--
-- Deleting an account, or its plan lapsing, starts a 14-day window instead
-- of acting at once. closes_at is when it ends; close_reason says which of
-- the two started it. During the window the fleets keep working and the
-- owner can export their data or cancel. At closes_at the engine closes the
-- account's fleets (it is sent the time with every entitlement push), and a
-- deleted account's rows are removed by the billing sync. NULL means the
-- account isn't closing, the common case.
--
-- Apply BEFORE deploying the dashboard that reads these columns, and deploy
-- the engine that understands closesAt before either.
--
-- Idempotent: safe to re-run, same as 001-011.
ALTER TABLE users ADD COLUMN IF NOT EXISTS closes_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS close_reason text;
-- Set when a deletion that has run out can't finish (a subscription, an
-- organization the account alone owns): the owner is told once, and the
-- billing sync only looks again once that may have changed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS close_blocked_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_close_reason_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_close_reason_check
      CHECK (close_reason IS NULL OR close_reason IN ('deleted', 'lapsed'));
  END IF;
END $$;

-- The billing sync looks for deletions that have run out.
CREATE INDEX IF NOT EXISTS users_closes_at_idx ON users (closes_at) WHERE closes_at IS NOT NULL;
