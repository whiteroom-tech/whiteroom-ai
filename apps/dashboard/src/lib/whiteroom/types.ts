// Shared WhiteRoom API shapes for the dashboard.
// These mirror the proxy's /api/white-room responses. Kept local to the
// dashboard (not imported from @whiteroom-ai/sdk) so the app stays a
// standalone build with no cross-package linking.

export interface ToolDetail {
  name: string;
  args: string;
}

/** A durable pause or stop (engine gov-state.ts): the agent refuses calls until resumed. */
export interface AgentHold {
  state: 'paused' | 'stopped'; by: string; reason: string | null; at: string;
  /** When the agent was first held, if this hold replaced an earlier one (engine applyHold keeps it). */
  since?: string;
}

export interface AgentInfo {
  agentId: string;
  status: string;
  /** Set while held (P2.2). Wins over the status. */
  hold?: AgentHold | null;
  /** Whether this fleet has Pause/Stop as holds (Gov v1). The engine's check_watch returns it with `hold` (engine #90). */
  govV1?: boolean;
  taskType?: string | null;
  /** The agent's last call had no x-whiteroom-agent, so its name came from its system prompt. */
  nameInferred?: boolean;
  watchNumber?: number;
  minutesWorked?: number;
  minutesRemaining?: number;
  percentComplete?: string;
  tasksCompleted?: number;
  tokensUsed?: number;
  needsHandover?: boolean;
  restRemaining?: string;
  restStartedAt?: string;
  alarmAt?: string;
  restPercent?: string;
  watchMinutes?: number;
  restMinutes?: number;
  handoverMinutes?: number;
  stale?: boolean;
  disconnected?: boolean;
  /**
   * The shift under way; null when there is none (audit M14). Older engines
   * leave it out and put lifetime totals in the flat fields while idle.
   */
  currentShift?: ShiftMeasures | null;
  /** An idle agent's most recent shift, when the engine still has it. */
  lastShift?: ShiftMeasures | null;
  lifetime?: { tokensUsed: number; tasksCompleted: number; minutesWorked: number };
}

/** One shift's measurements (engine check_watch). */
export interface ShiftMeasures { watchNumber: number; tokensUsed: number; tasksCompleted: number; minutesWorked: number }

export interface HandoverDoc {
  state?: string;
  pending?: Array<{ task: string }>;
  warnings?: string[];
  session_stats?: { tasks_completed: number; total_tokens: number };
  /** A short stand-in, sent when the full notes were rejected as too large (engine PR 165). */
  fallback?: boolean;
}

export interface FleetReport {
  fleetId: string;
  agentCount: number;
  status: { working: string[]; resting: string[]; idle: string[]; handover_out?: string[] };
  /** Held agents (P2.2); absent from older engines. */
  holds?: Record<string, AgentHold>;
  govV1?: boolean;
  totals: { workMinutes: number; tokens: number; tasks: number; handovers: number };
  currentWatch?: { tasks: number; tokens: number; workMinutes: number };
  energySavings: {
    compressionRatio?: number; estimatedTokensSaved: number; estimatedCostSaved: string; estimatedEnergySaved: string; formula: string;
    /** Saved tokens with no price to value them: estimatedCostSaved leaves them out (absent on older engines). */
    unpricedTokensSaved?: number;
    /** Prompt-cache savings over everything stored, net of write premiums: only caching WhiteRoom added (absent on older engines). */
    cacheCostSaved?: string;
    /** What the agents' own caching saved: shown apart, never in totalCostSaved (absent on older engines). */
    agentCacheCostSaved?: string;
    /** Cache reads with no price: cacheCostSaved leaves them out. */
    unpricedCacheReadTokens?: number;
    /** estimatedCostSaved + cacheCostSaved: "Saved by WhiteRoom" on Home (absent on older engines). */
    totalCostSaved?: string;
    /** in_memory_estimate: the engine couldn't read its stored trail; newest events only, at the fallback rate. */
    pricing?: 'cache_aware_input' | 'in_memory_estimate';
  };
  compliance: { allAgentsWithinLimits: boolean; restingAgentsCount: number; laborScore: string };
  agentDetails?: Array<AgentInfo & { handoverDoc?: HandoverDoc }>;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  type: string;
  agentId?: string;
  taskId?: string;
  taskName?: string;
  watchNumber?: number;
  tokensUsed?: number;
  minutesSpent?: number;
  remaining?: number;
  details?: ToolDetail[];
  toAgent?: string;
  fromAgent?: string;
  /** governance_block / governance_would_block / governance_rule_changed */
  ruleType?: GovernanceRuleType;
  reason?: GovernanceReason;
  model?: string;
  /** Repeats of the same governance event folded into this one (engine dedupes per minute). */
  occurrences?: number;
  [key: string]: unknown;
}

