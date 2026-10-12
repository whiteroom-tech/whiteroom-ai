import { requireSandboxMutation, SANDBOX_ID_RE } from "@/lib/sandbox/auth";
import { rotateProxyKey, toResponse, extractFleetToken } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a new proxy key for a cloud test (Azure OpenAI, Foundry, Bedrock),
 * for when the browser lost the one shown at start. The engine checks the
 * signed-in owner and returns the key once; the previous key stops working.
 */
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
  const result = await rotateProxyKey(user.ownerSubject, sandboxId, token);
  return toResponse(result);
}
