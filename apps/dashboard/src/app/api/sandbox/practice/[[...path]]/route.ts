// Practice tests through the BFF (spec §4 Start, §7 owner routes):
//
//   GET  /api/sandbox/practice?fleet=                 Past tests rows for the fleet's owner
//   GET  /api/sandbox/practice/source-model?fleet=&agent=
//   GET  /api/sandbox/practice/<run>?fleet=           progress
//   GET  /api/sandbox/practice/<run>/report?fleet=    result
//   POST /api/sandbox/practice/start                  {fleet, sample, runs, agent?, model?, scope?, proxyKeyDisplayPrefix?}
//   POST /api/sandbox/practice/<run>/code             {fleet}: Get a new run code
//   POST /api/sandbox/practice/<run>/end              {fleet}: End test
//
// Every request names its fleet and is refused unless the signed-in account
// owns it (practiceOwner); POSTs must also be same-origin. Only the fields
// above are forwarded; the engine validates them strictly.

import { checkSameOrigin } from '@/lib/origin-check';
import { PROXY_KEY_PREFIX_RE, RUN_ID_RE } from '@/lib/sandbox/practice/model';
import { practiceEngine, practiceOwner } from '@/lib/sandbox/practice/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ path?: string[] }> };
const MAX_BODY_BYTES = 16 * 1024;
const notFound = () => Response.json({ error: 'Not found.' }, { status: 404 });
const invalid = () => Response.json({ error: 'Invalid request.' }, { status: 400 });

/** The body as text, or null past `max` bytes: refused by Content-Length first, then counted while reading (chunked bodies). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function GET(req: Request, { params }: Params) {
  const path = (await params).path ?? [];
  const q = new URL(req.url).searchParams;
  const owner = await practiceOwner(q.get('fleet'));
  if ('error' in owner) return owner.error;
  const fleet = encodeURIComponent(owner.fleet);
  if (path.length === 0) return practiceEngine('GET', `runs?fleet=${fleet}`, undefined, owner.userId);
  if (path.length === 1 && path[0] === 'source-model') {
    const agent = q.get('agent');
    if (!agent || agent.length > 128) return invalid();
    return practiceEngine('GET', `source-model?fleet=${fleet}&agent=${encodeURIComponent(agent)}`, undefined, owner.userId);
  }
  const [run, sub] = path;
  if (!RUN_ID_RE.test(run) || path.length > 2 || (sub !== undefined && sub !== 'report')) return notFound();
  return practiceEngine('GET', `runs/${run}${sub ? '/report' : ''}?fleet=${fleet}`, undefined, owner.userId);
}

export async function POST(req: Request, { params }: Params) {
  const originError = await checkSameOrigin();
  if (originError) return originError;
  const path = (await params).path ?? [];
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === null) return Response.json({ error: 'Request too large.' }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
  const owner = await practiceOwner(body.fleet);
  if ('error' in owner) return owner.error;

  if (path.length === 1 && path[0] === 'start') {
    const { sample, runs, agent, model, scope, proxyKeyDisplayPrefix } = body;
    if (typeof sample !== 'boolean' || (runs !== 1 && runs !== 3)) return invalid();
    // The same bounds as the engine's, so nothing bigger is forwarded.
    const name = (v: unknown) => v === undefined || (typeof v === 'string' && v.length >= 1 && v.length <= 128);
    if (!name(agent) || !name(model)) return invalid();
    if (scope !== undefined && (!Array.isArray(scope) || scope.length > 64 || !scope.every((s) => typeof s === 'string' && s.length <= 128))) return invalid();
    // R7: a Fleet key key, by the display prefix Fleet key lists (never the key itself).
    if (proxyKeyDisplayPrefix !== undefined && (typeof proxyKeyDisplayPrefix !== 'string' || !PROXY_KEY_PREFIX_RE.test(proxyKeyDisplayPrefix))) return invalid();
    return practiceEngine('POST', 'start', { fleet: owner.fleet, sample, runs, agent, model, scope, proxyKeyDisplayPrefix, startedBy: owner.userId }, owner.userId);
  }
  const [run, action] = path;
  if (path.length !== 2 || !RUN_ID_RE.test(run) || (action !== 'code' && action !== 'end')) return notFound();
  return practiceEngine('POST', `runs/${run}/${action}`, { fleet: owner.fleet }, owner.userId);
}
