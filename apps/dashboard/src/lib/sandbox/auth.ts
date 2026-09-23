import "server-only";
import { auth } from "@/auth";
import { checkSameOrigin } from "@/lib/origin-check";

export const SANDBOX_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export async function requireSandboxUser(): Promise<
  { ownerSubject: string } | { error: Response }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: Response.json({ error: "Unauthorized." }, { status: 401 }) };
  }
  return { ownerSubject: `dashboard:${session.user.id}` };
}

export async function requireSandboxMutation(): Promise<
  { ownerSubject: string } | { error: Response }
> {
  const user = await requireSandboxUser();
  if ("error" in user) return user;

  // Same-origin rule shared with the fleet-session routes (src/lib/origin-check.ts).
  const originError = await checkSameOrigin();
  if (originError) return { error: originError };

  return user;
}
