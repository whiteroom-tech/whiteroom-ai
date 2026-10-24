-- Fail fast rather than queue behind live traffic on users (which would
-- block every sign-in while waiting); on a timeout, just run it again.
SET lock_timeout = '5s';

-- When an account provisioned its fleet (users.fleet_id), so fleet ownership
-- (lib/control-auth.ts fleetOwner) ranks provisioned holders by when they got
-- the fleet rather than when the account was made. Set by
-- upsertUserProvisioning whenever fleet_id changes; rows provisioned before
-- this stay NULL and fall back to created_at (no backfill).
--
-- Apply BEFORE the code that reads it: to the staging DB before merging
-- (merges auto-deploy to staging) and to prod before Promote.
--
-- Idempotent: safe to re-run, same as 001-011.
ALTER TABLE users ADD COLUMN IF NOT EXISTS fleet_provisioned_at timestamptz;
