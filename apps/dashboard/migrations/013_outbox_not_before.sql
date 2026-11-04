-- Entitlement outbox: a delayed re-push (see src/lib/entitlements.ts).
--
-- A push the engine didn't acknowledge may still be applied by it later, after
-- a newer push. So an unacknowledged push queues a row the sweep may deliver
-- only after not_before (past the engine's request timeout), which re-sends the
-- current state over whatever landed late. Rows without it are due at once, as
-- before.
--
-- Idempotent: safe to re-run. Apply before deploying the dashboard that writes it.

ALTER TABLE entitlement_outbox ADD COLUMN IF NOT EXISTS not_before timestamptz;

-- Indexes are built CONCURRENTLY, so the live outbox is never locked against
-- writes while they build. CONCURRENTLY can't run in a transaction: apply this
-- file with plain psql -f, not psql -1.
--
-- The pending index gains not_before, under a new name so it can be built
-- before the old one is dropped.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entitlement_outbox_due
  ON entitlement_outbox (created_at, not_before)
  WHERE delivered_at IS NULL;
DROP INDEX CONCURRENTLY IF EXISTS idx_entitlement_outbox_pending;

-- The sweep prunes delivered rows after 30 days; this keeps that from scanning the table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entitlement_outbox_delivered
  ON entitlement_outbox (delivered_at)
  WHERE delivered_at IS NOT NULL;
