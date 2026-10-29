// Sandbox v2 through the BFF (spec sandbox-v2 §2 steps 1–2, §7 S1–S3):
//
//   POST /api/sandbox/fleet/status   {fleet}
//   POST /api/sandbox/fleet/connect  {fleet, provider, api_key, endpoint?}
//   POST /api/sandbox/fleet/rotate   {fleet, sandboxFleetId?}
//   POST /api/sandbox/fleet/reset    {fleet, sandboxFleetId?}
//
// `fleet` is the user's production fleet. Every request must be same-origin
// and from the signed-in account that owns it (lib/sandbox/fleet-server.ts).
// Status is a POST too, so the same checks cover it and nothing is cached.

import { checkSameOrigin } from '@/lib/origin-check';
import { isSandboxFleetAction } from '@/lib/sandbox/fleet';
import { engineBody, readJsonBody, sandboxFleetEngine, sandboxFleetOwner } from '@/lib/sandbox/fleet-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const originError = await checkSameOrigin();
  if (originError) return originError;
  const { action } = await params;
  if (!isSandboxFleetAction(action)) return Response.json({ error: 'Not found.' }, { status: 404 });

  const read = await readJsonBody(req, MAX_BODY_BYTES);
  if ('error' in read) return read.error;
  const fields = read.body;

  const owner = await sandboxFleetOwner(fields.fleet);
  if ('error' in owner) return owner.error;
  const sent = engineBody(action, owner.fleet, fields);
  if ('error' in sent && sent.error instanceof Response) return sent.error;
  return sandboxFleetEngine(action, owner, sent);
}
