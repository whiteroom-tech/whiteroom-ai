import { requireSandboxUser } from "@/lib/sandbox/auth";
import { getHistory, toResponse, extractFleetToken } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sandbox › Past tests: the signed-in owner's finished tests. The owner comes
// from the session, never from the request.
export async function GET(req: Request) {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const token = await extractFleetToken(req);
  const result = await getHistory(user.ownerSubject, token);
  return toResponse(result);
}
