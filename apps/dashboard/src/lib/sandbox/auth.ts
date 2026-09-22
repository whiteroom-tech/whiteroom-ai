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
    const parsed = new URL(origin);
    const local = process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.host !== host || parsed.origin !== origin ||
        (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) {
      return { error: Response.json({ error: "Origin mismatch." }, { status: 403 }) };
    }
  } catch {
    return { error: Response.json({ error: "Invalid origin." }, { status: 403 }) };
  }

  return user;
}
