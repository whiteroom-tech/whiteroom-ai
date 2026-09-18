import type {
  CatalogEntry,
  ControlDefinition,
  CustomControlInput,
  ReadinessAssessment,
  ReadinessResult,
} from "@/lib/whiteroom/types";

export interface CreateRunResult {
  success?: boolean;
  sandboxId?: string;
  fleetToken?: string;
  expiresAt?: string;
  isTrial?: boolean;
  experience?: "legacy" | "new";
  controls?: ControlDefinition[];
  error?: string;
}

export interface RunStatusResult {
  success?: boolean;
  sandboxId?: string;
  environment?: string;
  experience?: "legacy" | "new";
  expiresAt?: string;
  expiresInSeconds?: number | null;
  assertionStates?: Record<
    string,
    {
      status: string;
      observedAt?: string;
      failedAt?: string;
      diagnostic?: string;
      metric?: number;
    }
  >;
  controls?: ControlDefinition[];
  policyMode?: "observe" | "enforce";
  policyVersion?: number;
  liveReady?: boolean;
  demoComplete?: boolean;
  overallControlResult?: ReadinessResult;
  agents?: AgentInfo[];
  auditLog?: AuditEntry[];
  error?: string;
}

export interface AgentInfo {
  agentId: string;
  role: string;
  status: string;
  watchMinutes: number;
  watchCount: number;
  totalTasks: number;
  totalTokens: number;
  pairedWith: string | null;
  currentWatch: {
    watchNumber: number;
    minutesWorked: number;
    tokensUsed: number;
    tasksCompleted: number;
  } | null;
}

export interface AuditEntry {
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

export interface DemoStep {
  step: number;
  action: string;
  detail: string;
  assertion?: string;
  timestamp: string;
}

export interface HistoryEntry {
  sandboxId: string;
  userId: string;
  createdAt: string;
  destroyedAt: string;
  overall: "pass" | "fail" | "in_progress";
  totalTasks: number;
  isTrial: boolean;
}

export interface ReportResult {
  success?: boolean;
  sandboxId?: string;
  overall?: string;
  assertions?: Record<
    string,
    {
      status: string;
      observedAt?: string;
      failedAt?: string;
      diagnostic?: string;
      metric?: number;
    }
  >;
  error?: string;
}

async function bffFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/sandbox/${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json() as Promise<T>;
}

export function createRun(opts: {
  apiKey?: string;
  isTrial?: boolean;
  ttlMinutes?: number;
  selectedCatalogIds?: string[];
  customControls?: CustomControlInput[];
  policyMode?: "observe" | "enforce";
}): Promise<CreateRunResult> {
  return bffFetch<CreateRunResult>("runs", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function getStatus(): Promise<RunStatusResult> {
  return bffFetch<RunStatusResult>("status");
}

export function getHistory(): Promise<{
  success?: boolean;
  sessions?: HistoryEntry[];
  error?: string;
}> {
  return bffFetch("history");
}

export function startDemo(sandboxId: string): Promise<{
  success?: boolean;
  message?: string;
  steps?: DemoStep[];
  error?: string;
}> {
  return bffFetch(`${sandboxId}/demo`, { method: "POST" });
}

export function destroyRun(sandboxId: string): Promise<{
  success?: boolean;
  error?: string;
}> {
  return bffFetch(`${sandboxId}/destroy`, { method: "POST" });
}

export function resetRun(sandboxId: string): Promise<{
  success?: boolean;
  error?: string;
}> {
  return bffFetch(`${sandboxId}/reset`, { method: "POST" });
}

export function getReport(sandboxId: string): Promise<ReportResult> {
  return bffFetch(`${sandboxId}/report`);
}

export function getAnalytics(): Promise<{
  success?: boolean;
  totalSessions?: number;
  passed?: number;
  failed?: number;
  passRate?: number;
  error?: string;
}> {
  return bffFetch("analytics");
}
