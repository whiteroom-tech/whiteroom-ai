import { requireSandboxUser, requireSandboxMutation } from "@/lib/sandbox/auth";
import { createRun, getStatus, toResponse, extractFleetToken } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireSandboxMutation();
  if ("error" in user) return user.error;

  const token = extractFleetToken(req);
  const body = await req.json();
  const result = await createRun(user.ownerSubject, {
    apiKey: body.apiKey,
    ttlMinutes: body.ttlMinutes,
    selectedCatalogIds: body.selectedCatalogIds,
    customControls: body.customControls,
    policyMode: body.policyMode,
    mode: body.mode,
  }, token);
  return toResponse(result);
}

export async function GET(req: Request) {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const token = extractFleetToken(req);
  const result = await getStatus(user.ownerSubject, token);
  return toResponse(result);
}
