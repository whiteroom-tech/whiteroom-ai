import { requireSandboxMutation } from "@/lib/sandbox/auth";
import { resetRun, toResponse } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const user = await requireSandboxMutation();
  if ("error" in user) return user.error;

  const { sandboxId } = await params;
  const result = await resetRun(user.ownerSubject, sandboxId);
  return toResponse(result);
}
