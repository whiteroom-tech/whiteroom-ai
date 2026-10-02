// The BFF choke point for keyless browser calls to the WhiteRoom engine.
//
// The browser no longer holds the fleet token (it lives in the httpOnly
// `wr_fleet_auth` cookie), so client.ts posts engine bodies here and this
// route attaches the server-held token before forwarding. Deliberately a
// TRANSPARENT proxy: the body rides through verbatim and the engine
// authorizes by token — no action allowlist, no body rewriting. The engine's
// status and JSON body come back unchanged, so WhiteRoomApiError/isAuthError
// semantics in client.ts work exactly as they do for direct calls.
//
// One exception to "transparent": the control actions (rule changes, pause /
// resume) are dashboard-only at the engine (R1). For those, this route checks
// the caller is a signed-in user linked to the fleet, then adds the
// dashboard's service secret. Agents never come through here with a user
// session, so they can't change their own controls.

import { checkSameOrigin } from '@/lib/origin-check';
import {
  getFleetAuthCookie,
  setFleetAuthCookie,
  tokenFromUserFleets,
} from '@/lib/fleet-session';
import { CONTROL_DENIED, engineAuthHeaders, PROXY_URL } from '@/lib/whiteroom/client';
import { CONTROL_SECRET_HEADER, controlAccessError, controlActionOf } from '@/lib/control-auth';
import { recordControlAction } from '@/lib/control-actions';
import { auth } from '@/auth';

const MAX_BODY_BYTES = 64 * 1024;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const originError = await checkSameOrigin();
  if (originError) return originError;

  let token = await getFleetAuthCookie();
  if (!token) {
    // next-auth session user whose cookie hasn't been minted yet (e.g. first
    // request after sign-in): adopt the preferred linked fleet's token and
    // set the cookie so later calls skip the DB lookup.
    const linked = await tokenFromUserFleets();
    if (linked) {
      token = linked.token;
      await setFleetAuthCookie(token);
    }
  }
  if (!token) {
    return Response.json({ error: 'No fleet session.' }, { status: 401 });
  }

  // Engine actions are small JSON bodies; refuse anything bigger before reading it.
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });
  // Counted in bytes, and checked again after reading: content-length can be absent (chunked).
  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });
  const body = new TextDecoder().decode(raw);

  const headers = engineAuthHeaders(token);
  const control = controlActionOf(body);
  if (control) {
    const denied = await controlAccessError(control.fleetId, token);
    if (denied) {
      const code = denied.status === 403 ? { code: CONTROL_DENIED } : {};
      return Response.json({ error: denied.error, ...code }, { status: denied.status });
    }
    // Unset during rollout: the request goes without it, which engines from
    // before R1 accept and engines with R1 refuse (fail closed).
    const secret = process.env.WR_DASHBOARD_SERVICE_SECRET;
    if (secret) headers[CONTROL_SECRET_HEADER] = secret;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      cache: 'no-store',
      headers,
      body,
    });
  } catch {
    // Network failure, timeout, or unexpected redirect reaching the engine.
    return Response.json(
      { error: 'engine_unreachable', retryable: true },
      { status: 502 },
    );
  }

  // A control change the engine accepted: note who made it, since the engine
  // only knows "dashboard". Control replies are small, so read them whole.
  if (control?.fleetId && upstream.ok) {
    const reply = await upstream.text();
    const userId = (await auth())?.user?.id;
    if (userId) await recordControlAction(userId, control.fleetId, control.action, body, reply);
    return new Response(reply, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  // Pass the engine's status and body through unchanged (a 401 here means
  // the ENGINE rejected the token, and the client treats it as an auth error
  // just like a direct call).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
