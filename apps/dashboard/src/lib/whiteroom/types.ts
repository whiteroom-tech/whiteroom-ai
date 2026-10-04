// Shared WhiteRoom API shapes for the dashboard.
// These mirror the proxy's /api/white-room responses. Kept local to the
// dashboard (not imported from @whiteroom-ai/sdk) so the app stays a
// standalone build with no cross-package linking.

export interface ToolDetail {
  name: string;
  args: string;
}

/** A durable pause or stop (engine gov-state.ts): the agent refuses calls until resumed. */
export interface AgentHold { state: 'paused' | 'stopped'; by: string; reason: string | null; at: string }

export interface AgentInfo {
  agentId: string;
  status: string;
  /** Set while held (P2.2). Wins over the status. */
  hold?: AgentHold | null;
  /** Whether this fleet has Pause/Stop as holds (Gov v1). The engine's check_watch returns it with `hold` (engine #90). */
  govV1?: boolean;
  taskType?: string | null;
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
}

export interface HandoverDoc {
  state?: string;
  pending?: Array<{ task: string }>;
  warnings?: string[];
  session_stats?: { tasks_completed: number; total_tokens: number };
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
    pricing?: 'cache_aware_input';
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
 * The Performance tab's live feed (performance_live_feed action): full,
 * un-redacted detail (real reply text, real tool-call argument values), kept
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

export interface GetHandoverResult {
  /** Pending, single-use: the agent gets it on its next call, then it's cleared. */
  handoverDoc?: HandoverDoc;
  /** The last doc already delivered, kept for people to read (engine #94). */
  lastHandoverDoc?: HandoverDoc | null;
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
  error?: string;
}

export interface DeleteKeyResult {
  success?: boolean;
  removed?: { provider: string; keyHint: string };
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
    models: PerformanceModelSummary[];
    /** Prompt caching over the window, priced per model (absent on older engines). */
    cache?: CacheSummary;
  };
  recommendations: PerformanceRecommendation[];
  priceInfo: { version: string; ageDays: number; stale: boolean; expired: boolean };
  error?: string;
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

export interface AgentPerformanceResult {
  fleetId: string;
  agentId: string;
  period: { start: string; end: string };
  hourly: HourlyDataPoint[];
  totals: {
    calls: number;
    costMicros: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    errorRate: number;
    /** Calls stopped by a governance rule in Enforce (absent on older engines). */
    blockedCount?: number;
    avgLatencyMs: number | null;
  };
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
  /** Attempts with no catalogue price in this hour (absent on older engines). */
  unpricedAttempts?: number;
}

export interface FleetHourlyResult {
  fleetId: string;
  period: { start: string; end: string };
  hourly: FleetHourlyDataPoint[];
  error?: string;
}

export interface PerformanceCostForecastResult {
  fleetId: string;
  budgetUsd: number | null;
  spendToDateUsd: number;
  burnRateUsdPerHour: number;
  // Dollar-based normally; token-based (against tokenBudget) when
  // costUnavailable — same field either way, since the card only shows one.
  remainingTasks: number | null;
  // true when recent activity used a model with no price-catalog entry —
  // burnRateUsdPerHour is $0 because it's unpriced, not because it's free.
  // tokensPerHour/tokenBudget are the fallback signals in that case.
  costUnavailable: boolean;
  tokensPerHour: number | null;
  tokenBudget: number | null;
  /** Why remainingTasks is null, so the card asks for the right thing (absent on older engines). */
  remainingTasksReason?: 'budget_missing' | 'task_type_missing' | 'partial_coverage' | 'available';
  /** The budget is daily: spend counts from local midnight in budgetTimeZone. */
  budgetPeriod?: 'day';
  budgetTimeZone?: string;
  spentTodayUsd?: number;
  /** burnRateUsdPerHour averages the hours with calls in this lookback. */
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
  /** reads × (input rate − cache-read rate), per model. */
  readSavedMicros: number;
  /** writes × (cache-write rate − input rate), per model. */
  writePremiumMicros: number;
  unpricedReadTokens: number;
}

export interface SetBudgetResult {
  success: boolean;
  fleetId: string;
  budgetUsd: number | null;
  error?: string;
}

export interface SetTokenBudgetResult {
  success: boolean;
  fleetId: string;
  tokenBudget: number | null;
  error?: string;
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

export type GovernanceRuleType = 'spend_cap' | 'loop_breaker' | 'model_allowlist' | 'tool_list' | 'call_rate';
export type GovernanceMode = 'off' | 'watch' | 'enforce';
/** What Enforce does (engine P2.3): notify, block, pause or stop. */
export type GovernanceResponse = 'notify' | 'block' | 'pause' | 'stop';
export type GovernanceReason = 'budget_exceeded' | 'loop_detected' | 'model_not_allowed' | 'tool_not_allowed' | 'rate_exceeded';
export type GovernanceScope = 'all' | string[];

export interface SpendCapParams { dailyCap: number; scope: 'run' | 'day'; unit: 'tokens' | 'dollars' }
export interface LoopBreakerParams { threshold: number; scope: 'run' | 'day'; ignoreTools: string[] }
export interface ModelAllowlistParams { allowedModels: string[] }
/** Tools an agent may not run; judged on the model's reply before the agent gets it. */
export interface ToolListParams { blockedTools: string[] }
/** More than maxCalls model calls in any 60 seconds. */
export interface CallRateParams { maxCalls: number }
export type GovernanceParams = SpendCapParams | LoopBreakerParams | ModelAllowlistParams | ToolListParams | CallRateParams;

export interface GovernanceRule {
  id: string;
  fleetId: string;
  ruleType: GovernanceRuleType;
  params: GovernanceParams;
  mode: GovernanceMode;
  /** Absent from older engines, where Enforce always blocks. */
  response?: GovernanceResponse;
  appliesTo: GovernanceScope;
  version: number;
  changedBy: string;
  changedAt: string;
  /** Set when the rule came from a Diagnosis suggestion. */
  sourceRecommendationId?: string;
}

export interface GovernanceHistoryEntry {
  id: string;
  ruleId: string;
  ruleType: GovernanceRuleType;
  description: string;
  by: string;
  time: string;
}

export interface GovernanceListResult {
  fleetId: string;
  rules: GovernanceRule[];
  history: GovernanceHistoryEntry[];
  agents: string[];
  /** Pause and Stop responses are offered (Gov v1 fleets). */
  govV1?: boolean;
}

/** Rule actions in words (engine rule_actions). */
export interface RuleActionCounts { blocked: number; paused: number; stopped: number; toldYou: number; wouldAct: number }
export interface RuleActionsResult { fleetId: string; totals: RuleActionCounts; byAgent: Record<string, RuleActionCounts>; /** Per rule type, from the same rows as totals (newer engines). */ byRule?: Record<string, RuleActionCounts> }
export interface RunRuleAction { at: string; ruleId: string; ruleType: GovernanceRuleType; response: GovernanceResponse; mode: GovernanceMode; occurrences: number }

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
}

/** A run flag: flags only, nothing was blocked. */
export type RunFlag =
  | { signal: 'repeating_call'; tool: string; calls: number }
  | { signal: 'error_streak'; calls: number };

export interface RunDaysResult {
  fleetId: string;
  /** Oldest first; days with no runs are left out. */
  days: { day: string; runs: number }[];
}

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
  tools?: string[];
  durationMs?: number | null;
  detail?: Record<string, unknown>;
}

