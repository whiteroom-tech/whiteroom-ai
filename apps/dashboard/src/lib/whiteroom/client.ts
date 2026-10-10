// Single entry point for the dashboard's calls to the WhiteRoom proxy.
// Replaces the raw fetch() calls that were duplicated across the dashboard,
// fleet, and onboarding pages, and centralizes the auth-header rule:
//   - keys starting with "sk-"  -> x-api-key
//   - anything else (fleet tokens) -> Authorization: Bearer
//   - no key -> unauthenticated (e.g. token_login)

import type {
  AuditIntegrity,
  VerifyAuditResult,
  AuditSummaryResult,
  RuleWouldActResult,
  ListRunsResult,
  GovernanceResponse,
  RuleActionsResult,
  RunDaysResult,
  RunEventsResult,
  FleetDiagnosis,
  AgentInfo,
  AgentPerformanceResult,
  AuditLogResponse,
  ClaimFleetResult,
  DeleteKeyResult,
  FleetReport,
  GetHandoverResult,
  GovernanceListResult,
  GovernanceMode,
  GovernanceParams,
  GovernanceRule,
  GovernanceRuleType,
  GovernanceScope,
  ListFleetsResult,
  ListKeysResult,
  PerformanceEvidenceResult,
  PerformanceFeedbackResult,
  PerformanceIndexResult,
  PerformanceLiveFeedResult,
  PaginatedRecommendationsResult,
  RecommendationGetResult,
  RecommendationBriefResult,
  RecommendationExportMarkdownResult,
  FleetHourlyResult,
  PerformanceCostForecastResult,
  SetBudgetResult,
  SetTokenBudgetResult,
  RegisterResult,
  StoreKeyResult,
  TokenLoginResult,
} from './types';
import { viewerTimeZone } from '@/lib/runs';
import { activeHold, activeHolds } from '@/lib/holds';

export const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL || 'https://proxy.whiteroom.tech';

/**
 * Every failure thrown out of this module is one of these, so callers can
 * tell a real auth rejection from a network blip instead of treating any
 * thrown error as "credentials are bad" (which used to wipe them).
 *
 * `status` is the HTTP status of the failed response, or undefined when the
 * request never got a response at all (network error, timeout, redirect).
 */
export class WhiteRoomApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'WhiteRoomApiError';
    this.status = status;
  }
}

/** Marks the BFF's refusal of a rule change or pause/resume (lib/control-auth). */
export const CONTROL_DENIED = 'control_denied';

/**
 * The dashboard refused a control action for this account (not signed in, not
 * the fleet's owner). The session is fine; the message says why.
 */
export class ControlDeniedError extends WhiteRoomApiError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'ControlDeniedError';
  }
}

/**
 * How a page should react to a failed rule change or pause/resume:
 * - `sign-out`: the credential was rejected; the session is gone.
 * - `refused`: this account may not do this (ControlDeniedError). Show the
 *   reason as it is; trying again gives the same answer, so offer no retry.
 * - `failed`: anything else (network, 5xx, engine refusal). Worth a retry.
 */
export function controlFailure(e: unknown): 'sign-out' | 'refused' | 'failed' {
  if (e instanceof ControlDeniedError) return 'refused';
  return isAuthError(e) ? 'sign-out' : 'failed';
}

/**
 * True only for a genuine credential rejection (401/403). A timeout, network
 * failure, or 5xx is NOT an auth error — credentials should be kept and the
 * call retried. Nor is a control refusal: signing out wouldn't help.
 */
export function isAuthError(e: unknown): boolean {
  return e instanceof WhiteRoomApiError && !(e instanceof ControlDeniedError) && (e.status === 401 || e.status === 403);
}

/**
 * The auth-header rule, shared with the /api/fleet/engine BFF route (which
 * attaches the server-held fleet token with exactly the same logic).
 */
