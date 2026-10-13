import { safeGet, safeRemove, safeSessionGet, safeSessionRemove, safeSessionSet, safeSet } from '@/lib/safe-storage';
import type { CloudProvider } from '@/lib/sandbox/providers';
import type {
  ControlDefinition,
  CustomControlInput,
  ReadinessResult,
} from "@/lib/whiteroom/types";

/**
 * Calls that reached WhiteRoom but failed at the provider. Left out when there
 * are none (and by engines that don't report it); a later success doesn't clear it.
 */
export interface FailedCalls {
  count: number;
  last: {
    at: string;
    agentId: string;
    status: number;
    reason: 'upstream_error' | 'upstream_unreachable';
    /** The provider's error text (already scrubbed, at most 200 chars) or a generic line. */
    message: string;
  };
}

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
  /** The provider named when the test started; null when none was (Anthropic or OpenAI by key). */
  provider?: string | null;
  /** Hostname only, for Azure OpenAI, Foundry and Bedrock tests. */
  endpointHost?: string | null;
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
  failedCalls?: FailedCalls;
  /** The engine keeps an ended test's report for Past tests (sandbox_report). Left out by engines that don't. */
  reportsKept?: boolean;
  error?: string;
}

export interface DemoStep {
  step: number;
  action: string;
  detail: string;
  assertion?: string;
  timestamp: string;
}

// Only the short-lived sandbox token is ever read from storage. A production
// fleet token belongs in the httpOnly cookie, which the BFF falls back to when
// no header is sent.
function sandboxToken(): string | null {
  return safeGet('wr_sandbox_token');
}

/**
 * Removes the stored sandbox token. A leftover one would keep shadowing fleet
 * auth in bffFetch long after the run is gone — or after the account that
 * created it has signed out — so clear it whenever either ends.
 */
export function clearSandboxToken(): void {
  safeRemove('wr_sandbox_token');
  safeSessionRemove(PROXY_KEY_STORAGE);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('storage'));
}

// A cloud test's proxy key is returned once, when the test starts. It is kept
// in this tab's sessionStorage, for the same test only, so a reload still
// shows the agent's address; it goes when the sandbox token does. Another tab
// gets its own with "Get a new proxy URL".
const PROXY_KEY_STORAGE = 'wr_sandbox_proxy_key';

// Not a secret: which test's proxy key was last replaced, and when. Written to
// localStorage so other tabs hear it (a storage event) and drop their old key.
export const PROXY_KEY_ROTATED = 'wr_sandbox_proxy_key_rotated';

export function saveProxyKey(sandboxId: string, proxyKey: string): void {
  safeSessionSet(PROXY_KEY_STORAGE, JSON.stringify({ sandboxId, proxyKey }));
}

/** After a rotate: tell other tabs their copy of this test's key is dead. */
export function announceProxyKeyRotation(sandboxId: string): void {
  safeSet(PROXY_KEY_ROTATED, `${sandboxId}:${Date.now()}`);
}

/** Drops this tab's key, e.g. because another tab replaced it. */
export function forgetProxyKey(): void {
  safeSessionRemove(PROXY_KEY_STORAGE);
}

export type ShownProxyKey = { sandboxId: string; proxyKey: string } | null;

/**
 * The proxy key a tab shows after a storage event: dropped (a new null value,
 * so the page re-renders) when another tab rotated this test's key, otherwise
 * unchanged.
 */
export function proxyKeyAfterStorageEvent(current: ShownProxyKey, key: string | null, newValue: string | null): ShownProxyKey {
  return key === PROXY_KEY_ROTATED && current && rotatedFor(newValue, current.sandboxId) ? null : current;
}

/** True when a PROXY_KEY_ROTATED value is about this test. */
export function rotatedFor(value: string | null, sandboxId: string | undefined): boolean {
  return !!sandboxId && !!value && value.startsWith(`${sandboxId}:`);
}

/** The stored proxy key, only if it belongs to this test. */
export function loadProxyKey(sandboxId: string | undefined): string | null {
  if (!sandboxId) return null;
  try {
    const v = JSON.parse(safeSessionGet(PROXY_KEY_STORAGE) ?? 'null') as { sandboxId?: unknown; proxyKey?: unknown } | null;
    return v && v.sandboxId === sandboxId && typeof v.proxyKey === 'string' && v.proxyKey.startsWith('sk-wr-') ? v.proxyKey : null;
  } catch {
    return null;
  }
}

/** A BFF refusal, with the machine-readable code when the route sends one. */
export class SandboxRequestError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
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
  if (!res.ok) throw new SandboxRequestError(
    typeof data.error === "string" ? data.error : "Test service unavailable. Try again.",
    typeof data.code === "string" ? data.code : undefined,
  );
  return data as T;
}

export function createRun(opts: {
  apiKey?: string;
  mode: "demo" | "connected";
  ttlMinutes?: number;
  selectedCatalogIds?: string[];
  customControls?: CustomControlInput[];
  policyMode?: "observe" | "enforce";
  provider?: CloudProvider;
  endpoint?: string;
}, fleetToken?: string): Promise<{ success?: boolean; sandboxId?: string; fleetToken?: string; expiresAt?: string; mode?: "demo" | "connected"; controls?: ControlDefinition[]; provider?: string; proxyKey?: string; error?: string }> {
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

export function newProxyKey(sandboxId: string): Promise<{ success?: boolean; proxyKey?: string; error?: string }> {
  return bffFetch(`${sandboxId}/proxy-key`, { method: "POST" });
}

/** One finished test, as the engine records it. */
export interface PastTest {
  sandboxId: string;
  destroyedAt: string;
  /** "empty": no check got evidence, so nothing was tested (no call came back OK). */
  overall: "pass" | "fail" | "partial" | "empty";
  totalTasks: number;
  isTrial: boolean;
  /** The engine kept this test's report (Download report). Left out by engines that keep none. */
  hasReport?: boolean;
}

/** A finished test's report as the engine kept it: its status as it ended. */
export interface PastReport {
  success?: boolean;
  sandboxId?: string;
  destroyedAt?: string;
  report?: RunStatusResult & { createdAt?: string; endedAt?: string };
  error?: string;
}

export function getPastReport(sandboxId: string): Promise<PastReport> {
  return bffFetch(`${encodeURIComponent(sandboxId)}/report`);
}

export function getHistory(): Promise<{ success?: boolean; sessions?: PastTest[]; error?: string }> {
  return bffFetch("history");
}
