-- The trial-ending reminder: which free-period end it was sent for.
--
-- Additive only: one nullable column with no default, so the dashboard
-- running today is unaffected.
--
-- Apply BEFORE the code that reads it: to the staging DB before merging
-- (merges auto-deploy to staging), then to US prod and EU right after.
--
-- Idempotent: safe to re-run, same as 001-016. Plain psql -f (not -1) is fine.

-- Fail fast rather than queue behind live traffic on users (which would
-- block every sign-in while waiting); on a timeout, run it again.
SET lock_timeout = '5s';

-- The trial_ends_at the reminder went out for. Compared with the current
-- trial_ends_at rather than kept as a flag, so a free period that is
-- extended gets one reminder for its new end. NULL = never sent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ending_email_for timestamptz;
