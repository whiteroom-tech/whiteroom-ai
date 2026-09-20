import type {
  ControlDefinition,
  CustomControlInput,
  ReadinessResult,
} from "@/lib/whiteroom/types";

export interface RunStatusResult {
  success?: boolean;
  sandboxId?: string;
  mode?: "demo" | "connected";
  isTrial?: boolean;
  environment?: string;
  verifiedConnectionAt?: string;
  retryAfter?: number;
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
  agents?: {
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
  }[];
  auditLog?: {
    id: string;
    timestamp: string;
    type: string;
    agentId: string | null;
    [key: string]: unknown;
  }[];
  error?: string;
}

export interface DemoStep {
  step: number;
  action: string;
  detail: string;
  assertion?: string;
  timestamp: string;
}

export interface ReportResult {
  success?: boolean;
  sandboxId?: string;
  overall?: string;
  controls?: ControlDefinition[];
  mode?: "demo" | "connected";
  isTrial?: boolean;
  totalTokens?: number | null;
  totalTasks?: number;
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

function fleetToken(): string | null {
  try { return localStorage.getItem('wr_fleet_token') || localStorage.getItem('wr_token'); }
  catch { return null; }
}

async function bffFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = fleetToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["x-fleet-token"] = token;
  const res = await fetch(`/api/sandbox/${path}`, {
    cache: "no-store",
    headers,
    ...opts,
  });
  const data = await res.json().catch(() => ({ error: "Test service unavailable. Try again." }));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Test service unavailable. Try again.");
  return data as T;
}

export function createRun(opts: {
  apiKey?: string;
  mode: "demo" | "connected";
  ttlMinutes?: number;
  selectedCatalogIds?: string[];
  customControls?: CustomControlInput[];
  policyMode?: "observe" | "enforce";
}): Promise<{ success?: boolean; sandboxId?: string; fleetToken?: string; expiresAt?: string; mode?: "demo" | "connected"; controls?: ControlDefinition[]; error?: string }> {
  return bffFetch("runs", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function getStatus(): Promise<RunStatusResult> {
  return bffFetch<RunStatusResult>("status");
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

export function getReport(sandboxId: string): Promise<ReportResult> {
  return bffFetch(`${sandboxId}/report`);
}
