// Single entry point for the dashboard's calls to the WhiteRoom proxy.
// Replaces the raw fetch() calls that were duplicated across the dashboard,
// fleet, and onboarding pages, and centralizes the auth-header rule:
//   - keys starting with "sk-"  -> x-api-key
//   - anything else (fleet tokens) -> Authorization: Bearer
//   - no key -> unauthenticated (e.g. token_login)

import type {
  AgentInfo,
  AuditLogResponse,
  FleetReport,
  GetHandoverResult,
  ListFleetsResult,
  RebindResult,
  RegisterResult,
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

export function tokenLogin(fleetToken: string): Promise<TokenLoginResult> {
  return apiCall<TokenLoginResult>({ action: 'token_login', fleet_token: fleetToken });
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