export interface RunEventsResult {
  fleetId: string;
  run: { runId: string; agentId: string; shift: number; startedAt: string; endedAt: string; flags?: RunFlag[]; ruleActions?: RunRuleAction[] };
  events: RunEvent[];
  page: number;
  pages: number;
  total: number;
  eventFound: boolean | null;
}

/** engine audit_summary (Phase 1 spec H1). */
export interface AuditSummaryResult {
  fleetId: string;
  savingsBuckets: Array<{ day: string; agent: string; used: number; tasks: number; handovers: number; handoverSaved: number; offloadSaved: number }>;
  /** The buckets' modelled savings, each agent's at its cache-aware input price (absent on older engines). */
  savings?: SavingsTotals;
  governance: { blocks: number; wouldBlocks: number; byAgent: Record<string, { blocks: number; wouldBlocks: number }>; byRule: Record<string, { blocks: number; wouldBlocks: number }> };
}

/** engine rule_would_act. */
export interface RuleWouldActResult { fleetId: string; ruleId: string; byAgent: Record<string, number>; unversioned: boolean }

/** Settings › Audit integrity (engine audit_integrity, Phase 1 spec H2). */
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

export interface VerifyAuditResult {
  valid: boolean | null;
  complete?: boolean;
  eventsVerified: number;
  firstBroken?: string | null;
  message: string;
  cached?: boolean;
}
