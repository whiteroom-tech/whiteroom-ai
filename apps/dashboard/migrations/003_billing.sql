-- Stripe subscriptions.
--
-- One row per user, created lazily the first time they reach Checkout. A user
-- with no row is on the free plan — see effectivePlan() in lib/plans.ts, which
-- treats a missing row and an inactive one identically.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  stripe_customer_id     text NOT NULL UNIQUE,
  stripe_subscription_id text UNIQUE,
  plan                   text NOT NULL DEFAULT 'free',
  status                 text NOT NULL DEFAULT 'active',
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  -- Set by hand to comp an account or extend a trial. Checked ahead of `plan`
  -- so it survives the next webhook, which would otherwise overwrite any
  -- change made directly to `plan`.
  plan_override          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Looking a subscription up by its Stripe ids is what every webhook does
-- first, and neither is the primary key.
CREATE INDEX IF NOT EXISTS subscriptions_stripe_sub_idx
  ON subscriptions (stripe_subscription_id);

-- Webhook idempotency.
--
-- Stripe retries on any non-2xx and does not guarantee ordering, so a handler
-- must be safe to run twice. Inserting the event id first — and bailing on
-- conflict — makes "have I already applied this?" a primary-key check rather
-- than a judgement call per event type.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Retained only long enough to cover Stripe's retry window (72 hours), plus
-- room to debug. Pruned by the same statement that reads it.
CREATE INDEX IF NOT EXISTS stripe_events_processed_idx
  ON stripe_events (processed_at);
