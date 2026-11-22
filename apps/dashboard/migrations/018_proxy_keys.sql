-- Proxy URLs that can be shown again (Fleet key page).
--
-- The engine keeps only a hash of each proxy key, so a proxy URL could be
-- shown once. The dashboard now keeps its own encrypted copy (lib/cred-seal.ts,
-- key WR_CRED_ENCRYPTION_KEY, the same as the fleet key), so the owner can
-- reveal it later. Never a plain value: without the encryption key nothing is
-- saved and the URL is shown once, as before.
--
-- key_prefix is the engine's display prefix ("sk-wr-" + 16 hex), which is what
-- list_keys returns for a key.
--
-- Idempotent: safe to re-run, same as 001-017.
CREATE TABLE IF NOT EXISTS proxy_keys (
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  fleet_id      text NOT NULL,
  key_prefix    text NOT NULL,
  proxy_key_enc text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fleet_id, key_prefix)
);
