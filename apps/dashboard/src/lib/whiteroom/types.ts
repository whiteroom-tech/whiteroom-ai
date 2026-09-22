// Shared WhiteRoom API shapes for the dashboard.
// These mirror the proxy's /api/white-room responses. Kept local to the
// dashboard (not imported from @whiteroom-ai/sdk) so the app stays a
// standalone build with no cross-package linking.

export interface ToolDetail {
  name: string;
  args: string;
}

export interface AgentInfo {
  agentId: string;
  status: string;
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
  totals: { workMinutes: number; tokens: number; tasks: number; handovers: number };
  currentWatch?: { tasks: number; tokens: number; workMinutes: number };
  energySavings: { compressionRatio?: number; estimatedTokensSaved: number; estimatedCostSaved: string; estimatedEnergySaved: string; formula: string };
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
  [key: string]: unknown;
}

export interface AuditLogResponse {
  fleetId: string;
  total: number;
  limit: number;
  filters: { agentIds: string[]; types: string[] };
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
  handoverDoc?: HandoverDoc;
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
    avgLatencyMs: number | null;
    errorRate: number;
    models: PerformanceModelSummary[];
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

export interface PerformanceHealthResult {
  collection: boolean;
  queue: { pending: number; totalEnqueued: number; totalFlushed: number; dropped: number; uncertainIntervals: unknown[] };
  version: string;
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
  remainingTasks: number | null;
  error?: string;
}

export interface GetBudgetResult {
  fleetId: string;
  budgetUsd: number | null;
  error?: string;
}

export interface SetBudgetResult {
  success: boolean;
  fleetId: string;
  budgetUsd: number | null;
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

export interface ReadinessAssessment {
  liveReady: boolean;
  demoComplete: boolean;
  overall: ReadinessResult;
}

export interface CatalogEntry {
  controlId: string;
  name: string;
  description: string;
  source: "core" | "catalog";
  evaluator: EvaluatorType;
  tier: "core" | "governance" | "policy";
  defaultRequired: boolean;
  rules: ExecutableRule[];
  testMethod: string;
}

export interface CustomControlInput {
  name: string;
  description: string;
  rules: Array<ExecutableRule | ProposedRule>;
  requiredByUser?: boolean;
  testMethod: string;
}
