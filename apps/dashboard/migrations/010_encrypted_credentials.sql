-- Credentials at rest (spec Rev 3, PR D1).
--
-- Fleet tokens and sk-wr API keys get an encrypted copy beside the plain
-- value (lib/cred-seal.ts, key WR_CRED_ENCRYPTION_KEY). The dashboard writes
-- both and reads the plain value while it is there; at boot it encrypts rows
-- saved before this (instrumentation.ts). A later change stops writing the
-- plain columns and clears them.
--
-- Idempotent: safe to re-run, same as 001-009.
ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_enc text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS fleet_token_enc text;
ALTER TABLE user_fleets ADD COLUMN IF NOT EXISTS fleet_token_enc text;
