import { requireSandboxUser, requireSandboxMutation } from "@/lib/sandbox/auth";
import { createRun, getStatus, toResponse, extractFleetToken } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 65_536;

export async function POST(req: Request) {
  const user = await requireSandboxMutation();
  if ("error" in user) return user.error;

  const cl = req.headers.get("content-length");
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: "Request too large." }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== "string" || body.apiKey.length > 256 || !body.apiKey.startsWith("sk-")) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  if (body.ttlMinutes !== undefined) {
    if (typeof body.ttlMinutes !== "number" || !Number.isInteger(body.ttlMinutes) || body.ttlMinutes < 1 || body.ttlMinutes > 1440) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  if (body.selectedCatalogIds !== undefined) {
    if (!Array.isArray(body.selectedCatalogIds) || body.selectedCatalogIds.length > 50 ||
        body.selectedCatalogIds.some((id: unknown) => typeof id !== "string" || (id as string).length > 128)) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  if (body.customControls !== undefined) {
    if (!Array.isArray(body.customControls) || body.customControls.length > 100) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  if (body.policyMode !== undefined) {
    if (body.policyMode !== "observe" && body.policyMode !== "enforce") {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  if (body.mode !== undefined) {
    if (body.mode !== "demo" && body.mode !== "connected") {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
  }

  const token = await extractFleetToken(req);
  const result = await createRun(user.ownerSubject, {
    apiKey: body.apiKey as string | undefined,
    ttlMinutes: body.ttlMinutes as number | undefined,
    selectedCatalogIds: body.selectedCatalogIds as string[] | undefined,
    customControls: body.customControls as unknown[] | undefined,
    policyMode: body.policyMode as "observe" | "enforce" | undefined,
    mode: body.mode as "demo" | "connected" | undefined,
  }, token);
  return toResponse(result);
}

export async function GET(req: Request) {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const token = await extractFleetToken(req);
  const result = await getStatus(user.ownerSubject, token);
  return toResponse(result);
}
