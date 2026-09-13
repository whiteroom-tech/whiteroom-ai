-- Account & profile management.
--
-- Adds the columns behind /settings: a profile field the adapter doesn't own
-- (timezone), the global session-revocation stamp, and the table backing a
-- verified email change.
--
-- Idempotent: safe to re-run, same as 001.

-- 1. Profile fields.
--    name and image already exist (the Auth.js adapter added them in 001);
--    timezone is ours, and is nullable because "unset" means "use the
--    browser's" rather than any particular zone.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone text;

-- 2. Global session revocation.
--
--    Sessions are JWTs (auth.ts: session.strategy = 'jwt'), so there are no
--    session rows to delete and "sign out everywhere" has nothing to act on.
--    This is the stamp that replaces that: every JWT carries its issue time,
--    and the jwt callback rejects any token issued at or before this value.
--    Bumping it to now() therefore invalidates every token in existence for
--    this user, including the one making the request.
--
--    NULL means "never revoked" — the common case, and the one the callback
--    can skip work for.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;

-- 3. Email change requests.
--
--    Email IS the identity here: it's what the magic-link provider signs in,
--    and what a Google account is matched to. So a change can't be a straight
--    UPDATE — it has to be proven against the NEW address first, or changing
--    it to an address you don't control is an account takeover.
--
--    Only a hash of the token is stored, same reasoning as accounts.token_hash
--    on the engine: a leaked database shouldn't hand out working links.
CREATE TABLE IF NOT EXISTS email_change_requests (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  new_email  text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One pending request per user: asking again replaces the previous one
-- (ON CONFLICT in requestEmailChange), so an abandoned request can't be
-- redeemed later to a stale address.
CREATE UNIQUE INDEX IF NOT EXISTS email_change_requests_user_idx
  ON email_change_requests (user_id);

CREATE INDEX IF NOT EXISTS email_change_requests_expires_idx
  ON email_change_requests (expires_at);

-- 4. users.email must be unique for an email change to be safe to apply —
--    without it, two accounts can end up sharing an address and the magic-link
--    provider has no way to pick between them. The adapter has always assumed
--    this; it was just never enforced.
--
--    Guarded rather than declared: if duplicate emails already exist the index
--    build fails, and that needs to be seen and resolved rather than silently
--    skipped by an IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'users' AND indexname = 'users_email_unique_idx'
  ) THEN
    CREATE UNIQUE INDEX users_email_unique_idx ON users (lower(email)) WHERE email IS NOT NULL;
  END IF;
END $$;
