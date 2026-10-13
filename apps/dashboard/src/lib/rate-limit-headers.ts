import 'server-only';

import { createHmac } from 'node:crypto';

/**
 * Names the signed-in user a dashboard call to the engine is for, so the
 * engine's rate limit counts it against them rather than the dashboard's shared
 * egress IP. Calls with no signed-in user (a fleet cookie alone, unchecked here)
 * name no one and count per IP. The signature (never the service secret, which
 * gates control actions) picks a rate-limit bucket and nothing else, and is good
 * for this minute and the next.
 * Keep in step with rateLimitUserSig in the engine's middleware/dashboard-auth.ts.
 */
export function rateLimitHeaders(userId: string | null | undefined, secret = process.env.WR_DASHBOARD_SERVICE_SECRET, now = Date.now()): Record<string, string> {
  if (!userId || !secret) return {};
  return {
    'x-wr-dashboard-user': userId,
    'x-wr-dashboard-user-sig': createHmac('sha256', secret).update(`rate-limit:${userId}:${Math.floor(now / 60_000)}`).digest('hex'),
  };
}
