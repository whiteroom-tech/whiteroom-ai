-- Backfill users.trial_state (migration 015) for accounts written before it.
--
-- NOT a migration and not run by any deploy: run by hand, only after 015 is
-- applied, in each region (staging, then US prod, then EU), when the rollout
-- says to. Safe to run at any time and to re-run: it only touches rows whose
-- trial_state is still NULL, and the dashboard reads a NULL state exactly as a
-- backfilled one (both from trial_ends_at), so a half-finished run changes
-- nothing anyone sees.
--
-- Rule: 'active' if trial_ends_at is still ahead, else 'ended' (including a
-- NULL trial_ends_at, which has always read as an ended free period).
-- trial_ends_at itself is never changed, so extended trials and the platform
-- fee date (counted from it) are kept.
--
-- Batched: 1,000 rows per transaction, committed one by one, so no long lock
-- on users. A lock wait over 5s stops the run with an error; just run it
-- again, it carries on where it stopped.
--
-- Run with plain psql (autocommit, not -1, so each batch commits):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/backfill-trial-state.sql

SET lock_timeout = '5s';

DO $$
DECLARE
  batch_size constant int := 1000;
  done int;
  total bigint := 0;
BEGIN
  LOOP
    UPDATE users SET trial_state = CASE WHEN trial_ends_at > now() THEN 'active' ELSE 'ended' END
     WHERE id IN (SELECT id FROM users WHERE trial_state IS NULL ORDER BY id LIMIT batch_size FOR UPDATE)
       AND trial_state IS NULL;
    GET DIAGNOSTICS done = ROW_COUNT;
    EXIT WHEN done = 0;
    total := total + done;
    COMMIT;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RAISE NOTICE 'trial_state backfilled on % rows', total;
END $$;

-- What's left (0 when finished) and the split, to check the result.
SELECT count(*) FILTER (WHERE trial_state IS NULL) AS still_null,
       count(*) FILTER (WHERE trial_state = 'active') AS active,
       count(*) FILTER (WHERE trial_state = 'ended') AS ended,
       count(*) FILTER (WHERE trial_state = 'not_started') AS not_started
  FROM users;
