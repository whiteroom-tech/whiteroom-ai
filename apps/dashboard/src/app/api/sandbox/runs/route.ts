import { requireSandboxUser } from "@/lib/sandbox/auth";
import { createRun, getStatus } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const body = await req.json();
  const result = await createRun(user.ownerSubject, {
    apiKey: body.apiKey,
    ttlMinutes: body.ttlMinutes,
    selectedCatalogIds: body.selectedCatalogIds,
    customControls: body.customControls,
    policyMode: body.policyMode,
    mode: body.mode,
  });
  return Response.json(result);
}

export async function GET() {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const result = await getStatus(user.ownerSubject);
  return Response.json(result);
}
