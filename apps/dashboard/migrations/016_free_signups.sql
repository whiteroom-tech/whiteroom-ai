-- Free sign-ups: the per-address and per-identity counts, and when a
-- deferred account's Sandbox opens.
--
-- Additive only: one nullable column with no default and one new table.
-- Nothing reads either while FREE_PLAN is off, so the dashboard running today
-- is unaffected.
--
-- Apply BEFORE FREE_PLAN is set to invite or public in any region: to the
-- staging DB, then US prod, then EU. Safe to apply any time before that.
--
-- Idempotent: safe to re-run, same as 001-015. Plain psql -f (not -1) is fine.

-- Fail fast rather than queue behind live traffic on users (which would
-- block every sign-in while waiting); on a timeout, run it again.
SET lock_timeout = '5s';

-- When a Free account's Sandbox opens: the next 00:00 UTC for a sign-up made
-- over the day's cap (or over the per-address or per-identity limit). NULL =
-- open now. Never set for non-Free accounts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sandbox_opens_at timestamptz;

-- One row per Free sign-up. ip_hash is a keyed hash of the sign-up's client
-- address (the address itself is never stored); email_key is the address
-- with any +tag removed, so a+1@x.com counts as a@x.com. Deleted with the
-- account.
CREATE TABLE IF NOT EXISTS free_signups (
  user_id    text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  ip_hash    text NOT NULL,
  email_key  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS free_signups_created_at_idx ON free_signups (created_at);
CREATE INDEX IF NOT EXISTS free_signups_email_key_idx ON free_signups (email_key);
