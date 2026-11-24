-- Agent contacts (gap-closing spec A5, contract 0.1): the person notified
-- about an agent. A contact has no extra permissions. Set by the fleet's
-- owner only; the contact is the owner or an active member of the owner's
-- organization, checked when it's set, when the owner opens it, and when a
-- notice is sent (a contact who has left is cleared, and the notice goes to
-- the owner). Nothing sends a per-agent notice yet: the first is C5.
-- No row: notices go to the fleet's owner. Removing an agent from the dashboard
-- deletes its row (api/fleet/engine), so an agent reusing the id starts fresh.
--
-- Idempotent: safe to re-run, same as 001-018.
CREATE TABLE IF NOT EXISTS agent_contacts (
  fleet_id        text NOT NULL,
  agent_id        text NOT NULL,
  contact_user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  set_by          text NOT NULL,
  set_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fleet_id, agent_id)
);

-- Deleting a user removes them as a contact (the foreign key above): indexed,
-- so that doesn't scan the table.
CREATE INDEX IF NOT EXISTS agent_contacts_contact_idx ON agent_contacts (contact_user_id);