export function engineAuthHeaders(key?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) {
    if (key.startsWith('sk-')) h['x-api-key'] = key;
    else h['Authorization'] = `Bearer ${key}`;
  }
  return h;
}

interface PostOptions {
  /**
   * Skip the BFF even when running keyless in the browser. token_login must
   * stay direct: it authenticates BY the token in its request body, before
   * any cookie session exists to ride on.
   */
  direct?: boolean;
}

/**
 * A 503 whiteroom_handoff means the engine is switching instances and did
 * nothing with the request (spec section 0), so it is retried, twice at most,
 * after its Retry-After (capped at 1 s). A deploy never shows as an error.
 */
async function postRaw(
  body: Record<string, unknown>,
  key?: string,
  opts?: PostOptions,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await postOnce(body, key, opts);
    if (res.status !== 503 || attempt >= 2) return res;
    const reason = await res.clone().json().then((b) => b?.whiteroom?.reason, () => null);
    if (reason !== 'whiteroom_handoff') return res;
    const after = Number(res.headers.get('Retry-After'));
    await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 1000) : 250));
  }
}

async function postOnce(
  body: Record<string, unknown>,
  key?: string,
  opts?: PostOptions,
): Promise<Response> {
  // Browser + no explicit key = the caller has no credential to send: the
  // fleet token lives server-side in the httpOnly `wr_fleet_auth` cookie.
  // Route those calls through the same-origin BFF, which attaches the token
  // on the server. Explicit-key calls (a typed API key during onboarding or
  // login) and server-side calls go straight to the engine as before.
  const viaBff = typeof window !== 'undefined' && !key && !opts?.direct;
  try {
    if (viaBff) {
      return await fetch('/api/fleet/engine', {
        method: 'POST',
        // The BFF's own upstream timeout is 15s; give it headroom so its 502
        // arrives instead of racing it with our own abort.
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    return await fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      cache: 'no-store',
      headers: engineAuthHeaders(key),
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Network failure, timeout, or unexpected redirect: no response, no status.
    throw new WhiteRoomApiError(e instanceof Error ? e.message : 'Network error');
  }
}

async function apiCall<T>(
  body: Record<string, unknown>,
  key?: string,
  opts?: PostOptions,
): Promise<T> {
  const res = await postRaw(body, key, opts);
  if (!res.ok) {
    if (res.status === 403) {
      const denied = await res.json().catch(() => null);
      if (denied?.code === CONTROL_DENIED && typeof denied.error === 'string') throw new ControlDeniedError(denied.error);
    }
    throw new WhiteRoomApiError(`HTTP ${res.status}`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    // 200 with a non-JSON body (e.g. an HTML error page from a proxy layer).
    throw new WhiteRoomApiError(`Invalid JSON response (HTTP ${res.status})`, res.status);
  }
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
  opts: { agentId?: string; role?: string; taskType?: string } = {},
): Promise<RegisterResult> {
  const res = await postRaw(
    {
      action: 'register_agent',
      fleet_id: fleetId,
      agent_id: opts.agentId ?? 'setup-agent',
      agent_role: opts.role ?? 'worker',
      ...(opts.taskType && { task_type: opts.taskType }),
    },
    apiKey,
  );
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

/**
 * Sets an already-registered agent's declared task type — what kind of work
 * it does (e.g. "auto insurance policy drafting"). Keys the fleet's shared
 * per-task cost estimate (see performanceCostForecast below); agents sharing
 * the same taskType pool into one estimate.
 */
export async function updateAgentTaskType(
  fleetId: string,
  agentId: string,
  taskType: string,
  apiKey?: string,
): Promise<{ success?: boolean; error?: string }> {
  const res = await postRaw(
    { action: 'update_agent', fleet_id: fleetId, agent_id: agentId, task_type: taskType },
    apiKey,
  );
  if (!res.ok) throw new WhiteRoomApiError(`HTTP ${res.status}`, res.status);
  return requireSuccess(await res.json());
}

/**
 * Mutations answer HTTP 200 with {error} or {success:false} when the engine
 * refuses them (missing agent, mandatory rest…). Throws on those so callers
 * can't report a refused change as done.
 */
function requireSuccess<T extends { success?: boolean; error?: string }>(res: T): T {
  if (res.error || res.success === false) throw new Error(res.error ?? 'The engine refused the change.');
  return res;
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
  // Always direct: token_login is the unauthenticated call that VALIDATES a
  // token — routing it through the cookie-authenticated BFF would deadlock
  // login (no cookie yet -> 401 before the engine ever sees the token).
  return apiCall<TokenLoginResult>(
    { action: 'token_login', fleet_token: fleetToken },
    undefined,
    { direct: true },
  );
}

export function claimFleet(fleetId: string, key?: string): Promise<ClaimFleetResult> {
  return apiCall<ClaimFleetResult>({ action: 'claim_fleet', fleet_id: fleetId }, key);
}

export function listFleets(apiKey: string): Promise<ListFleetsResult> {
  return apiCall<ListFleetsResult>({ action: 'list_fleets' }, apiKey);
}

// -- Reporting & monitoring --

export async function fleetReport(fleetId: string, key?: string): Promise<FleetReport & { error?: string }> {
  // tz: savings group per agent-day in the viewer's days, as on Performance.
  const report = await apiCall<FleetReport & { error?: string }>({ action: 'fleet_report', fleet_id: fleetId, tz: viewerTimeZone() }, key);
  return report.holds ? { ...report, holds: activeHolds(report.holds) } : report;
}

export async function checkWatch(agentId: string, fleetId: string, key?: string): Promise<AgentInfo> {
  const agent = await apiCall<AgentInfo>({ action: 'check_watch', agent_id: agentId, fleet_id: fleetId }, key);
  return 'hold' in agent ? { ...agent, hold: activeHold(agent.hold) } : agent;
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
  provider?: string,
): Promise<StoreKeyResult> {
  return keyCall<StoreKeyResult>(auth, {
    action: 'store_key',
    api_key: providerKey,
    ...(endpoint && { llm_endpoint: endpoint }),
    // Azure keys are opaque, so the engine can't infer the provider from the
    // key's prefix the way it does for sk-ant- / sk- keys — it has to be named.
    ...(provider && { provider }),
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

// -- Agent control --

export async function pauseAgent(fleetId: string, agentId: string, key?: string): Promise<{ success?: boolean; error?: string }> {
  return requireSuccess(await apiCall<{ success?: boolean; error?: string }>({ action: 'pause_agent', fleet_id: fleetId, agent_id: agentId }, key));
}

/** Stop (Gov v1 fleets): the agent refuses every call until resumed, even after a restart. */
export async function stopAgent(fleetId: string, agentId: string, key?: string): Promise<{ success?: boolean; error?: string }> {
  return requireSuccess(await apiCall<{ success?: boolean; error?: string }>({ action: 'stop_agent', fleet_id: fleetId, agent_id: agentId }, key));
}

export async function resumeAgent(fleetId: string, agentId: string, key?: string): Promise<{ success?: boolean; error?: string }> {
  return requireSuccess(await apiCall<{ success?: boolean; error?: string }>({ action: 'resume_agent', fleet_id: fleetId, agent_id: agentId }, key));
}

// -- Performance --

export function performanceIndex(fleetId: string, hoursBack?: number, key?: string): Promise<PerformanceIndexResult> {
  return apiCall<PerformanceIndexResult>({ action: 'performance_index', fleet_id: fleetId, hours_back: hoursBack ?? 24 }, key);
}

export function performanceAgent(fleetId: string, agentId: string, hoursBack?: number, key?: string): Promise<AgentPerformanceResult> {
  return apiCall<AgentPerformanceResult>({ action: 'performance_agent', fleet_id: fleetId, agent_id: agentId, hours_back: hoursBack ?? 24 }, key);
}

export function performanceEvidence(fleetId: string, findingId: string, key?: string): Promise<PerformanceEvidenceResult> {
  return apiCall<PerformanceEvidenceResult>({ action: 'performance_evidence', fleet_id: fleetId, finding_id: findingId }, key);
}

export function performanceFeedback(
  fleetId: string,
  opts: { recommendationId: string; findingVersion: string; action: string; reason?: string; snoozeDays?: number; idempotencyKey: string },
  key?: string,
): Promise<PerformanceFeedbackResult> {
  return apiCall<PerformanceFeedbackResult>({
    action: 'performance_feedback',
    fleet_id: fleetId,
    recommendation_id: opts.recommendationId,
    finding_version: opts.findingVersion,
    feedback_action: opts.action,
    reason: opts.reason,
    snooze_days: opts.snoozeDays,
    idempotency_key: opts.idempotencyKey,
  }, key);
}

export function performanceFleetHourly(
  fleetId: string,
  hoursBack?: number,
  key?: string,
): Promise<FleetHourlyResult> {
  return apiCall<FleetHourlyResult>({
    action: 'performance_fleet_hourly',
    fleet_id: fleetId,
    hours_back: hoursBack,
  }, key);
}

export function performanceRecommendationsList(
  fleetId: string,
  opts?: { status?: string; agentId?: string; cursor?: string; pageSize?: number; includeSummaries?: boolean },
  key?: string,
): Promise<PaginatedRecommendationsResult> {
  return apiCall<PaginatedRecommendationsResult>({
    action: 'performance_recommendations_list',
    fleet_id: fleetId,
    contract_version: '1',
    status: opts?.status,
    agent_id: opts?.agentId,
    cursor: opts?.cursor,
    page_size: opts?.pageSize,
    include_summaries: opts?.includeSummaries,
  }, key);
}

export function performanceRecommendationGet(
  fleetId: string,
  recommendationId: string,
  key?: string,
): Promise<RecommendationGetResult> {
  return apiCall<RecommendationGetResult>({
    action: 'performance_recommendations_get',
    fleet_id: fleetId,
    recommendation_id: recommendationId,
    contract_version: '1',
  }, key);
}

/**
 * Full-detail live feed, credentials removed — kept only for a short TTL (see
 * PerformanceLiveFeedResult), unlike auditLog which returns the permanent,
 * content-free record. Not fetched by default anywhere; callers should treat
 * this as an explicit reveal, not part of the page's normal load.
 */
export function performanceLiveFeed(
  fleetId: string,
  opts?: { agentId?: string; type?: string; search?: string; limit?: number },
  key?: string,
): Promise<PerformanceLiveFeedResult> {
  return apiCall<PerformanceLiveFeedResult>({
    action: 'performance_live_feed',
    fleet_id: fleetId,
    agent_id: opts?.agentId,
    type: opts?.type,
    search: opts?.search,
    limit: opts?.limit,
  }, key);
}

export function performanceRecommendationExport(
  fleetId: string,
  recommendationId: string,
  format: 'json' | 'markdown' = 'json',
  key?: string,
): Promise<RecommendationBriefResult | RecommendationExportMarkdownResult> {
  return apiCall<RecommendationBriefResult | RecommendationExportMarkdownResult>({
    action: 'performance_recommendations_export',
    fleet_id: fleetId,
    recommendation_id: recommendationId,
    contract_version: '1',
    format,
  }, key);
}

export function performanceCostForecast(fleetId: string, taskType?: string, key?: string): Promise<PerformanceCostForecastResult> {
  // tz: the daily budget resets at the viewer's midnight.
  return apiCall<PerformanceCostForecastResult>({ action: 'performance_cost_forecast', fleet_id: fleetId, task_type: taskType, tz: viewerTimeZone() }, key);
}

export function setBudgetUsd(fleetId: string, budgetUsd: number | null, key?: string): Promise<SetBudgetResult> {
  return apiCall<SetBudgetResult>({ action: 'set_budget_usd', fleet_id: fleetId, budget_usd: budgetUsd }, key);
}

export function setTokenBudget(fleetId: string, tokenBudget: number | null, key?: string): Promise<SetTokenBudgetResult> {
  return apiCall<SetTokenBudgetResult>({ action: 'set_token_budget', fleet_id: fleetId, token_budget: tokenBudget }, key);
}

// -- Fleet governance rules (Controls page) --

export function governanceList(fleetId: string, key?: string): Promise<GovernanceListResult> {
  return apiCall<GovernanceListResult>({ action: 'governance_list', fleet_id: fleetId }, key);
}

export function governanceCreateRule(
  fleetId: string,
  rule: {
    ruleType: GovernanceRuleType; mode?: GovernanceMode; response?: GovernanceResponse; params?: GovernanceParams; appliesTo?: GovernanceScope; description?: string;
    /** The Diagnosis recommendation it comes from; the engine makes at most one rule per suggestion. */
    sourceRecommendationId?: string;
  },
  key?: string,
): Promise<{ rule: GovernanceRule; existing?: boolean }> {
  return apiCall<{ rule: GovernanceRule; existing?: boolean }>({
    action: 'governance_create_rule',
    fleet_id: fleetId,
    rule_type: rule.ruleType,
    mode: rule.mode,
    response: rule.response,
    params: rule.params,
    applies_to: rule.appliesTo,
    description: rule.description,
    source_recommendation_id: rule.sourceRecommendationId,
  }, key);
}

// -- Agent Diagnosis --

/** The latest stored check with live statuses and readiness. Runs nothing. */
export function getDiagnosis(fleetId: string, key?: string): Promise<FleetDiagnosis> {
  return apiCall<FleetDiagnosis>({ action: 'get_diagnosis', fleet_id: fleetId }, key);
}

/** "Check now": checks every ready agent (about 12 s at most). */
export function diagnoseFleet(fleetId: string, opts: { force?: boolean } = {}, key?: string): Promise<FleetDiagnosis> {
  return apiCall<FleetDiagnosis>({ action: 'diagnose_fleet', fleet_id: fleetId, force: opts.force }, key);
}

export function governanceUpdateRule(
  fleetId: string,
  ruleId: string,
  updates: { mode?: GovernanceMode; response?: GovernanceResponse; params?: GovernanceParams; appliesTo?: GovernanceScope; description?: string },
  key?: string,
): Promise<{ rule: GovernanceRule }> {
  return apiCall<{ rule: GovernanceRule }>({
    action: 'governance_update_rule',
    fleet_id: fleetId,
    rule_id: ruleId,
    mode: updates.mode,
    response: updates.response,
    params: updates.params,
    applies_to: updates.appliesTo,
    description: updates.description,
  }, key);
}

export function governanceDeleteRule(fleetId: string, ruleId: string, key?: string): Promise<{ success?: boolean }> {
  return apiCall<{ success?: boolean }>({ action: 'governance_delete_rule', fleet_id: fleetId, rule_id: ruleId }, key);
}

// -- Runs (P1R) --

type RunsQuery = { fromDay: string; toDay: string; agentId?: string };

/**
 * POSTs a runs action with the days in the viewer's time zone. `unsupported`
 * when the engine predates the action: it answers 400 "Unknown action."
 * (white-room.ts, default case). An engine without `tz` ignores it and reads
 * the days as UTC.
 */
async function runsAction<T>(action: string, fleetId: string, q: RunsQuery, extra: Record<string, unknown>, key?: string): Promise<T | { unsupported: true }> {
  const res = await postRaw({
    action, fleet_id: fleetId, from_day: q.fromDay, to_day: q.toDay, tz: viewerTimeZone(),
    ...(q.agentId ? { agent_id: q.agentId } : {}),
    ...extra,
  }, key);
  if (res.status === 400) {
    const body = await res.clone().json().catch(() => null);
    if (typeof body?.error === 'string' && /^unknown action/i.test(body.error)) return { unsupported: true };
  }
  if (!res.ok) throw new WhiteRoomApiError(`HTTP ${res.status}`, res.status);
  return (await res.json()) as T;
}

/** Runs that started in a range of the viewer's days, newest first; `unsupported` sends Runs to the event feed. */
export function listRuns(
  fleetId: string,
  opts: RunsQuery & { cursor?: string | null; pageSize?: number; flagged?: boolean },
  key?: string,
): Promise<ListRunsResult | { unsupported: true }> {
  return runsAction<ListRunsResult>('list_runs', fleetId, opts, {
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
    ...(opts.pageSize ? { page_size: opts.pageSize } : {}),
    ...(opts.flagged ? { flagged: true } : {}),
  }, key);
}

/** Settings › Audit integrity: how much of the chain is verified, and recorded gaps. */
export function auditIntegrity(fleetId: string, key?: string): Promise<AuditIntegrity> {
  return apiCall({ action: 'audit_integrity', fleet_id: fleetId }, key);
}

/** A full chain check; the engine runs at most one a minute per fleet and returns the last result meanwhile. */
export function verifyAudit(fleetId: string, key?: string): Promise<VerifyAuditResult> {
  return apiCall({ action: 'verify_audit', fleet_id: fleetId }, key);
}

/** The redacted audit trail with its chain check, signed (Ed25519) by WhiteRoom. */
export function exportAuditSigned(fleetId: string, key?: string): Promise<Record<string, unknown>> {
  return apiCall({ action: 'export_audit_signed', fleet_id: fleetId }, key);
}

/** Totals over the stored audit trail since `from` (engine audit_summary): savings inputs per agent-day, governance decisions. */
/**
 * Audit totals since `from`. With `hoursBack`, the engine uses the same hour
 * window as performance_index instead (older engines ignore it and use `from`).
 */
export function auditSummary(fleetId: string, from: Date, key?: string, hoursBack?: number): Promise<AuditSummaryResult> {
  return apiCall<AuditSummaryResult>({ action: 'audit_summary', fleet_id: fleetId, from: from.toISOString(), tz: viewerTimeZone(), ...(hoursBack ? { hours_back: hoursBack } : {}) }, key);
}

/** Would-act counts per agent for one rule version (engine rule_would_act). */
export function ruleWouldAct(fleetId: string, ruleId: string, ruleVersion: number, key?: string): Promise<RuleWouldActResult> {
  return apiCall<RuleWouldActResult>({ action: 'rule_would_act', fleet_id: fleetId, rule_id: ruleId, rule_version: ruleVersion }, key);
}

/** Rule actions for a range of the viewer's days; `unsupported` keeps the audit-log counts. */
export function ruleActions(fleetId: string, opts: RunsQuery, key?: string, hoursBack?: number): Promise<RuleActionsResult | { unsupported: true }> {
  // hours_back: the performance_index window; the days are for older engines.
  return runsAction<RuleActionsResult>('rule_actions', fleetId, opts, hoursBack ? { hours_back: hoursBack } : {}, key);
}

/** Runs per day of the viewer's, for the day strip; `unsupported` hides the strip. */
export function runDays(fleetId: string, opts: RunsQuery, key?: string): Promise<RunDaysResult | { unsupported: true }> {
  return runsAction<RunDaysResult>('run_days', fleetId, opts, {}, key);
}

export function getRunEvents(
  fleetId: string,
  runId: string,
  opts: { cursor?: string | null; eventId?: string | null; kind?: 'all' | 'events' } = {},
  key?: string,
): Promise<RunEventsResult> {
  return apiCall<RunEventsResult>({
    action: 'get_run_events', fleet_id: fleetId, run_id: runId,
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
    ...(opts.eventId ? { event_id: opts.eventId } : {}),
    kind: opts.kind ?? 'all',
  }, key);
}

// -- Alerts (P2.7) --

export interface AlertsStatus { slack: { ending: string } | null }

/**
 * Alerts actions. The engine answers a refused change with 400 and a plain
 * reason, which is thrown as the message; an engine without alerts makes
 * alerts_get return null so Settings hides the section.
 */
async function alertsAction<T>(body: Record<string, unknown>): Promise<T | null> {
  const res = await postRaw(body);
  const data = await res.json().catch(() => null);
  if (res.status === 400 && /^unknown action/i.test(String(data?.error ?? ''))) return null;
  if (res.status === 403 && data?.code === CONTROL_DENIED && typeof data.error === 'string') throw new ControlDeniedError(data.error);
  const message = typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`;
  // With its status, so a rejected session (401/403) reads as one, not as a fault to retry.
  if (!res.ok) throw new WhiteRoomApiError(message, res.status);
  if (data?.success === false) throw new Error(message);
  return data as T;
}

// Dashboard-only like the other two (engine #93): agent keys can't read it.
export const alertsGet = (fleetId: string) => alertsAction<AlertsStatus>({ action: 'alerts_get', fleet_id: fleetId });
export const alertsSetSlack = (fleetId: string, url: string | null) => alertsAction<AlertsStatus>({ action: 'alerts_set_slack', fleet_id: fleetId, slack_url: url });
export const alertsTest = (fleetId: string) => alertsAction<{ success: boolean }>({ action: 'alerts_test', fleet_id: fleetId });

/** What WhiteRoom keeps for a fleet (Settings › Data and privacy). */
export interface DataSettings {
  handover_persistence: boolean;
  content_capture: boolean;
  personal_data: 'keep' | 'exclude';
  /** Saved notes are deleted this long after each is written (engines from PR 6 on). */
  handover_max_age_hours?: number;
}
/** The owner's goal for an agent (Agent detail › Goal). */
export interface OwnerGoal { goal: string | null; revision: number; set_by: string | null; updated_at: string; /** Saved, but its key isn't configured on this engine. */ unreadable?: boolean }
export const goalGet = (fleetId: string, agentId: string) =>
  alertsAction<{ owner: OwnerGoal | null }>({ action: 'goal_get', fleet_id: fleetId, agent_id: agentId });
/**
 * `baseRevision` is the revision on screen when the edit began (0 for no goal): if the goal
 * changed since, the engine refuses the save as changed elsewhere. Older engines ignore it.
 */
export const goalSetOwner = (fleetId: string, agentId: string, goal: string | null, baseRevision: number) =>
  alertsAction<{ owner: OwnerGoal }>({ action: 'goal_set_owner', fleet_id: fleetId, agent_id: agentId, goal, base_revision: baseRevision });
export const agentNewRun = (fleetId: string, agentId: string) =>
  alertsAction<{ success: boolean }>({ action: 'agent_new_run', fleet_id: fleetId, agent_id: agentId });

/** Handover quality over a window (Agent detail › Handover quality). Shares are null until there's data. */
export interface HandoverQuality {
  handovers: number; scored: number; valuesChecked: number; valuesKept: number;
  valuesKeptShare: number | null; shareChecked: number | null; coverageMin: number;
  keptWithLabel: number | null; goalCarriedOver: number | null;
}
export const handoverQuality = (fleetId: string, agentId: string, days = 7) =>
  alertsAction<HandoverQuality>({ action: 'handover_quality', fleet_id: fleetId, agent_id: agentId, days });

// Same refusal handling as alerts; an engine without the action hides the section.
export const dataSettingsGet = (fleetId: string) => alertsAction<DataSettings>({ action: 'fleet_data_settings_get', fleet_id: fleetId });
export const dataSettingsSet = (fleetId: string, patch: Partial<DataSettings>) =>
  alertsAction<DataSettings & { success: boolean }>({ action: 'fleet_data_settings_set', fleet_id: fleetId, ...patch });
