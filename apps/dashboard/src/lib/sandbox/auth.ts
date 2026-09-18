import { auth } from "@/auth";

export async function requireSandboxUser(): Promise<
  { ownerSubject: string } | { error: Response }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: Response.json({ error: "Unauthorized." }, { status: 401 }) };
  }
  return { ownerSubject: `dashboard:${session.user.id}` };
}