export interface AuditLogResponse {
  fleetId: string;
  total: number;
  limit: number;
  filters: { agentIds: string[]; types: string[] };
  /** Timestamp of the oldest event the engine still holds. */
  retainedSince?: string | null;
  /** True once older events have been trimmed; absent from older engines. */
  historyTruncated?: boolean;
  entries: AuditEntry[];
}

/**
 * The Performance tab's live feed (performance_live_feed action): full
 * detail with credentials removed (real reply text, tool-call arguments), kept
 * only for `ttlHours` and then deleted. A different store from audit_log
 * (which is the permanent, content-free record) — reuses AuditEntry's shape
 * since the fields line up, but the content inside taskName/details here is
 * genuinely raw, not a label.
 */
export interface PerformanceLiveFeedResult {
  fleetId: string;
  ttlHours: number;
  total: number;
  entries: AuditEntry[];
  /** off: the fleet's owner turned the live feed off (engines from PR 6 on). */
  capture?: 'on' | 'off';
  error?: string;
}

// -- Client helper result shapes (permissive: success + error fields coexist) --

export interface RegisterResult {
  error?: string;
  fleetToken?: string;
}

export interface TokenLoginResult {
  success?: boolean;
  fleetId?: string;
  report?: FleetReport;
  error?: string;
}

export interface ListFleetsResult {
  fleets?: Array<{ fleetId: string; agentCount?: number; agents?: string[] }>;
  error?: string;
}

export interface ClaimFleetResult {
  success?: boolean;
  fleetId?: string;
  fleetToken?: string;
  error?: string;
}

// -- Provider keys (BYOK) --
//
// A fleet can hold several provider keys at once — one per key the account
// connects — so these are lists, not a single value. The engine stores only a
// hash and the last four characters of each; the raw key never comes back.

export interface ProviderKey {
  /** Truncated identifier, e.g. "sk-wr-1a2b..." — enough to delete by prefix. */
  wrKey: string;
  provider: string;
  keyHint: string;
  createdAt: string;
  endpoint?: string;
  /** Set when the key is for one agent only: its calls are that agent's, whatever name they send. */
  agentId?: string;
}

export interface ListKeysResult {
  success?: boolean;
  keys?: ProviderKey[];
  error?: string;
}

export interface StoreKeyResult {
  success?: boolean;
  /** Full proxy key — returned once, at creation, and never listed again. */
  proxyKey?: string;
  provider?: string;
  keyHint?: string;
  proxyUrl?: string;
  /** The agent the key is for, when one was named. */
  agentId?: string;
  error?: string;
}

export interface DeleteKeyResult {
  success?: boolean;
  removed?: { provider: string; keyHint: string };
  error?: string;
}

// -- Bedrock cross-account role --
//
// A separate, single-slot config per fleet (not a list like provider keys):
// the engine assumes this role via sts:AssumeRole rather than holding a key.
// externalId is write-only — bedrock_role_status never echoes it back, same
// as a provider key's raw value never being listed again.

export interface BedrockRoleStatus {
  configured: boolean;
  awsAccountId?: string;
  roleArn?: string;
  region?: string;
  createdAt?: string;
}

