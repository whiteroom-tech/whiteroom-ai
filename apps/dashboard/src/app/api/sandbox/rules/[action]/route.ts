// Sandbox rules through the BFF (spec sandbox-v2 §2 step 3, §4, §8.2):
//
//   POST /api/sandbox/rules/list             {fleet, sandboxFleetId?}
//   POST /api/sandbox/rules/ready-made       {fleet, sandboxFleetId?}
//   POST /api/sandbox/rules/copy-production  {fleet, sandboxFleetId?}
//   POST /api/sandbox/rules/create           {fleet, sandboxFleetId?, ruleType, mode?, response?, alsoNotify?, params?, appliesTo?, description?}
//   POST /api/sandbox/rules/update           {fleet, sandboxFleetId?, ruleId, ifVersion?, mode?, response?, alsoNotify?, params?, appliesTo?, description?}
//   POST /api/sandbox/rules/delete           {fleet, sandboxFleetId?, ruleId}
//
// `fleet` is the user's production fleet: same-origin, signed-in owner only
// (lib/sandbox/fleet-server.ts). Only the engine's Sandbox rule actions are
// called; production rules are read on Controls' own path, never written here.

import { auth } from '@/auth';
import { checkSameOrigin } from '@/lib/origin-check';
import { readJsonBody, sandboxFleetOwner } from '@/lib/sandbox/fleet-server';
import { isSandboxRulesAction } from '@/lib/sandbox/rules';
import { rulesEngineBody, sandboxRulesEngine } from '@/lib/sandbox/rules-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A keyword rule holds up to 50 keywords of 50 characters.
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const originError = await checkSameOrigin();
  if (originError) return originError;
  const { action } = await params;
  if (!isSandboxRulesAction(action)) return Response.json({ error: 'Not found.' }, { status: 404 });

  // The cheap signed-in check before the body is read; the owner check needs the body's fleet.
  if (!(await auth().catch(() => null))?.user?.id) return Response.json({ error: 'Sign in to use the Sandbox.' }, { status: 401 });
  const read = await readJsonBody(req, MAX_BODY_BYTES);
  if ('error' in read) return read.error;

  const owner = await sandboxFleetOwner(read.body.fleet);
  if ('error' in owner) return owner.error;
  const sent = rulesEngineBody(action, owner.fleet, read.body);
  if ('error' in sent && sent.error instanceof Response) return sent.error;
  return sandboxRulesEngine(action, owner, sent);
}
