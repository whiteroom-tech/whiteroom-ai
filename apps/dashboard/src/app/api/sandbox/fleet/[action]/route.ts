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
import { engineBody, sandboxFleetEngine, sandboxFleetOwner } from '@/lib/sandbox/fleet-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8 * 1024;
const invalid = () => Response.json({ error: 'Invalid request.' }, { status: 400 });

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const originError = await checkSameOrigin();
  if (originError) return originError;
  const { action } = await params;
  if (!isSandboxFleetAction(action)) return Response.json({ error: 'Not found.' }, { status: 404 });

  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });
  // Counted again after reading: content-length can be absent (chunked).
  const raw = await req.arrayBuffer().catch(() => null);
  if (!raw) return invalid();
  if (raw.byteLength > MAX_BODY_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return invalid();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
  const fields = body as Record<string, unknown>;

  const owner = await sandboxFleetOwner(fields.fleet);
  if ('error' in owner) return owner.error;
  const sent = engineBody(action, owner.fleet, fields);
  if ('error' in sent && sent.error instanceof Response) return sent.error;
  return sandboxFleetEngine(action, owner, sent);
}
