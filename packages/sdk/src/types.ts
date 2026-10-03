export type AgentStatus = "idle" | "working" | "handover_out" | "handover_in" | "resting";

export interface Agent {
  agentId: string;
  role: string;
  status: AgentStatus;
  watchMinutes: number;
  restMinutes: number;
  handoverMinutes: number;
  watchCount: number;
  totalWorkMinutes: number;
  totalTokens: number;
  totalTasks: number;
  pairedWith: string | null;
  alarmAt: string | null;
}

export interface ToolDetail {
  name: string;
  args: string;
}

export interface Task {
  taskId: string;
  taskName: string;
  minutesSpent: number;
  tokensUsed: number;
  details: ToolDetail[];
  completedAt: string;
}

export interface WatchProgress {
  minutesWorked: number;
  minutesRemaining: number;
  percentComplete: string;
}

export interface HandoverDoc {
  decisions?: Array<{ what: string; why: string; final: boolean }>;
  state?: string;
  pending?: Array<{ task: string; priority: "HIGH" | "NORMAL" | "LOW" }>;
  warnings?: string[];
  exact_data?: {
    numbers?: string[];
    urls?: string[];
    names?: string[];
    ids?: string[];
  };
  generated_at?: string;
  watch_summary?: {
    tasks_completed: number;
    tokens_used: number;
    duration_minutes: number;
  };
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

export interface FleetReport {
  fleetId: string;
  agentCount: number;
  status: {
    working: string[];
    resting: string[];
    idle: string[];
  };
  totals: {
    workMinutes: number;
    tokens: number;
    tasks: number;
    handovers: number;
  };
  energySavings: {
    estimatedTokensSaved: number;
    estimatedCostSaved: string;
    estimatedEnergySaved: string;
    formula: string;
  };
  compliance: {
    allAgentsWithinLimits: boolean;
    restingAgentsCount: number;
    laborScore: string;
  };
  recentAudit: AuditEvent[];
}

export interface Handover {
  handoverId: string;
  from: string;
  to: string;
  timestamp: string;
  durationMinutes: number;
  outgoingWatch: {
    watchNumber: number;
    minutesWorked: number;
    tokensUsed: number;
    tasksCompleted: string[];
  };
  contextSummary: string;
  pendingTasks: string[];
  warnings: string[];
  keyFindings: string[];
}

// -- Response types --

export interface RegisterAgentResponse {
  success: true;
  agent: Agent;
  fleetToken: string;
  message: string;
}

export interface PairAgentsResponse {
  success: true;
  pair: { agentA: string; agentB: string };
}

export interface AutoPairResponse {
  success: true;
  pairs: Array<{ agentA: string; agentB: string }>;
  solo: string | null;
}

export interface StartWatchResponse {
  success: true;
  agentId: string;
  watchNumber: number;
  watchLimit: number;
  message: string;
}

export interface CompleteTaskResponse {
  success: true;
  eventId?: string;
  agentId?: string;
  watchNumber?: number;
  taskCount?: number;
  tokensUsed?: number;
  status?: AgentStatus;
  task: Task;
  watchProgress: WatchProgress;
  alert?: "WATCH_LIMIT_REACHED";
  reliefAgent?: string;
  action?: string;
  message?: string;
}

export interface CompleteTaskOptions {
  fleetId?: string;
  minutesSpent?: number;
  tokensUsed?: number;
}

/** A repeat of a completeTask call with the same idempotencyKey and input: nothing was applied again. */
export interface CompleteTaskReplay {
  success: true;
  replayed: true;
  content_unavailable: true;
  eventId: string;
  agentId: string;
  watchNumber: number;
  taskCount: number;
  tokensUsed: number;
  status: AgentStatus;
}

export interface CheckWatchResponse {
  agentId: string;
  status: AgentStatus;
  watchNumber?: number;
  minutesWorked?: number;
  minutesRemaining?: number;
  percentComplete?: string;
  tasksCompleted?: number;
  tokensUsed?: number;
  needsHandover?: boolean;
  restRemaining?: string;
  alarmAt?: string;
  message?: string;
}

export interface InitiateHandoverResponse {
  success: true;
  handover: Handover;
  outgoingAgent: { agentId: string; status: "resting"; alarmAt: string; message: string };
  incomingAgent: { agentId: string; status: "working"; watchNumber: number; message: string };
  energySavings: { contextCleared: string; freshContext: string; reduction: string; note: string };
}

export interface GenerateHandoverResponse {
  taskHistory: Task[];
  existingDoc: HandoverDoc | null;
  agentId: string;
  fleetId: string;
  message: string;
}

export interface StoreHandoverResponse {
  success: true;
  message: string;
}

export interface GetHandoverResponse {
  agentId: string;
  fleetId: string;
  handoverDoc: HandoverDoc | null;
}

export interface FireAlarmResponse {
  success: true;
  agentId: string;
  status: "idle";
  message: string;
  totalWatches: number;
  totalWorkMinutes: number;
  totalTokens: number;
}

export interface TokenLoginResponse {
  success: true;
  fleetId: string;
  report: FleetReport;
}

export interface ListFleetsResponse {
  fleets: Array<{ fleetId: string; agentCount: number; agents: string[] }>;
}

export interface GovernanceBlock {
  type: "error";
  error: { type: "rate_limit_error"; message: string };
  whiteroom: {
    reason: "resting" | "handover_in_progress" | "watch_limit_exceeded" | "waiting_for_partner";
    agentId: string;
    message: string;
    restRemaining?: string;
    alarmAt?: string;
    waitingOn?: string;
    handoverGenerated?: boolean;
    status?: string;
    pairedWith?: string;
    retrieveWith?: { action: string; fleet_id: string; agent_id: string };
  };
}

export interface AuditLogResponse {
  fleetId: string;
  total: number;
  limit: number;
  filters: { agentIds: string[]; types: string[] };
  entries: AuditEvent[];
}

export interface ApiError {
  error: string;
  details?: string;
}
