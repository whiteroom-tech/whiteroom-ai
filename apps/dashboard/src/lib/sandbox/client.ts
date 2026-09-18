import { PROXY_URL } from "@/lib/whiteroom/client";

const ENGINE_BASE = PROXY_URL;

async function sandboxFetch<T>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  const secret = process.env.WR_SANDBOX_SERVICE_SECRET;
  if (!secret) {
    throw new Error("WR_SANDBOX_SERVICE_SECRET is not configured.");
  }

  const res = await fetch(`${ENGINE_BASE}/sandbox-internal/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-wr-sandbox-secret": secret,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Engine sandbox-internal/${endpoint} returned ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
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

export function getHistory(ownerSubject: string) {
  return sandboxFetch("history", { ownerSubject });
}

export function startDemo(ownerSubject: string, sandboxId: string) {
  return sandboxFetch("demo", { ownerSubject, sandboxId });
}

export function destroyRun(ownerSubject: string, sandboxId: string) {
  return sandboxFetch("destroy", { ownerSubject, sandboxId });
}

export function resetRun(ownerSubject: string, sandboxId: string) {
  return sandboxFetch("reset", { ownerSubject, sandboxId });
}

export function getReport(ownerSubject: string, sandboxId: string) {
  return sandboxFetch("report", { ownerSubject, sandboxId });
}

export function getAnalytics(ownerSubject: string) {
  return sandboxFetch("analytics", { ownerSubject });
}
