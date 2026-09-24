import { requireSandboxMutation, SANDBOX_ID_RE } from "@/lib/sandbox/auth";
import { destroyRun, toResponse, extractFleetToken } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const token = await extractFleetToken(req);
  const result = await destroyRun(user.ownerSubject, sandboxId, token);
  return toResponse(result);
}
