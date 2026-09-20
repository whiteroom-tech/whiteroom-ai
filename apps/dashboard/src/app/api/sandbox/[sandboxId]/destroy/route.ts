import { requireSandboxMutation } from "@/lib/sandbox/auth";
import { destroyRun, toResponse, extractFleetToken } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const user = await requireSandboxMutation();
  if ("error" in user) return user.error;

  const token = extractFleetToken(req);
  const { sandboxId } = await params;
  const result = await destroyRun(user.ownerSubject, sandboxId, token);
  return toResponse(result);
}
