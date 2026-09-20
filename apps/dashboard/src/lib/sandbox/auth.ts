import "server-only";
import { auth } from "@/auth";
import { headers } from "next/headers";

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

  const hdrs = await headers();
  const origin = hdrs.get("origin");
  const host = hdrs.get("host");
  if (!origin || !host) {
    return { error: Response.json({ error: "Missing origin." }, { status: 403 }) };
  }
  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      return { error: Response.json({ error: "Origin mismatch." }, { status: 403 }) };
    }
  } catch {
    return { error: Response.json({ error: "Invalid origin." }, { status: 403 }) };
  }

  return user;
}
