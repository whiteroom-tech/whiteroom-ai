-- Account deletion and plan lapse: the closing window and its bookkeeping (see src/lib/account-closing.ts). Idempotent; apply before deploying the dashboard that reads it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS closes_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS close_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_after timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS closing_email_sent_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS close_blocked_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS close_blocked_notified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS close_blocked_email_attempts integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_close_reason_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_close_reason_check
      CHECK (close_reason IS NULL OR close_reason IN ('deleted', 'lapsed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_closes_at_idx ON users (closes_at) WHERE closes_at IS NOT NULL;
