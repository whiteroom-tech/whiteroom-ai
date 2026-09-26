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

// Only the short-lived sandbox token is ever read from storage. A production
// fleet token belongs in the httpOnly cookie, which the BFF falls back to when
// no header is sent.
function sandboxToken(): string | null {
  try { return localStorage.getItem('wr_sandbox_token'); }
  catch { return null; }
}

/**
 * Removes the stored sandbox token. A leftover one would keep shadowing fleet
 * auth in bffFetch long after the run is gone — or after the account that
 * created it has signed out — so clear it whenever either ends.
 */
export function clearSandboxToken(): void {
  try {
    localStorage.removeItem('wr_sandbox_token');
    window.dispatchEvent(new Event('storage'));
  } catch { /* localStorage unavailable */ }
}

/**
 * The engine records a demo as a trial sandbox; status responses carry that
 * as isTrial. Falls back to the mode the run was created with for an engine
 * that doesn't report it yet, so a demo is never relabelled as a live test.
 */
export function withRunMode<T extends { mode?: "demo" | "connected"; isTrial?: boolean }>(
  st: T,
  previous?: "demo" | "connected",
): T & { mode?: "demo" | "connected" } {
  if (st.mode) return st;
  if (typeof st.isTrial === "boolean") return { ...st, mode: st.isTrial ? "demo" : "connected" };
  return previous ? { ...st, mode: previous } : st;
}

async function bffFetch<T>(path: string, opts?: RequestInit, explicitToken?: string): Promise<T> {
  const token = explicitToken || sandboxToken();
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
}, fleetToken?: string): Promise<{ success?: boolean; sandboxId?: string; fleetToken?: string; expiresAt?: string; mode?: "demo" | "connected"; controls?: ControlDefinition[]; error?: string }> {
  // A pasted fleet token authenticates this one request and is never stored.
  return bffFetch("runs", {
    method: "POST",
    body: JSON.stringify(opts),
  }, fleetToken);
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
