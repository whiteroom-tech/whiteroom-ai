-- Who changed a fleet's controls, from the dashboard.
--
-- The engine records control actions (pause, stop, resume, rule changes) as
-- by "dashboard": it only sees the dashboard's service secret, never the
-- person. The BFF (app/api/fleet/engine) knows the signed-in user, so it
-- writes one row here after each control action the engine accepts. Agent
-- detail and Controls read it to say who acted (lib/control-actions.ts).
--
-- Rows are kept with the account; deleting the user deletes them.
-- Idempotent: safe to re-run, same as 001-008.
CREATE TABLE IF NOT EXISTS control_actions (
  id          bigserial PRIMARY KEY,
  fleet_id    text NOT NULL,
  action      text NOT NULL,
  agent_id    text,
  rule_id     text,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS control_actions_fleet_time ON control_actions (fleet_id, created_at DESC);
