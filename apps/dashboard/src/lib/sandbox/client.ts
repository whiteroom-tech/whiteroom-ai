import "server-only";
import { PROXY_URL } from "@/lib/whiteroom/client";

export interface SandboxResponse<T = Record<string, unknown>> {
  data: T;
  status: number;
  retryAfter?: string;
}

function authHeaders(key?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (key) {
    if (key.startsWith("sk-")) h["x-api-key"] = key;
    else h["Authorization"] = `Bearer ${key}`;
  }
  return h;
}

async function proxyCall<T = Record<string, unknown>>(
  body: Record<string, unknown>,
  key?: string,
): Promise<SandboxResponse<T>> {
  const res = await fetch(`${PROXY_URL}/api/white-room`, {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) return { data: { error: "Test service unavailable. Check your connection and try again." } as T, status: 502 };

  const data = await res.json().catch(() => ({ error: "Test service unavailable. Try again." })) as T;
  return {
    data,
    status: res.status,
    retryAfter: res.headers.get("retry-after") ?? undefined,
  };
}

export function toResponse(result: SandboxResponse): Response {
  const headers: Record<string, string> = {};
  if (result.retryAfter) headers["Retry-After"] = result.retryAfter;
  return Response.json(result.data, { status: result.status, headers });
}

export function extractFleetToken(req: Request): string | undefined {
  return req.headers.get("x-fleet-token") ?? undefined;
}

export function createRun(
  ownerSubject: string,
  opts: {
    apiKey?: string;
    ttlMinutes?: number;
    selectedCatalogIds?: string[];
    customControls?: unknown[];
    policyMode?: "observe" | "enforce";
    mode?: "demo" | "connected";
  },
  key?: string,
) {
  return proxyCall({
    action: "create_sandbox",
    user_id: ownerSubject,
    is_trial: opts.mode === "demo",
    api_key: opts.apiKey,
    ttl_minutes: opts.ttlMinutes,
    selected_catalog_ids: opts.selectedCatalogIds,
    custom_controls: opts.customControls,
    policy_mode: opts.policyMode,
  }, key);
}

export function getStatus(ownerSubject: string, key?: string) {
  return proxyCall({ action: "sandbox_status", user_id: ownerSubject }, key);
}

export function startDemo(ownerSubject: string, sandboxId: string, key?: string) {
  return proxyCall({ action: "start_demo", sandbox_id: sandboxId }, key);
}

export function destroyRun(ownerSubject: string, sandboxId: string, key?: string) {
  return proxyCall({ action: "destroy_sandbox", sandbox_id: sandboxId }, key);
}

export function getReport(ownerSubject: string, sandboxId: string, key?: string) {
  return proxyCall({ action: "test_report", sandbox_id: sandboxId }, key);
}
