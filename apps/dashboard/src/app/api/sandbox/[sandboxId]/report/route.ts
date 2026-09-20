import { requireSandboxUser } from "@/lib/sandbox/auth";
import { getReport, toResponse, extractFleetToken } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const token = extractFleetToken(req);
  const { sandboxId } = await params;
  const result = await getReport(user.ownerSubject, sandboxId, token);
  return toResponse(result);
}
