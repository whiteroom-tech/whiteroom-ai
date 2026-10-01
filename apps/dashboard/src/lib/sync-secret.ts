import 'server-only';

import { timingSafeEqual } from 'node:crypto';

/**
 * Whether a request carries the shared engine/scheduler secret. Shared by the
 * internal routes Cloud Scheduler calls, so they can't drift into checking it
 * differently.
 */
export function syncSecretMatches(secret: string | null): boolean {
  const expected = process.env.WR_ENTITLEMENT_SYNC_SECRET;
  if (!secret || !expected) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
