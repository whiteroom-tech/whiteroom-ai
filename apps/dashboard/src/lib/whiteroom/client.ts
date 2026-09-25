// Single entry point for the dashboard's calls to the WhiteRoom proxy.
// Replaces the raw fetch() calls that were duplicated across the dashboard,
// fleet, and onboarding pages, and centralizes the auth-header rule:
//   - keys starting with "sk-"  -> x-api-key
//   - anything else (fleet tokens) -> Authorization: Bearer
//   - no key -> unauthenticated (e.g. token_login)

import type {
  AgentInfo,
  AgentPerformanceResult,
  AuditLogResponse,
  CatalogEntry,
  ClaimFleetResult,
  ControlDefinition,
  CustomControlInput,
  DeleteKeyResult,
  FleetReport,
  GetHandoverResult,
  ListFleetsResult,
  ListKeysResult,
  PerformanceEvidenceResult,
  PerformanceFeedbackResult,
  PerformanceHealthResult,
  PerformanceIndexResult,
  PerformanceLiveFeedResult,
  PerformanceRecommendation,
  PaginatedRecommendationsResult,
  ReadinessAssessment,
  ReadinessResult,
  RecommendationGetResult,
  RecommendationBriefResult,
  RecommendationExportMarkdownResult,
  FleetHourlyResult,
  PerformanceCostForecastResult,
  GetBudgetResult,
  SetBudgetResult,
  GetTokenBudgetResult,
  SetTokenBudgetResult,
  RegisterResult,
  StoreKeyResult,
  TokenLoginResult,
} from './types';

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

/**
 * True only for a genuine credential rejection (401/403). A timeout, network
 * failure, or 5xx is NOT an auth error — credentials should be kept and the
 * call retried.
 */
