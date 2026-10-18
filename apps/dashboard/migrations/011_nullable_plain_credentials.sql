-- Credentials at rest (spec Rev 3, PR D2).
--
-- The dashboard stops writing plain fleet tokens and sk-wr keys and clears
-- the ones already encrypted (lib/cred-seal.ts). users.api_key and
-- users.fleet_token are already nullable; user_fleets.fleet_token isn't.
-- Apply before deploying D2: in production the dashboard refuses to start
-- while this column is still NOT NULL (instrumentation.ts).
--
-- Idempotent: safe to re-run, same as 001-010.
ALTER TABLE user_fleets ALTER COLUMN fleet_token DROP NOT NULL;
