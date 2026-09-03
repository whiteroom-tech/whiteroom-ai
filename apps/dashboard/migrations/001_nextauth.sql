-- NextAuth (Auth.js) schema for @auth/pg-adapter.
--
-- The adapter owns `users`, `accounts`, `sessions` and `verification_token`,
-- but it only ever names its own columns, so the app-specific columns already
-- on `users` (api_key, fleet_id, fleet_token, byok) are left untouched and
-- keep working — as does user_fleets.user_id -> users.id.
--
-- Idempotent: safe to re-run.

-- 1. Adapter columns on the existing users table.
--    createUser() inserts only (name, email, "emailVerified", image) and
--    RETURNINGs id, so id needs a server-side default from here on.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS "emailVerified" timestamptz,
  ADD COLUMN IF NOT EXISTS image text;

ALTER TABLE users
  ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- byok is NOT NULL with no default, but createUser() never supplies it.
ALTER TABLE users
  ALTER COLUMN byok SET DEFAULT false;

-- Same for the timestamps: adapter inserts omit them.
ALTER TABLE users
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

-- 2. Adapter tables. userId is text to match users.id.
CREATE TABLE IF NOT EXISTS accounts (
  id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"            text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type                text NOT NULL,
  provider            text NOT NULL,
  "providerAccountId" text NOT NULL,
  refresh_token       text,
  access_token        text,
  expires_at          bigint,
  id_token            text,
  scope               text,
  session_state       text,
  token_type          text,
  UNIQUE (provider, "providerAccountId")
);

CREATE TABLE IF NOT EXISTS sessions (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  "sessionToken" text NOT NULL UNIQUE,
  expires        timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_token (
  identifier text NOT NULL,
  token      text NOT NULL,
  expires    timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- 3. Backfill: rows created before the adapter existed used the Google `sub`
--    as users.id directly, with no accounts row. Without this, the adapter's
--    getUserByAccount() finds nothing and creates a duplicate user on the next
--    Google sign-in, orphaning that user's fleets.
INSERT INTO accounts ("userId", type, provider, "providerAccountId")
SELECT u.id, 'oidc', 'google', u.id
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM accounts a
  WHERE a.provider = 'google' AND a."providerAccountId" = u.id
)
ON CONFLICT (provider, "providerAccountId") DO NOTHING;
