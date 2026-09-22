-- Entitlement outbox.
--
-- Guarantees that every entitlement-affecting mutation eventually reaches the
-- engine, even when the engine is down at commit time. Rows are written within
-- the same transaction as the business data change; a sweep endpoint drains
-- pending entries and marks them delivered.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS entitlement_outbox (
  id          bigserial    PRIMARY KEY,
  user_id     text         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      text         NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_entitlement_outbox_pending
  ON entitlement_outbox (created_at)
  WHERE delivered_at IS NULL;
