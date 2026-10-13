import 'server-only';

import { createHash, createHmac } from 'node:crypto';

/**
 * Names who a dashboard call to the engine is for, so the engine's rate limit
 * counts it against them rather than the dashboard's shared egress IP: the
 * signed-in user, or a fleet-key-only session by a hash of its token. The
 * signature (never the service secret, which gates control actions) picks a
 * rate-limit bucket and nothing else.
 * Keep in step with rateLimitUserSig in the engine's middleware/dashboard-auth.ts.
 */
export function rateLimitHeaders(userId: string | null | undefined, secret = process.env.WR_DASHBOARD_SERVICE_SECRET): Record<string, string> {
  if (!userId || !secret) return {};
  return {
    'x-wr-dashboard-user': userId,
    'x-wr-dashboard-user-sig': createHmac('sha256', secret).update(`rate-limit:${userId}`).digest('hex'),
  };
}

/** The rate-limit name of a session with only a fleet key: no account to name, so its token's hash. */
export function fleetSessionId(token: string): string {
  return `fleet-${createHash('sha256').update(token).digest('hex').slice(0, 40)}`;
}
