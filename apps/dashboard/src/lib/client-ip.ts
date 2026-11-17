/**
 * The client's address from X-Forwarded-For.
 *
 * Google's front end appends the address it saw to whatever the client sent,
 * and each of our own proxies after it appends one more. So the client is
 * TRUSTED_PROXY_HOPS entries from the end:
 *
 * - 1 (default): behind the load balancer, which appends
 *   "<client>, <load balancer>". US production.
 * - 0: Cloud Run reached directly (a domain mapping, no load balancer), where
 *   the last entry is the client. EU production and staging, until each gets
 *   a load balancer; then 1.
 *
 * Everything to the left of that is what the client wrote and can't be
 * trusted. With fewer entries than expected the request didn't come through
 * our proxies, and the first entry is the best guess. '' with no header
 * (local dev).
 */
export function clientIp(forwardedFor: string | null | undefined, hops = trustedProxyHops()): string {
  const parts = (forwardedFor ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const index = parts.length - 1 - hops;
  return index >= 0 ? parts[index] : parts[0];
}

/** TRUSTED_PROXY_HOPS as 0–3; anything else is the behind-the-load-balancer default, 1. */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 1;
}
