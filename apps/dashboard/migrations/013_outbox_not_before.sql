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

DROP INDEX IF EXISTS idx_entitlement_outbox_pending;
CREATE INDEX IF NOT EXISTS idx_entitlement_outbox_pending
  ON entitlement_outbox (created_at, not_before)
  WHERE delivered_at IS NULL;

-- The sweep prunes delivered rows after 30 days; this keeps that from scanning the table.
CREATE INDEX IF NOT EXISTS idx_entitlement_outbox_delivered
  ON entitlement_outbox (delivered_at)
  WHERE delivered_at IS NOT NULL;
