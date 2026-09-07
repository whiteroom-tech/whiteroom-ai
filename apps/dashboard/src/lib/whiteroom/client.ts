// Single entry point for the dashboard's calls to the WhiteRoom proxy.
// Replaces the raw fetch() calls that were duplicated across the dashboard,
// fleet, and onboarding pages, and centralizes the auth-header rule:
//   - keys starting with "sk-"  -> x-api-key
//   - anything else (fleet tokens) -> Authorization: Bearer
//   - no key -> unauthenticated (e.g. token_login)

import type {
  AgentInfo,
  AuditLogResponse,
  ClaimFleetResult,
  DeleteKeyResult,
  FleetReport,
  GetHandoverResult,
  ListFleetsResult,
  ListKeysResult,
  RebindResult,
  RegisterResult,
  StoreKeyResult,
  TokenLoginResult,
} from './types';

export const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'https://proxy.whiteroom.tech';

function authHeaders(key?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) {
    if (key.startsWith('sk-')) h['x-api-key'] = key;
    else h['Authorization'] = `Bearer ${key}`;
  }
  return h;
}

async function postRaw(body: Record<string, unknown>, key?: string): Promise<Response> {
  return fetch(`${PROXY_URL}/api/white-room`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(body),
  });
}

async function apiCall<T>(body: Record<string, unknown>, key?: string): Promise<T> {
  const res = await postRaw(body, key);
  return res.json() as Promise<T>;
}

// -- Fleet provisioning & login --

/**
 * Creates the fleet without registering a placeholder agent.
 *
 * register_agent also creates a fleet, but only as a side effect of adding an
 * agent — which left an idle "setup-agent" in every operator's grid purely
 * from signing in. Real agents register themselves on their first proxied
 * call, so the dashboard should never invent one.
 *
 * Idempotent, so it is safe to assert on every load: a repeat call from the
 * owner returns the same token.
 */
export async function createFleet(fleetId: string, apiKey: string): Promise<RegisterResult> {
  const res = await postRaw({ action: 'create_fleet', fleet_id: fleetId }, apiKey);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

export async function registerAgent(
  fleetId: string,
  apiKey: string,
  opts: { agentId?: string; role?: string } = {},
): Promise<RegisterResult> {
  const res = await postRaw(
    {
      action: 'register_agent',
      fleet_id: fleetId,
      agent_id: opts.agentId ?? 'setup-agent',
      agent_role: opts.role ?? 'worker',
    },
    apiKey,
  );
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

/**
 * Whether a register_agent response means the fleet is usable.
 *
 * Deliberately checks for the token rather than the absence of `error`: the
 * engine answers HTTP 200 with BOTH a populated `error` ("Agent 'setup-agent'
 * already registered in fleet '…'") AND a valid `fleetToken` when the fleet
 * already exists, because register_agent is idempotent. Treating `error` as
 * failure therefore misreads a perfectly healthy fleet as broken.
 *
 * A genuine failure — the fleet being bound to a different API key — returns
 * 401 with no token at all, so the token is the only reliable signal.
 */
export function fleetProvisioned(
  res: RegisterResult,
): res is RegisterResult & { fleetToken: string } {
  return typeof res.fleetToken === 'string' && res.fleetToken.length > 0;
}

export function tokenLogin(fleetToken: string): Promise<TokenLoginResult> {
  return apiCall<TokenLoginResult>({ action: 'token_login', fleet_token: fleetToken });
}

export function claimFleet(fleetId: string): Promise<ClaimFleetResult> {
  return apiCall<ClaimFleetResult>({ action: 'claim_fleet', fleet_id: fleetId });
}

export function listFleets(apiKey: string): Promise<ListFleetsResult> {
  return apiCall<ListFleetsResult>({ action: 'list_fleets' }, apiKey);
}

/**
 * BYOK — rebind a fleet from its current key to the customer's Anthropic key.
 * Authenticated with the fleet's current key (apiKey).
 */
export async function rebindFleetKey(
  fleetId: string,
  newApiKey: string,
  apiKey: string,
): Promise<RebindResult> {
  const res = await postRaw(
    { action: 'rebind_fleet_key', fleet_id: fleetId, new_api_key: newApiKey },
    apiKey,
  );
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
  if (!res.ok || !body.success) {
    return { success: false, error: body.error || `Rebind failed (HTTP ${res.status}).` };
  }
  return { success: true };
}

// -- Reporting & monitoring --

export function fleetReport(fleetId: string, key?: string): Promise<FleetReport & { error?: string }> {
  return apiCall<FleetReport & { error?: string }>({ action: 'fleet_report', fleet_id: fleetId }, key);
}

export function checkWatch(agentId: string, fleetId: string, key?: string): Promise<AgentInfo> {
  return apiCall<AgentInfo>({ action: 'check_watch', agent_id: agentId, fleet_id: fleetId }, key);
}

export function getHandover(agentId: string, fleetId: string, key?: string): Promise<GetHandoverResult> {
  return apiCall<GetHandoverResult>({ action: 'get_handover', agent_id: agentId, fleet_id: fleetId }, key);
}

export function auditLog(
  opts: { fleetId: string; agentId?: string; type?: string; search?: string; limit?: number },
  key?: string,
): Promise<AuditLogResponse> {
  return apiCall<AuditLogResponse>(
    {
      action: 'audit_log',
      fleet_id: opts.fleetId,
      agent_id: opts.agentId,
      type: opts.type,
      search: opts.search,
      limit: opts.limit,
    },
    key,
  );
}

// -- Provider keys (BYOK) --
//
// The engine scopes provider keys to a fleet and allows several per fleet, so
// one account can connect an Anthropic key, an OpenAI key, and more, each
// getting its own proxy URL. Only a hash and the last four characters are
// stored server-side.

export interface FleetAuth {
  fleetId: string;
  apiKey: string;
  fleetToken: string | null;
}

// Prefer the fleet token: the engine authenticates it against the fleet it was
// issued for and resolves fleet_id from it, so these calls keep working even
// once the fleet is no longer bound to the dashboard's sk-wr- key. Fall back
// to the api key (with an explicit fleet_id) for users provisioned before
// fleet tokens were handed back.
function keyCall<T>(auth: FleetAuth, body: Record<string, unknown>): Promise<T> {
  return auth.fleetToken
    ? apiCall<T>(body, auth.fleetToken)
    : apiCall<T>({ ...body, fleet_id: auth.fleetId }, auth.apiKey);
}

export function listProviderKeys(auth: FleetAuth): Promise<ListKeysResult> {
  return keyCall<ListKeysResult>(auth, { action: 'list_keys' });
}

export function storeProviderKey(
  auth: FleetAuth,
  providerKey: string,
  endpoint?: string,
): Promise<StoreKeyResult> {
  return keyCall<StoreKeyResult>(auth, {
    action: 'store_key',
    api_key: providerKey,
    ...(endpoint && { llm_endpoint: endpoint }),
  });
}

/**
 * `keyPrefix` comes from a listed key's `wrKey`, which the engine truncates
 * with a trailing "..." — strip it, since the match is a literal startsWith.
 */
export function deleteProviderKey(auth: FleetAuth, keyPrefix: string): Promise<DeleteKeyResult> {
  return keyCall<DeleteKeyResult>(auth, {
    action: 'delete_key',
    key_prefix: keyPrefix.replace(/\.+$/, ''),
  });
}
