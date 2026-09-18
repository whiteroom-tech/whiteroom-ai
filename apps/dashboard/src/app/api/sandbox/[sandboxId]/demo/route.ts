import { requireSandboxUser } from "@/lib/sandbox/auth";
import { startDemo } from "@/lib/sandbox/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const user = await requireSandboxUser();
  if ("error" in user) return user.error;

  const { sandboxId } = await params;
  const result = await startDemo(user.ownerSubject, sandboxId);
  return Response.json(result);
}
