// The Sandbox helper through the BFF (spec sandbox-v2 §6):
//
//   POST /api/sandbox/helper/status      {fleet, sandboxFleetId?}
//   POST /api/sandbox/helper/code        {fleet, sandboxFleetId?}   → the helper code, once
//   POST /api/sandbox/helper/run         {fleet, sandboxFleetId?, prompt, requestId}
//   POST /api/sandbox/helper/disconnect  {fleet, sandboxFleetId?}
//
// `fleet` is the user's production fleet: same-origin, signed-in owner only
// (lib/sandbox/fleet-server.ts). Only the engine's sandbox_helper_* actions
// are called, and Run sends a prompt, never a command.

import { checkSameOrigin } from '@/lib/origin-check';
import { readJsonBody, sandboxFleetOwner } from '@/lib/sandbox/fleet-server';
import { isSandboxHelperAction } from '@/lib/sandbox/helper';
import { helperEngineBody, sandboxHelperEngine } from '@/lib/sandbox/helper-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A prompt of 4,000 characters, up to 4 bytes each.
const MAX_BODY_BYTES = 20 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const originError = await checkSameOrigin();
  if (originError) return originError;
  const { action } = await params;
  if (!isSandboxHelperAction(action)) return Response.json({ error: 'Not found.' }, { status: 404 });

  const read = await readJsonBody(req, MAX_BODY_BYTES);
  if ('error' in read) return read.error;

  const owner = await sandboxFleetOwner(read.body.fleet);
  if ('error' in owner) return owner.error;
  const sent = helperEngineBody(action, owner.fleet, read.body);
  if ('error' in sent && sent.error instanceof Response) return sent.error;
  return sandboxHelperEngine(action, owner, sent);
}