export interface StoreBedrockRoleResult {
  success?: boolean;
  error?: string;
}

export interface DeleteBedrockRoleResult {
  success?: boolean;
  error?: string;
}

// -- Performance --

export interface PerformanceModelSummary {
  provider: string;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface PerformanceRecommendation {
  id: string;
  detector: string;
  agentId: string;
  action: string;
  status: string;
  createdAt: string;
}

export interface PerformanceIndexResult {
  fleetId: string;
  period: { start: string; end: string };
  summary: {
    totalCalls: number;
    totalCost: number;
    /** Median response time (ms) on current engines. */
    avgLatencyMs: number | null;
    /** Attempts with no catalogue price: totalCost is a lower bound when > 0 (absent on older engines). */
    unpricedAttempts?: number;
    errorRate: number;
    /** Calls stopped by a governance rule in Enforce (absent on older engines). */
    blockedCount?: number;
    /** Calls from agents without a name, in every total but credited to no agent (absent on older engines). */
    unnamedCalls?: number;
    models: PerformanceModelSummary[];
    /** Prompt caching over the window, priced per model (absent on older engines). */
    cache?: CacheSummary;
  };
  /** The same totals over the window of the same length just before this one (absent on older engines). */
  previous?: PerformanceWindowTotals;
  recommendations: PerformanceRecommendation[];
  priceInfo: { version: string; ageDays: number; stale: boolean; expired: boolean };
  error?: string;
}

/** engine performance_index.previous: the "vs prior period" figures. */
export interface PerformanceWindowTotals {
  period: { start: string; end: string };
  totalCalls: number;
  /** Micros, as summary.totalCost. */
  totalCost: number;
  pricedAttempts: number;
  unpricedAttempts: number;
  /** Median response time (ms); null without calls. */
  avgLatencyMs: number | null;
}

export interface HourlyDataPoint {
  hour: string;
  calls: number;
  costMicros: number;
  errorCount: number;
  avgLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

/** One agent's calls and spend over a window (engine performance_agent): Controls reads its daily spend and call count. */
export interface AgentPerformanceResult {
  fleetId: string;
  agentId: string;
  period: { start: string; end: string };
  hourly: HourlyDataPoint[];
  totals: { calls: number; costMicros: number };
  error?: string;
}

export interface AgentScore {
  agentId: string;
  calls: number;
  /** % of calls that finished cleanly (0-100). Null with no calls in the window. */
  completeRate: number | null;
  /** How the agent's task-type cost compares to its seed estimate (0-100). Null with no declared task type, or no completed task yet. */
  costDiligence: number | null;
  /** This agent's median latency vs. the fleet's (0-100, capped at 100). Null with too few calls for a median. */
  speedScore: number | null;
  /** Mean of whichever of the three above are available, out of 10. Null if none are. */
  score: number | null;
}

export interface AgentScoresResult {
  fleetId: string;
  period: { start: string; end: string };
  agents: AgentScore[];
  error?: string;
}

export interface PerformanceEvidenceResult {
  finding: {
    id: string;
    detector: string;
    agentId: string;
    cohort: string;
    windowStart: string;
    windowEnd: string;
    measures: Record<string, number>;
    basis: string;
    coverage: string;
    limitations: string | null;
    evidenceCallIds: string[];
  } | null;
  calls: Array<Record<string, unknown>>;
  error?: string;
}

export interface PerformanceFeedbackResult {
  success: boolean;
  status?: string;
  error?: string;
}

// -- Recommendations contract v1 --

export interface RecommendationDetail {
  id: string;
  detector: string;
  agentId: string;
  source: string;
  cohort: string;
  action: string;
  status: string;
  verificationStatus: string;
  currentFindingId: string | null;
  feedbackCount: number;
  createdAt: string;
  updatedAt: string;
  summary?: string | null;
  // Agent Diagnosis detectors only (engine spec Rev 4.4 §5.7). `action` above
  // stays a string; the rule suggestion is `suggestedAction`.
  measures?: DiagnosisMeasures;
  limitations?: string | null;
  estWastedTokens?: number | null;
  estWastedCostMicros?: number | null;
  evidenceCount?: number;
  suggestedAction?: DiagnosisSuggestedAction;
}

// -- Agent Diagnosis (diagnosis.v1) --

export type DiagnosisDetectorId =
  | 'review_handover_churn'
  | 'review_tool_loops'
  | 'review_spend_outliers'
  | 'review_tool_errors'
  | 'review_tool_silence'
  | 'review_provider_failures';

export type DiagnosisMeasures = Record<string, number | string>;

/** Suggested rules always start in Watch. */
export type DiagnosisSuggestedAction =
  | { kind: 'rule'; rule: 'loop_breaker' | 'spend_cap'; mode: 'watch'; appliesTo: string[]; params: Record<string, number | string | string[]> }
  | { kind: 'howto'; howtoId: 'handover_churn' | 'tool_errors' | 'tool_silence' | 'provider_failures' };

export interface DiagnosisFinding {
  recommendationId: string;
  /** The recommendation's current finding id: send as finding_version. */
  findingId: string;
  findingVersion: number;
  detector: DiagnosisDetectorId;
  detectorVersion: number;
  status: string;
  measures: DiagnosisMeasures;
  estWastedTokens: number | null;
  estWastedCostMicros: number | null;
  evidenceCallIds: string[];
  coverage: string;
  limitations: string | null;
  suggestedAction: DiagnosisSuggestedAction;
}

export interface DiagnosisReport {
  schema: 'diagnosis.v1';
  agentId: string;
  window: { from: string; to: string; days: 7; calls: number; watches: number };
  findings: DiagnosisFinding[];
  clear: Array<{ detector: DiagnosisDetectorId; note: string | null }>;
  notMeasured: Array<{ detector: DiagnosisDetectorId; code: string; reason: string }>;
}

export interface FleetDiagnosis {
  checkedAt: string | null;
  source: 'background' | 'manual' | null;
  reports: DiagnosisReport[];
  waiting: Array<{ agentId: string; calls7d: number }>;
  skipped: Array<{ agentId: string; calls7d: number }>;
  truncated: boolean;
  readyAgents: number;
  busiest: { agentId: string; calls7d: number } | null;
  minCalls: number;
  reused?: boolean;
}

export interface FleetHourlyDataPoint {
  hour: string;
  calls: number;
  completeCount: number;
  errorCount: number;
  costMicros: number;
  latencyP50Ms: number | null;
  latencyCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Attempts with no catalogue price, or no usage, in this hour (absent on older engines). */
  unpricedAttempts?: number;
  /** An upper bound on what the unpriced calls with no usage could have cost (engine PR 168). */
  missingSpendBoundMicros?: number;
  /** Unpriced attempts that can't be bounded. */
  unboundedAttempts?: number;
  /** Attempts dropped before they were recorded: their spend isn't in costMicros (absent on older engines). */
  droppedAttempts?: number;
}

export interface FleetHourlyResult {
  fleetId: string;
  period: { start: string; end: string };
  hourly: FleetHourlyDataPoint[];
  error?: string;
}

/**
 * engine performance_cost_forecast, as the dashboard reads it: Hourly cost's
 * figure. The engine also sends the old fleet-budget fields, which nothing
 * here shows any more (per-agent budgets are on agent_budgets_get).
 */
export interface PerformanceCostForecastResult {
  fleetId: string;
  /** Spend per working hour: the average over hours with calls in burnLookbackHours. */
  burnRateUsdPerHour: number;
  /** True when recent calls had no price on file: burnRateUsdPerHour is $0 because it's unpriced, not free. */
  costUnavailable?: boolean;
  burnLookbackHours?: number;
  burnActiveHours?: number;
  error?: string;
}

/** engine savings totals (savings.ts). */
export interface SavingsTotals { tokens: number; usdMicros: number; unpricedTokens: number; basis: 'cache_aware_input' }

/** engine performance_index summary.cache. */
export interface CacheSummary {
  /** Uncached input, cache reads and cache writes, each counted once. */
  freshInputTokens: number;
  readTokens: number;
  writeTokens: number;
  /** The three below cover only calls WhiteRoom marked for caching. reads × (input rate − cache-read rate), per model. */
  readSavedMicros: number;
  /** writes × (cache-write rate − input rate), per model. */
  writePremiumMicros: number;
  unpricedReadTokens: number;
  /** What the agents' own caching saved, net, never counted as WhiteRoom's (absent on older engines). */
  agentSavedMicros?: number;
}

/** Why an agent has no tasks-left figure (engine PR 297), checked in this order. */
export type TasksLeftReason = 'no_task_type' | 'not_enough_tasks' | 'no_budget' | 'partial_coverage';

/** One agent's daily budget against its spend today, and its cost prediction (a planning figure, never a limit). */
export interface AgentBudgetForecast {
  agentId: string;
  /** Null for an agent without a budget (listed when all agents are asked for). */
  budgetUsd: number | null;
  /** Optional daily token budget beside the dollar one; absent on older engines. */
  budgetTokens?: number | null;
  spentTodayUsd: number;
  tokensToday?: number;
  /** Spend per working hour over the last 14 days; null without priced calls. Not shown; newer engines leave it out. */
  burnRateUsdPerHour?: number | null;
  /** Calls the rest of today's budget covers at the agent's own average cost per call. */
  callsLeft: number | null;
  callsLeftReason: 'available' | 'no_history' | 'partial_coverage' | 'no_budget';
  /** The rest is the cost prediction (engine PR 297); all absent on older engines. */
  taskType?: string | null;
  /** Average cost and tokens of one predicted unit (see AgentBudgetsResult.unit); null without priced calls. */
  costPerTaskUsd?: number | null;
  tokensPerTask?: number | null;
  /** Units left today: whichever of the dollar and token budgets runs out first. */
  tasksLeft?: number | null;
  limitedBy?: 'usd' | 'tokens' | null;
  tasksLeftReason?: TasksLeftReason | null;
}

export interface AgentBudgetsResult {
  fleetId: string;
  budgetPeriod: 'day';
  budgetTimeZone: string;
  /** What one predicted "task" is: "call" today. Absent on engines without the per-agent prediction. */
  unit?: string;
  /** How far back the per-unit averages look, in hours. */
  rateLookbackHours?: number;
  agents: AgentBudgetForecast[];
}

export interface PaginatedRecommendationsResult {
  contractVersion: string;
  dataRevision: string;
  fleetId: string;
  recommendations: RecommendationDetail[];
  cursor: string | null;
  pageSize: number;
  total: number;
  error?: string;
}

export interface RecommendationGetResult {
  contractVersion: string;
  recommendation: RecommendationDetail | null;
  finding: Record<string, unknown> | null;
  error?: string;
}

export interface BriefSection {
  heading: string;
  content: string;
}

export interface RecommendationBriefResult {
  contractVersion: string;
  recommendationId: string;
  title: string;
  lane: string;
  sections: BriefSection[];
  generatedAt: string;
  error?: string;
}

export interface RecommendationExportMarkdownResult {
  contractVersion: string;
  markdown: string;
  error?: string;
}

// -- Control Builder types --

export interface ExecutableRule {
  ruleType: "tool_denylist";
  params: { tools: string[] };
}

export interface ProposedRule {
  ruleType: string;
  params: Record<string, unknown>;
}

export type EvaluatorType = "assertion" | "detection" | "denylist" | "enforcement" | "audit";

export interface EvidenceRecord {
  status: "observed" | "failed";
  timestamp: string;
  diagnostic?: string;
  metric?: number;
  requestId: string;
  testedRevision: number;
  testedPolicyVersion: number;
}

export interface ControlResult {
  liveEvidence?: EvidenceRecord;
  demoEvidence?: EvidenceRecord;
  liveIncomplete?: { droppedStatus: "observed" | "failed" };
  demoIncomplete?: { droppedStatus: "observed" | "failed" };
}

export interface ControlDefinition {
  controlId: string;
  revision: number;
  name: string;
  description: string;
  source: "core" | "catalog" | "custom";
  evaluator: EvaluatorType;
  requiredByUser: boolean;
  required: boolean;
  rules: ExecutableRule[];
  proposedRules?: ProposedRule[];
  testMethod: string;
  capability: "supported" | "unsupported";
  activation: "active" | "inactive" | "review";
  result: ControlResult;
  liveEligibility?: EligibleResult;
  demoEligibility?: EligibleResult;
}

export interface EligibleResult {
  eligible: boolean;
  status?: "observed" | "failed";
  reason?: string;
}

export interface ReadinessResult {
  status: "pass" | "fail" | "partial" | "empty" | "blocked";
  reason?: string;
  blocking?: string[];
}

export interface CustomControlInput {
  name: string;
  description: string;
  rules: Array<ExecutableRule | ProposedRule>;
  requiredByUser?: boolean;
  testMethod: string;
}

// -- Fleet governance rules (Controls page) --

export type GovernanceRuleType = 'spend_cap' | 'loop_breaker' | 'model_allowlist' | 'tool_list' | 'call_rate' | 'keyword';
export type GovernanceMode = 'off' | 'watch' | 'enforce';
/** What Enforce does (engine P2.3): notify, block, pause or stop. */
export type GovernanceResponse = 'notify' | 'block' | 'pause' | 'stop';
export type GovernanceReason = 'budget_exceeded' | 'loop_detected' | 'model_not_allowed' | 'tool_not_allowed' | 'rate_exceeded' | 'keyword_found';
export type GovernanceScope = 'all' | string[];

export interface SpendCapParams { dailyCap: number; scope: 'run' | 'day'; unit: 'tokens' | 'dollars' }
export interface LoopBreakerParams { threshold: number; scope: 'run' | 'day'; ignoreTools: string[] }
export interface ModelAllowlistParams { allowedModels: string[] }
/** Tools an agent may not run; judged on the model's reply before the agent gets it. */
export interface ToolListParams { blockedTools: string[] }
/** More than maxCalls model calls in any 60 seconds. */
export interface CallRateParams { maxCalls: number }
/** Keywords rule (engine E4): words to find in what a call sends ("incoming"), the model's reply, or both. */
export type KeywordWhere = 'incoming' | 'replies' | 'both';
export interface KeywordParams {
  keywords: string[]; where: KeywordWhere; wholeWord: boolean;
  /** Sent instead of the list to a caller without the dashboard's secret (keywords is then empty). */
  keywordCount?: number;
}
export type GovernanceParams = SpendCapParams | LoopBreakerParams | ModelAllowlistParams | ToolListParams | CallRateParams | KeywordParams;

export interface GovernanceRule {
  id: string;
  fleetId: string;
  ruleType: GovernanceRuleType;
  params: GovernanceParams;
  mode: GovernanceMode;
  /** Absent from older engines, where Enforce always blocks. */
  response?: GovernanceResponse;
  /** With response block, also sends the fleet's alert (engine E2; absent from older engines). */
  alsoNotify?: boolean;
  appliesTo: GovernanceScope;
  version: number;
  changedBy: string;
  changedAt: string;
  /** Set when the rule came from a Diagnosis suggestion. */
  sourceRecommendationId?: string;
}

/** What a rule was set to (engine 0058): enough to show old → new and to put it back. */
export interface GovernanceRuleSnapshot {
  mode: GovernanceMode;
  response?: GovernanceResponse;
  alsoNotify?: boolean;
  appliesTo: GovernanceScope;
  params: GovernanceParams;
}

export interface GovernanceHistoryEntry {
  id: string;
  ruleId: string;
  ruleType: GovernanceRuleType;
  description: string;
  by: string;
  time: string;
  /** Null before an add and after a removal; absent on older entries and older engines. */
  before?: GovernanceRuleSnapshot | null;
  after?: GovernanceRuleSnapshot | null;
}

export interface GovernanceListResult {
  fleetId: string;
  rules: GovernanceRule[];
  history: GovernanceHistoryEntry[];
  agents: string[];
  /** When each agent was last active (null: never); absent from older engines. */
  lastActiveAt?: Record<string, string | null>;
  /** Pause and Stop responses are offered (Gov v1 fleets). */
  govV1?: boolean;
}

/** Rule actions in words (engine rule_actions). */
export interface RuleActionCounts { blocked: number; paused: number; stopped: number; toldYou: number; wouldAct: number }
export interface RuleActionsResult { fleetId: string; totals: RuleActionCounts; byAgent: Record<string, RuleActionCounts>; /** Per rule type, from the same rows as totals (newer engines). */ byRule?: Record<string, RuleActionCounts>; /** Per rule id (gr_…), from the same rows (engine E1a). */ byRuleId?: Record<string, RuleActionCounts> }
export interface RunRuleAction {
  at: string; ruleId: string; ruleType: GovernanceRuleType; response: GovernanceResponse; mode: GovernanceMode; occurrences: number;
  /** Timeline ids of the calls it was for, in timeline order (engine PR 298; empty on older rows, absent on older engines). */
  eventIds?: string[];
  ruleName?: string | null;
  outcome?: CallRuleAction['outcome'];
  /** The decision's reason code (model_not_allowed, …). Absent on older engines. */
  reason?: string | null;
}

/** A rule that acted, or would have, on one call (engine PR 298). */
export interface CallRuleAction { ruleId: string; ruleType: string; ruleName?: string | null; mode: string; response: string; outcome: 'blocked' | 'paused' | 'stopped' | 'notified' | 'would_block'; reason?: string | null }

// -- Runs (engine list_runs / get_run_events; a run is one agent's shift) --

export interface RunSummary {
  runId: string;
  agentId: string;
  shift: number;
  startedAt: string;
  endedAt: string;
  lengthSeconds: number;
  calls: number;
  failedCalls: number;
  blockedCalls: number;
  spendMicros: number;
  unpricedAttempts: number;
  coverage: { calls: number; checked: number };
  /** What stood out (engine P2.1). Absent from older engines. */
  flags?: RunFlag[];
  /** Times a Watch rule would have acted in this run (engine E1a). Absent from older engines. */
  wouldActCalls?: number;
}

/** A run flag: flags only, nothing was blocked. */
export type RunFlag =
  | { signal: 'repeating_call'; tool: string; calls: number }
  | { signal: 'error_streak'; calls: number };

export interface RunDaysResult {
  fleetId: string;
  /** Oldest first; days with no runs are left out. `flagged` and `ruleActivity` from engine PR 298. */
  days: RunDayCount[];
  /** True when the range held too many calls to count flagged runs (engine PR 298). */
  flaggedUnavailable?: boolean;
}

export interface RunDayCount { day: string; runs: number; flagged?: number; ruleActivity?: number }
export interface RunHourCount { hour: number; runs: number; ruleActivity?: number }

export interface ListRunsResult {
  fleetId: string;
  runs: RunSummary[];
  total: number;
  cursor: string | null;
}

export interface RunEvent {
  id: string;
  kind: 'call' | 'event';
  at: string;
  type: string;
  model?: string | null;
  /** Older engines: the tools the request offered, which is not use. Current engines: requested tools. */
  tools?: string[];
  /** Tools the model's reply asked for; null when the reply wasn't read (streamed). Absent on older engines. */
  requestedTools?: string[] | null;
  /** Tools the request offered the model. Not shown as use; kept for exports and investigations. */
  availableTools?: string[];
  durationMs?: number | null;
  /** Calls: the rules that acted, or would have, on this call (engine PR 298). */
  ruleActions?: CallRuleAction[];
  detail?: Record<string, unknown>;
}

/** A run's header on Run detail. The totals and models come from engine PR 298; older engines send only the first six fields. */
export interface RunHeader {
  runId: string; agentId: string; shift: number; startedAt: string; endedAt: string;
  flags?: RunFlag[];
  ruleActions?: RunRuleAction[];
  calls?: number;
  spendMicros?: number;
  unpricedAttempts?: number;
  failedCalls?: number;
  blockedCalls?: number;
  /** Calls a Watch rule would have blocked (distinct linked calls, a lower bound); null when it can't be told. */
  wouldBlockCalls?: number | null;
  /** list_runs' figure for the run (times a Watch rule would have acted): the fallback for older runs. */
  wouldActCalls?: number;
  /** The run's rule actions couldn't be read: Rule activity is unknown, not empty. */
  ruleActionsUnavailable?: boolean;
  /** Distinct models, in order of first use. */
  models?: string[];
}

export interface RunEventsResult {
  fleetId: string;
  run: RunHeader;
  events: RunEvent[];
  page: number;
  pages: number;
  total: number;
  eventFound: boolean | null;
}

/** engine audit_summary (Phase 1 spec H1). */
export interface AuditSummaryResult {
  fleetId: string;
  savingsBuckets: Array<{ day: string; agent: string; used: number; tasks: number; handovers: number; handoverSaved: number; offloadSaved: number; redoTokens?: number }>;
  /** The buckets' modelled savings, each agent's at its cache-aware input price (absent on older engines). */
  savings?: SavingsTotals;
  /** Each agent's smaller-context savings at its own price, lower-cased ids (engine E1b; absent on older engines). */
  savingsByAgent?: Record<string, { tokens: number; usdMicros: number | null }>;
  /** The same savings per local day, oldest first, adding up to `savings` (absent on older engines). */
  savingsByDay?: Array<{ day: string; tokens: number; usdMicros: number; unpricedTokens: number }>;
  /** The prompt caching WhiteRoom added, per local day, net of write premiums; with savingsByDay, each day's "Saved by WhiteRoom" (absent on older engines). */
  cacheByDay?: Array<{ day: string; usdMicros: number; unpricedReadTokens: number }>;
  governance: { blocks: number; wouldBlocks: number; byAgent: Record<string, { blocks: number; wouldBlocks: number }>; byRule: Record<string, { blocks: number; wouldBlocks: number }> };
}

/** engine rule_would_act. */
export interface RuleWouldActResult {
  fleetId: string; ruleId: string; byAgent: Record<string, number>; unversioned: boolean;
  /** When the counted version was saved; null when it's no longer current; absent from older engines (E3). */
  since?: string | null;
}

/** Settings › Audit trail (engine audit_integrity, Phase 1 spec H2). */
export interface AuditIntegrity {
  fleetId: string;
  mode: 'legacy' | 'sequenced';
  headSeq: number;
  verifiedThroughSeq: number;
  verifiedAt: string | null;
  prunedBeforeTracking: boolean;
  legacyEvents: number;
  gaps: { count: number; recent: Array<{ type: string; from: string | null; to: string | null }> };
  anchoring: { enabled: boolean };
}

/**
 * One page of the full signed export (engine export_audit_full). Events are
 * passed through to the file as they come; the last page has the signed
 * manifest (head seq and hash, count) and nextFromSeq null.
 */
export interface AuditExportPage {
  fleetId: string;
  firstSeq: number;
  toSeq: number;
  fromSeq: number;
  events: Array<Record<string, unknown> & { seq: number }>;
  nextFromSeq: number | null;
  manifest?: Record<string, unknown> & { firstSeq: number; headSeq: number; count: number; signature: string };
}

export interface VerifyAuditResult {
  valid: boolean | null;
  complete?: boolean;
  eventsVerified: number;
  firstBroken?: string | null;
  message: string;
  cached?: boolean;
}
