import 'server-only';
import { headers } from 'next/headers';

/**
 * Same-origin (Origin == Host) CSRF check for mutating route handlers.
 *
 * Extracted from requireSandboxMutation (src/lib/sandbox/auth.ts) so the
 * fleet-session routes enforce the exact same rule instead of growing a
 * drifting copy. Semantics preserved verbatim:
 * - Origin and Host headers must both be present.
 * - Origin must parse, be a bare origin (no path/credentials), and match Host.
 * - https only, except localhost/127.0.0.1/[::1] over http outside production.
 *
 * Returns null when the request is same-origin, or a 403 JSON Response the
 * caller should return as-is.
 */
export async function checkSameOrigin(): Promise<Response | null> {
  const hdrs = await headers();
  const origin = hdrs.get('origin');
  const host = hdrs.get('host');
  if (!origin || !host) {
    return Response.json({ error: 'Missing origin.' }, { status: 403 });
  }
  try {
    const parsed = new URL(origin);
    const local = process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.host !== host || parsed.origin !== origin ||
        (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) {
      return Response.json({ error: 'Origin mismatch.' }, { status: 403 });
    }
  } catch {
    return Response.json({ error: 'Invalid origin.' }, { status: 403 });
  }
  return null;
}
