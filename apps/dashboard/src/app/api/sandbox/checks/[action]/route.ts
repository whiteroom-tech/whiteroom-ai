// Sandbox checks through the BFF (spec sandbox-v2 §2 step 4, §5):
//
//   POST /api/sandbox/checks/status  {fleet, sandboxFleetId?}
//   POST /api/sandbox/checks/start   {fleet, sandboxFleetId?, injectErrors?}
//   POST /api/sandbox/checks/stop    {fleet, sandboxFleetId?}
//
// `fleet` is the user's production fleet: same-origin, signed-in owner only
// (lib/sandbox/fleet-server.ts). Only the engine's sandbox_check_* actions are called.

import { checkSameOrigin } from '@/lib/origin-check';
import { isSandboxChecksAction } from '@/lib/sandbox/checks';
import { checksEngineBody, sandboxChecksEngine } from '@/lib/sandbox/checks-server';
import { readJsonBody, sandboxFleetOwner } from '@/lib/sandbox/fleet-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const originError = await checkSameOrigin();
  if (originError) return originError;
  const { action } = await params;
  if (!isSandboxChecksAction(action)) return Response.json({ error: 'Not found.' }, { status: 404 });

  const read = await readJsonBody(req, MAX_BODY_BYTES);
  if ('error' in read) return read.error;

  const owner = await sandboxFleetOwner(read.body.fleet);
  if ('error' in owner) return owner.error;
  const sent = checksEngineBody(action, owner.fleet, read.body);
  if ('error' in sent && sent.error instanceof Response) return sent.error;
  return sandboxChecksEngine(action, owner, sent);
}
