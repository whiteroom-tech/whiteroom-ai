import 'server-only';
import { auth } from '@/auth';
import { controlAccessError, CONTROL_SECRET_HEADER, CONTROL_USER_HEADER } from '@/lib/control-auth';
import { getFleetAuthCookie, tokenFromUserFleets } from '@/lib/fleet-session';
import { engineAuthHeaders, PROXY_URL } from '@/lib/whiteroom/client';
import { refusalWords, SANDBOX_CODES } from './refusals';
import { connectCheck, isPinMismatch, issuedOf, SANDBOX_CHANGED, SANDBOX_FLEET_UNAVAILABLE, statusOf, type SandboxFleetAction } from './fleet';

// The BFF side of Sandbox v2 (spec §7 S1–S3). The engine's sandbox_fleet_*
// actions are dashboard-only: they take the dashboard's service secret and the
// signed-in user, and name the PRODUCTION fleet with that fleet's own
// credential. So every request is checked here first: a signed-in account
// that owns the production fleet (controlAccessError, the rule for changing
// its controls). Never authorized by a Sandbox key.
//
// What goes out: only the fields each action takes, and a provider key only
// when the browser just typed it (connect). What comes back: only the status
// fields and, from connect and rotate, the Sandbox key once. Never a provider
// key, and nothing here is logged.

const FLEET_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SANDBOX_ID_RE = /^sandbox-[A-Za-z0-9-]{1,120}$/;
const REASON_RE = /^[a-z][a-z_]{0,63}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9-]{1,128}$/;
/** An ISO time, as the engine sends `resetAt`. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const json = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export const fail = (status: number, error: string, reason?: string) => json(status, reason ? { error, reason } : { error });
const unavailable = () => fail(404, 'Sandbox isn’t available yet.', SANDBOX_FLEET_UNAVAILABLE);

export interface SandboxFleetOwner {
  fleet: string;
  userId: string;
  /** The production fleet's credential, sent to the engine; never returned. */
  token: string;
}

/** The signed-in owner of production fleet `fleet` and its credential, or the refusal to answer with. */
export async function sandboxFleetOwner(fleet: unknown): Promise<SandboxFleetOwner | { error: Response }> {
  if (typeof fleet !== 'string' || !FLEET_RE.test(fleet)) return { error: fail(400, 'Invalid request.') };
  // A Sandbox belongs to a production fleet; a Sandbox fleet never has one.
  if (fleet.startsWith('sandbox-')) return { error: fail(400, 'Pick your production fleet to use the Sandbox.') };
  const userId = (await auth().catch(() => null))?.user?.id;
  if (!userId) return { error: fail(401, 'Sign in to use the Sandbox.') };
  const token = (await getFleetAuthCookie()) ?? (await tokenFromUserFleets())?.token;
  if (!token) return { error: fail(403, 'Your WhiteRoom account isn’t linked to this fleet.') };
  const denied = await controlAccessError(fleet, token);
  return denied ? { error: fail(denied.status, denied.error) } : { fleet, userId, token };
}

/**
 * The engine body for `action`, built from known fields only, or the refusal.
 * `sandboxFleetId` (rotate, reset) makes the engine refuse with 409 when the
 * page's Sandbox isn't the fleet's current one.
 */
export function engineBody(action: SandboxFleetAction, fleet: string, body: Record<string, unknown>): Record<string, unknown> | { error: Response } {
  // The sample's run takes nothing but the fleet (its key and prompts are the engine's own), and the
  // press's idempotency key, so a repeat of the same start is charged once.
  if (action === 'sample') {
    const idem = body.idempotencyKey;
    if (idem !== undefined && (typeof idem !== 'string' || !IDEMPOTENCY_RE.test(idem))) return { error: fail(400, 'Invalid request.') };
    return { action: 'sandbox_sample_start', fleet_id: fleet, ...(idem !== undefined && { idempotency_key: idem }) };
  }
  const base = { action: `sandbox_fleet_${action}`, fleet_id: fleet };
  if (action === 'status') return base;
  if (action === 'connect') {
    const check = connectCheck(body.provider, body.api_key, body.endpoint);
    if (!check.ok) return { error: fail(400, check.error) };
    return { ...base, ...check.request };
  }
  const pin = sandboxPin(body.sandboxFleetId);
  return 'error' in pin ? pin : { ...base, ...pin };
}

/**
 * The page's Sandbox, as the engine's `sandbox_fleet_id` pin (the engine
 * refuses with 409 when it isn't the fleet's current one): none when absent.
 */
export function sandboxPin(named: unknown): { sandbox_fleet_id?: string } | { error: Response } {
  if (named === undefined) return {};
  if (typeof named !== 'string' || !SANDBOX_ID_RE.test(named)) return { error: fail(400, 'Invalid request.') };
  return { sandbox_fleet_id: named };
}

/** The engine's refusal of an action it doesn't know: an engine from before Sandbox v2. */
const unknownAction = (status: number, data: unknown) =>
  status === 400 && !!data && typeof data === 'object' && /^Unknown action\b/i.test(String((data as { error?: unknown }).error ?? ''));

