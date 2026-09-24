// The BFF choke point for keyless browser calls to the WhiteRoom engine.
//
// The browser no longer holds the fleet token (it lives in the httpOnly
// `wr_fleet_auth` cookie), so client.ts posts engine bodies here and this
// route attaches the server-held token before forwarding. Deliberately a
// TRANSPARENT proxy: the body rides through verbatim and the engine
// authorizes by token — no action allowlist, no body rewriting. The engine's
// status and JSON body come back unchanged, so WhiteRoomApiError/isAuthError
// semantics in client.ts work exactly as they do for direct calls.

import { checkSameOrigin } from '@/lib/origin-check';
import {
  getFleetAuthCookie,
  setFleetAuthCookie,
  tokenFromUserFleets,
} from '@/lib/fleet-session';
import { engineAuthHeaders, PROXY_URL } from '@/lib/whiteroom/client';

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

  const body = await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${PROXY_URL}/api/white-room`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      cache: 'no-store',
      headers: engineAuthHeaders(token),
      body,
    });
  } catch {
    // Network failure, timeout, or unexpected redirect reaching the engine.
    return Response.json(
      { error: 'engine_unreachable', retryable: true },
      { status: 502 },
    );
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
