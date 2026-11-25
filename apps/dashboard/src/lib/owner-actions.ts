// The engine actions that are the fleet owner's (owner check in
// control-auth.ts, which adds the dashboard's service credential). Shared by
// the BFF's check and the browser, which sends these through the BFF: sent
// straight to the engine with the fleet's key, the engine refuses them.
// No server-only imports here.

/**
 * Engine actions that change what an agent may do (rules) or whether it works
 * (pause / resume). The engine accepts them only with the dashboard's service
 * secret (Governance Loop spec Rev 9, R1), so a fleet key on its own — which
 * every agent holds — can't remove an agent's controls or wake it up.
 *
 * Keep in step with DASHBOARD_ONLY_ACTIONS in the engine's routes/white-room.ts.
 */
export const DASHBOARD_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'governance_create_rule', 'governance_update_rule', 'governance_delete_rule',
  'pause_agent', 'resume_agent', 'stop_agent',
  // Removing an agent is an owner's call too.
  'deregister_agent',
  'alerts_get', 'alerts_set_slack', 'alerts_set_teams', 'alerts_test', 'alerts_set_health',
  // Snooze, dismiss and mark fixed, for every recommendation (one action
  // serves them all), and health history: the owner's (Agent Health D6). A
  // teammate or an agent holding the fleet key is refused; Performance shows
  // the refusal's own words.
  'performance_feedback', 'health_history',
  'fleet_data_settings_get', 'fleet_data_settings_set',
  'goal_get', 'goal_set_owner', 'agent_new_run',
  'compression_mode_set', 'compression_preview',
  // Credentials (P0 #1): a rebind revokes everyone else's access and a
  // Bedrock mapping lets an AWS account spend as the fleet, so only its owner.
  'rebind_fleet_key', 'rotate_proxy_keys', 'store_bedrock_role', 'delete_bedrock_role',
  // An agent's budget is its owner's to set, not the agent's.
  'agent_budget_set',
  // A gateway signing key decides which agent names count as signed (signed
  // agent names): only the owner adds or revokes one.
  'gateway_key_add', 'gateway_key_revoke',
  // A sandbox test's tool policy: the agent under test mustn't switch it off.
  'create_policy', 'set_policy_mode',
  // Purge zeroes every agent's spend, loop and rate counters (security fixes S6).
  'purge_fleet',
  // The tool names the fleet's agents call, for the Controls pickers: the owner's to read.
  'tools_seen',
  // Where a Where tools can send data rule's tools sent, for its Seen list (DLP spec 5.5): the owner's too.
  'send_seen_list',
  // Renaming an agent, switching "One key per agent" and marking an agent retired: the owner's (gap-closing spec 0.1).
  'agent_rename', 'agent_key_rule_set', 'agent_retire', 'replay_start',
]);

/**
 * Providers whose proxy keys run on the engine's own cloud identity: a leaked
 * one spends on that identity, so minting one (store_key) is an owner's
 * control action too. Keep in step with the engine's CLOUD_IDENTITY_PROVIDERS.
 */
export const CLOUD_IDENTITY_PROVIDERS: ReadonlySet<string> = new Set(['foundry-entra', 'bedrock-sigv4']);

/**
 * The action, when a request body is the owner's to send, else null: a
 * dashboard-only action, a key on the engine's cloud identity, a key for one
 * agent, or removing a key.
 */
export function ownerActionOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { action, provider, bound_agent } = body as { action?: unknown; provider?: unknown; bound_agent?: unknown };
  if (typeof action !== 'string') return null;
  // Matched loosely (case, spaces), so a variant spelling can't skip the owner check.
  const cloudKey = action === 'store_key' && typeof provider === 'string' && CLOUD_IDENTITY_PROVIDERS.has(provider.trim().toLowerCase());
  // A key for one agent is that agent's identity ("One key per agent"): the owner's to make.
  // Any bound_agent at all, so an odd value can't skip the check (the engine refuses those anyway).
  const agentKey = action === 'store_key' && bound_agent !== undefined;
  // Removing a key can cut an agent off: the owner's, like rotating keys.
  return DASHBOARD_ONLY_ACTIONS.has(action) || cloudKey || agentKey || action === 'delete_key' ? action : null;
}