export function isAuthError(e: unknown): boolean {
  return e instanceof WhiteRoomApiError && (e.status === 401 || e.status === 403);
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

async function postRaw(
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
  if (!res.ok) throw new WhiteRoomApiError(`HTTP ${res.status}`, res.status);
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

export function clearAuditLog(fleetId: string, key?: string): Promise<{ success?: boolean; cleared?: number; error?: string }> {
  return apiCall({ action: 'clear_audit', fleet_id: fleetId }, key);
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

// -- Sandbox --

export interface CreateSandboxResult {
  success?: boolean;
  sandboxId?: string;
  fleetToken?: string;
  proxyKey?: string;
  expiresAt?: string;
  isTrial?: boolean;
  experience?: "legacy" | "new";
  controls?: ControlDefinition[];
  error?: string;
}

export interface SandboxAgentInfo {
  agentId: string;
  role: string;
  status: string;
  watchMinutes: number;
  watchCount: number;
  totalTasks: number;
  totalTokens: number;
  pairedWith: string | null;
  currentWatch: { watchNumber: number; minutesWorked: number; tokensUsed: number; tasksCompleted: number } | null;
}

export interface SandboxAuditEntry {
  id: string;
  timestamp: string;
  type: string;
  agentId: string | null;
  taskId?: string;
  taskName?: string;
  watchNumber?: number;
  tokensUsed?: number;
  minutesSpent?: number;
  details?: Array<{ name: string; args: string }>;
  toAgent?: string;
  fromAgent?: string;
  [key: string]: unknown;
}

export interface SandboxStatusResult {
  success?: boolean;
  sandboxId?: string;
  environment?: string;
  experience?: "legacy" | "new";
  expiresAt?: string;
  expiresInSeconds?: number | null;
  assertionStates?: Record<string, { status: string; observedAt?: string; failedAt?: string; diagnostic?: string; metric?: number }>;
  controls?: ControlDefinition[];
  policyMode?: "observe" | "enforce";
  policyVersion?: number;
  liveReady?: boolean;
  demoComplete?: boolean;
  overallControlResult?: ReadinessResult;
  agents?: SandboxAgentInfo[];
  auditLog?: SandboxAuditEntry[];
  error?: string;
}

export interface SandboxReportResult {
  success?: boolean;
  sandboxId?: string;
  overall?: string;
  assertions?: Record<string, { status: string; observedAt?: string; failedAt?: string; diagnostic?: string; metric?: number }>;
  error?: string;
}

export function createSandbox(
  opts: {
    userId: string;
    apiKey?: string;
    isTrial?: boolean;
    ttlMinutes?: number;
    selectedCatalogIds?: string[];
    customControls?: CustomControlInput[];
    policyMode?: 'observe' | 'enforce';
  },
  key?: string,
): Promise<CreateSandboxResult> {
  return apiCall<CreateSandboxResult>({
    action: 'create_sandbox',
    user_id: opts.userId,
    is_trial: opts.isTrial,
    api_key: opts.apiKey,
    ttl_minutes: opts.ttlMinutes,
    selected_catalog_ids: opts.selectedCatalogIds,
    custom_controls: opts.customControls,
    policy_mode: opts.policyMode,
  }, key);
}

export function sandboxStatus(userId: string, key?: string): Promise<SandboxStatusResult> {
  return apiCall<SandboxStatusResult>({ action: 'sandbox_status', user_id: userId }, key);
}

export function destroySandbox(sandboxId: string, key?: string): Promise<{ success?: boolean; error?: string }> {
  return apiCall<{ success?: boolean; error?: string }>({ action: 'destroy_sandbox', sandbox_id: sandboxId }, key);
}

export function sandboxReport(sandboxId: string, key?: string): Promise<SandboxReportResult> {
  return apiCall<SandboxReportResult>({ action: 'test_report', sandbox_id: sandboxId }, key);
}

export function resetSandboxSession(sandboxId: string, key?: string): Promise<{ success?: boolean; error?: string }> {
  return apiCall<{ success?: boolean; error?: string }>({ action: 'reset_session', sandbox_id: sandboxId }, key);
}

export interface DemoStep {
  step: number;
  action: string;
  detail: string;
  assertion?: string;
  timestamp: string;
}

export function startDemo(sandboxId: string, key?: string): Promise<{ success?: boolean; message?: string; steps?: DemoStep[]; error?: string }> {
  return apiCall<{ success?: boolean; message?: string; steps?: DemoStep[]; error?: string }>({ action: 'start_demo', sandbox_id: sandboxId }, key);
}

export function pauseAgent(fleetId: string, agentId: string, key?: string): Promise<{ success?: boolean; error?: string }> {
  return apiCall<{ success?: boolean; error?: string }>({ action: 'pause_agent', fleet_id: fleetId, agent_id: agentId }, key);
}

export function resumeAgent(fleetId: string, agentId: string, key?: string): Promise<{ success?: boolean; error?: string }> {
  return apiCall<{ success?: boolean; error?: string }>({ action: 'resume_agent', fleet_id: fleetId, agent_id: agentId }, key);
}

export interface SandboxHistoryEntry {
  sandboxId: string;
  userId: string;
  createdAt: string;
  destroyedAt: string;
  assertions: Record<string, { status: string; observedAt?: string; metric?: number }>;
  overall: 'pass' | 'fail' | 'in_progress';
  agentCount: number;
  totalTasks: number;
  isTrial: boolean;
}

export function sandboxHistory(userId: string, key?: string): Promise<{ success?: boolean; sessions?: SandboxHistoryEntry[]; error?: string }> {
  return apiCall<{ success?: boolean; sessions?: SandboxHistoryEntry[]; error?: string }>({ action: 'sandbox_history', user_id: userId }, key);
}

export function sandboxAnalytics(key?: string): Promise<{ success?: boolean; totalSessions?: number; passed?: number; failed?: number; passRate?: number; error?: string }> {
  return apiCall<{ success?: boolean; totalSessions?: number; passed?: number; failed?: number; passRate?: number; error?: string }>({ action: 'sandbox_analytics' }, key);
}

// -- Control Builder --

export function controlCatalog(key?: string): Promise<{ success?: boolean; catalog?: CatalogEntry[]; error?: string }> {
  return apiCall<{ success?: boolean; catalog?: CatalogEntry[]; error?: string }>({ action: 'control_catalog' }, key);
}

export function defineControl(
  sandboxId: string,
  control: CustomControlInput,
  key?: string,
): Promise<{ success?: boolean; control?: ControlDefinition; controls?: ControlDefinition[]; policyVersion?: number; error?: string }> {
  return apiCall({ action: 'define_control', sandbox_id: sandboxId, control }, key);
}

export function removeControl(
  sandboxId: string,
  controlId: string,
  key?: string,
): Promise<{ success?: boolean; controls?: ControlDefinition[]; policyVersion?: number; error?: string }> {
  return apiCall({ action: 'remove_control', sandbox_id: sandboxId, control_id: controlId }, key);
}

export function listControls(
  sandboxId: string,
  key?: string,
): Promise<{ success?: boolean; controls?: ControlDefinition[]; readiness?: ReadinessAssessment; error?: string }> {
  return apiCall({ action: 'list_controls', sandbox_id: sandboxId }, key);
}

export function setControlRequired(
  sandboxId: string,
  controlId: string,
  requiredByUser: boolean,
  key?: string,
): Promise<{ success?: boolean; control?: ControlDefinition; error?: string }> {
  return apiCall({ action: 'set_control_required', sandbox_id: sandboxId, control_id: controlId, required_by_user: requiredByUser }, key);
}

export function resetControlEvidence(
  sandboxId: string,
  controlId: string,
  key?: string,
): Promise<{ success?: boolean; control?: ControlDefinition; error?: string }> {
  return apiCall({ action: 'reset_control_evidence', sandbox_id: sandboxId, control_id: controlId }, key);
}

export function goLive(
  sandboxId: string,
  key?: string,
): Promise<{ success?: boolean; readiness?: ReadinessAssessment; error?: string }> {
  return apiCall({ action: 'go_live', sandbox_id: sandboxId }, key);
}

// -- Performance --

export function performanceIndex(fleetId: string, hoursBack?: number, key?: string): Promise<PerformanceIndexResult> {
  return apiCall<PerformanceIndexResult>({ action: 'performance_index', fleet_id: fleetId, hours_back: hoursBack ?? 24 }, key);
}

export function performanceAgent(fleetId: string, agentId: string, hoursBack?: number, key?: string): Promise<AgentPerformanceResult> {
  return apiCall<AgentPerformanceResult>({ action: 'performance_agent', fleet_id: fleetId, agent_id: agentId, hours_back: hoursBack ?? 24 }, key);
}

export function performanceRecommendations(fleetId: string, status?: string, key?: string): Promise<{ fleetId: string; recommendations: PerformanceRecommendation[] }> {
  return apiCall<{ fleetId: string; recommendations: PerformanceRecommendation[] }>({ action: 'performance_recommendations', fleet_id: fleetId, status }, key);
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

export function performanceHealth(fleetId: string, key?: string): Promise<PerformanceHealthResult> {
  return apiCall<PerformanceHealthResult>({ action: 'performance_health', fleet_id: fleetId }, key);
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
 * Full-detail, un-redacted live feed — kept only for a short TTL (see
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
  return apiCall<PerformanceCostForecastResult>({ action: 'performance_cost_forecast', fleet_id: fleetId, task_type: taskType }, key);
}

export function getBudgetUsd(fleetId: string, key?: string): Promise<GetBudgetResult> {
  return apiCall<GetBudgetResult>({ action: 'get_budget_usd', fleet_id: fleetId }, key);
}

export function setBudgetUsd(fleetId: string, budgetUsd: number | null, key?: string): Promise<SetBudgetResult> {
  return apiCall<SetBudgetResult>({ action: 'set_budget_usd', fleet_id: fleetId, budget_usd: budgetUsd }, key);
}

export function getTokenBudget(fleetId: string, key?: string): Promise<GetTokenBudgetResult> {
  return apiCall<GetTokenBudgetResult>({ action: 'get_token_budget', fleet_id: fleetId }, key);
}

export function setTokenBudget(fleetId: string, tokenBudget: number | null, key?: string): Promise<SetTokenBudgetResult> {
  return apiCall<SetTokenBudgetResult>({ action: 'set_token_budget', fleet_id: fleetId, token_budget: tokenBudget }, key);
}
