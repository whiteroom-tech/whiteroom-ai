import "server-only";
import { PROXY_URL } from "@/lib/whiteroom/client";

const ENGINE_BASE = PROXY_URL;

export interface SandboxResponse<T = Record<string, unknown>> {
  data: T;
  status: number;
  retryAfter?: string;
}

async function sandboxFetch<T = Record<string, unknown>>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<SandboxResponse<T>> {
  const secret = process.env.WR_SANDBOX_SERVICE_SECRET;
  if (!secret) {
    return { data: { error: "Test service is not configured. Contact your workspace administrator." } as T, status: 503 };
  }

  const res = await fetch(`${ENGINE_BASE}/sandbox-internal/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-wr-sandbox-secret": secret,
    },
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
) {
  return sandboxFetch("runs", { ownerSubject, ...opts });
}

export function getStatus(ownerSubject: string) {
  return sandboxFetch("status", { ownerSubject });
}

export function startDemo(ownerSubject: string, sandboxId: string) {
  return sandboxFetch("demo", { ownerSubject, sandboxId });
}

export function destroyRun(ownerSubject: string, sandboxId: string) {
  return sandboxFetch("destroy", { ownerSubject, sandboxId });
}

export function getReport(ownerSubject: string, sandboxId: string) {
  return sandboxFetch("report", { ownerSubject, sandboxId });
}