/**
 * A JSON object request body of at most `max` bytes, or the refusal. Counted
 * again after reading: content-length can be absent (chunked).
 */
export async function readJsonBody(req: Request, max: number): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  const tooLarge = () => ({ error: fail(413, 'Request too large.') });
  if (Number(req.headers.get('content-length') ?? 0) > max) return tooLarge();
  const raw = await req.arrayBuffer().catch(() => null);
  if (!raw) return { error: fail(400, 'Invalid request.') };
  if (raw.byteLength > max) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { error: fail(400, 'Invalid request.') };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: fail(400, 'Invalid request.') };
  return { body: body as Record<string, unknown> };
}

/**
 * One dashboard-only engine call for `owner`, with the service secret and
 * the user: the engine's answer, or the refusal to send back as it is (no
 * secret, unreachable, an engine without the action, an error).
 */
export async function postEngine(owner: SandboxFleetOwner, body: Record<string, unknown>): Promise<{ data: unknown } | { error: Response }> {
  const secret = process.env.WR_DASHBOARD_SERVICE_SECRET;
  if (!secret) return { error: unavailable() };
  let res: Response;
  try {
    res = await fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      headers: { ...engineAuthHeaders(owner.token), [CONTROL_SECRET_HEADER]: secret, [CONTROL_USER_HEADER]: owner.userId },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { error: fail(502, 'Couldn’t reach WhiteRoom. Check your connection and try again.') };
  }
  const data: unknown = await res.json().catch(() => null);
  if (unknownAction(res.status, data)) return { error: unavailable() };
  if (!res.ok) return { error: refusalResponse(res.status, data, res.headers.get('retry-after')) };
  return { data };
}

/**
 * An engine refusal as the page may see it. The engine's own words for a
 * 4xx (short refusals that never carry a key), with its machine reason
 * (no_helper, tasks_per_hour…), the Sandbox's refusal code and resetAt, and
 * a 429's or 503's wait. A 5xx is the dashboard's own line: §3.10's for the
 * Sandbox's codes (free_paused, sandbox_busy…), else a generic one.
 */
export function refusalResponse(status: number, data: unknown, retryAfter: string | null): Response {
  const d = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const name = (v: unknown) => (typeof v === 'string' && REASON_RE.test(v) ? v : undefined);
  const nested = d.whiteroom && typeof d.whiteroom === 'object' ? d.whiteroom as Record<string, unknown> : {};
  // The code may come as `code`, the proxy's `whiteroom.reason`, or the refusal's own `reason`.
  const code = [name(d.code), name(nested.reason), name(d.reason)].find((c) => c && SANDBOX_CODES.includes(c));
  const rawReset = typeof d.resetAt === 'string' ? d.resetAt : nested.resetAt;
  const resetAt = typeof rawReset === 'string' && ISO_RE.test(rawReset) ? rawReset : undefined;
  const wait = Number(retryAfter);
  const waitOk = (status === 429 || status === 503) && Number.isInteger(wait) && wait > 0 && wait <= 86_400;
  const error = typeof d.error === 'string' ? d.error : '';
  let body: Record<string, unknown>;
  if (status >= 500 || !error) {
    const words = code ? refusalWords({ status, code }, 'other', Date.now()) : null;
    // Only a Sandbox code keeps its status (503: busy or paused); anything else is the generic 502/5xx.
    if (!words) return fail(status >= 500 ? status : 502, 'The Sandbox couldn’t do that right now. Try again in a moment.');
    body = { error: words, reason: name(d.reason) ?? code, code };
  } else {
    // The pin refusal has no reason of its own: named here so the page can tell it from a state conflict.
    const reason = name(d.reason) ?? (isPinMismatch(status, error) ? SANDBOX_CHANGED : undefined);
    body = { error: error.slice(0, 300), ...(reason && { reason }), ...(code && { code }) };
  }
  if (resetAt && code === 'sandbox_daily_limit') body.resetAt = resetAt;
  if (!waitOk) return json(status, body);
  return json(status, { ...body, retryAfter: wait }, { 'Retry-After': String(wait) });
}

/** One sandbox_fleet_* call, its answer cut down to what the page may see. */
export async function sandboxFleetEngine(action: SandboxFleetAction, owner: SandboxFleetOwner, body: Record<string, unknown>): Promise<Response> {
  const answer = await postEngine(owner, body);
  if ('error' in answer) return answer.error;
  const { data } = answer;
  const status = statusOf(data);
  if (!status) return fail(502, 'WhiteRoom sent an answer the dashboard couldn’t read. Try again.');
  if (action === 'connect' || action === 'rotate') {
    const issued = issuedOf(data);
    if (!issued) return fail(502, 'WhiteRoom didn’t send your Sandbox key. Try again.');
    const created = (data as { created?: unknown }).created === true;
    return json(200, { success: true, ...status, ...(action === 'connect' && { created }), ...issued });
  }
  return json(200, { success: true, ...status });
}
