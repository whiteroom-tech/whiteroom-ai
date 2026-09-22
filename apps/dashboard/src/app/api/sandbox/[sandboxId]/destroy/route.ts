import { requireSandboxMutation } from "@/lib/sandbox/auth";
import { destroyRun, toResponse, extractFleetToken } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SANDBOX_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const user = await requireSandboxMutation();
  if ("error" in user) return user.error;

  const { sandboxId } = await params;
  if (!SANDBOX_ID_RE.test(sandboxId)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const token = extractFleetToken(req);
  const result = await destroyRun(user.ownerSubject, sandboxId, token);
  return toResponse(result);
}
