-- Clears plan-lapse closing windows on the dashboard database, once.
--
-- NOT a migration and not run by any deploy. Run by hand, once per region,
-- only once LAPSE_SUSPEND=on is live in that region (a lapsed paid plan
-- then keeps its plan for 14 days and is Suspended, with no window); before
-- that, the running dashboard would start the windows again and re-send the
-- closing email. Run the engine database's step first: it
-- prints the fleets whose lapse it cleared, which this one takes as `fleets`.
--
-- What it does, in one transaction:
-- 1. Locks every account with a lapse window (the same users row lock the
--    deletion and closing code takes), so a deletion or cancel racing this
--    resolves to one of them.
-- 2. Exports those rows, as they were, to a CSV on this machine (`export`).
--    Keep it: restoring from it is the rollback.
-- 3. Clears the lapse window (closes_at, close_reason) of every account
--    whose window is still running, and of every account owning a fleet
--    the engine step listed (its window ended, but the engine never closed
--    the fleet). A deletion is never touched.
-- 4. Queues an entitlement push for each account it cleared, so the engine
--    hears the window is gone.
-- 5. Lists the lapse windows left: fleets that really closed. Closed stays
--    closed; these are for a person to look at.
--
-- Run with psql, from apps/dashboard:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v export=lapsed-dashboard-<region>.csv -v fleets='<ids from the engine step, comma-separated>' \
--     -f scripts/clear-pending-lapses.sql
-- `fleets` may be left out (or empty) when the engine step cleared none.
-- Re-running is safe: a cleared account has no lapse window left to clear.

\set ON_ERROR_STOP on
\if :{?export}
\else
  \set export lapsed-dashboard-export.csv
\endif
\if :{?fleets}
\else
  \set fleets ''
\endif

BEGIN;
-- Fail fast rather than queue behind live traffic; on a timeout, run it again.
SET LOCAL lock_timeout = '5s';

-- 1. Lock.
SELECT id FROM users WHERE close_reason = 'lapsed' AND closes_at IS NOT NULL ORDER BY id FOR UPDATE;

-- 2. Export, under the locks.
-- (\copy can't take a variable for its file, so the output is sent there instead.)
\o :export
COPY (SELECT id, closes_at, close_reason, delete_after, close_blocked_at, closing_email_sent_at, closing_email_reason, now() AS exported_at FROM users WHERE close_reason = 'lapsed' AND closes_at IS NOT NULL ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER);
\o

-- 3 and 4. Clear, and queue a push for each.
CREATE TEMP TABLE cleared_lapses ON COMMIT DROP AS
WITH listed AS (
  SELECT unnest(string_to_array(nullif(:'fleets', ''), ',')) AS fleet_id
), cleared AS (
  UPDATE users u SET closes_at = NULL, close_reason = NULL, updated_at = now()
   WHERE u.close_reason = 'lapsed' AND u.closes_at IS NOT NULL
     AND (u.closes_at > now()
          OR u.fleet_id IN (SELECT trim(fleet_id) FROM listed)
          OR EXISTS (SELECT 1 FROM user_fleets f WHERE f.user_id = u.id AND f.fleet_id IN (SELECT trim(fleet_id) FROM listed)))
  RETURNING u.id
)
SELECT id FROM cleared;

INSERT INTO entitlement_outbox (user_id, reason) SELECT id, 'lapse_cleared' FROM cleared_lapses;

SELECT count(*) AS lapse_windows_cleared FROM cleared_lapses;

-- 5. What's left: closed fleets, kept closed.
SELECT id, closes_at AS closed_at FROM users WHERE close_reason = 'lapsed' AND closes_at IS NOT NULL ORDER BY closes_at;

COMMIT;
