-- Internal admin.
--
-- Idempotent: safe to re-run.

-- 1. Roles.
--
--    Two values only: 'user' and 'admin'. Deliberately not a richer permission
--    model — there is one internal team and one thing they need to do, and an
--    unused role hierarchy is a place for mistakes to hide.
--
--    NOT NULL with a default so every existing row becomes a plain user, and
--    so a missing value can never be mistaken for elevated access.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- Admin screens filter on this, and it is by definition a tiny slice of the
-- table, so a partial index is the whole index.
CREATE INDEX IF NOT EXISTS users_admin_idx ON users (id) WHERE role = 'admin';

-- 2. Audit log.
--
--    Every admin mutation, regardless of outcome. actor_email is denormalised
--    on purpose: the point of an audit log is to still be readable after the
--    actor's row is gone, and a join to a deleted user gives NULL.
--
--    No foreign key on target_user_id for the same reason — deleting a user
--    must not delete the record of what was done to them.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id             bigserial PRIMARY KEY,
  actor_user_id  text NOT NULL,
  actor_email    text,
  action         text NOT NULL,
  target_user_id text,
  target_email   text,
  details        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx
  ON admin_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx
  ON admin_audit_log (target_user_id, created_at DESC);

-- 3. Bootstrapping the first admin is deliberately a manual SQL step:
--
--      UPDATE users SET role = 'admin' WHERE lower(email) = 'you@whiteroom.tech';
--
--    There is no "grant admin" button, and that is the design. An admin panel
--    that can create admins turns one compromised session into permanent,
--    self-replicating access; keeping the grant in the database means it
--    leaves a trace somewhere the panel can't reach.
