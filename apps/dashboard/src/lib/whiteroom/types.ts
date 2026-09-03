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
  energySavings: { estimatedTokensSaved: number; estimatedCostSaved: string; estimatedEnergySaved: string; formula: string };
  compliance: { allAgentsWithinLimits: boolean; restingAgentsCount: number; laborScore: string };
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

export interface RebindResult {
  success: boolean;
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
