import { requireSandboxUser } from "@/lib/sandbox/auth";
import { getStatus, toResponse } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const result = await getStatus(user.ownerSubject);
  return toResponse(result);
}
