import { requireSandboxUser } from "@/lib/sandbox/auth";
import { getStatus, toResponse, extractFleetToken } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const token = await extractFleetToken(req);
  const result = await getStatus(user.ownerSubject, token);
  return toResponse(result);
}
