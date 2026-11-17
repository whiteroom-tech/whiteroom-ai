/**
 * A per-address request limit for the dashboard, applied in proxy.ts.
 *
 * The entrance zone's firewall does this at the load balancer in US
 * (engine repo, ops/edge). EU has no load balancer yet, so this is its only
 * per-address limit, and in US it is a second layer with the same number.
 *
 * Counts live in this process. The dashboard runs as a Node server on Cloud
 * Run, where proxy.ts shares the process with the app, so the counts persist
 * between requests. With several instances each counts on its own, so the
 * effective limit is the limit times the instance count: a flood is still cut
 * down, which is the point.
 *
 * A sliding-window counter: this minute's count plus the share of last
 * minute's still inside the window. Two numbers per address, however busy.
 */

const WINDOW_MS = 60_000;
/** Addresses tracked at once. A full table drops the least recently seen. */
export const MAX_TRACKED = 10_000;
/** Requests a minute from one address when IP_REQUESTS_PER_MINUTE isn't set. */
export const DEFAULT_IP_REQUESTS_PER_MINUTE = 1000;

interface Entry { window: number; current: number; previous: number }
// Least recently seen first: every request re-inserts its address.
const entries = new Map<string, Entry>();

/** IP_REQUESTS_PER_MINUTE: a whole number, 0 to turn the limit off. Anything else is the default. */
export function ipRequestsPerMinute(env: Record<string, string | undefined> = process.env): number {
  const raw = env.IP_REQUESTS_PER_MINUTE?.trim();
  if (raw === undefined || raw === '') return DEFAULT_IP_REQUESTS_PER_MINUTE;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_IP_REQUESTS_PER_MINUTE;
}

export type Taken = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Counts one request from `ip`. Refused (and not counted) once the address is
 * at `limit` a minute.
 */
export function takeIpRequest(ip: string, limit: number, now = Date.now()): Taken {
  const window = Math.floor(now / WINDOW_MS);
  let entry = entries.get(ip);
  if (entry) {
    entries.delete(ip);
  } else {
    if (entries.size >= MAX_TRACKED) entries.delete(entries.keys().next().value as string);
    entry = { window, current: 0, previous: 0 };
  }
  if (entry.window !== window) {
    entry.previous = entry.window === window - 1 ? entry.current : 0;
    entry.current = 0;
    entry.window = window;
  }
  entries.set(ip, entry);

  const elapsed = (now % WINDOW_MS) / WINDOW_MS;
  const inWindow = entry.previous * (1 - elapsed) + entry.current;
  if (inWindow >= limit) {
    // The rest of this minute: simple, and never shorter than the real wait
    // for a caller still under the limit next minute.
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - elapsed) * (WINDOW_MS / 1000))) };
  }
  entry.current += 1;
  return { ok: true };
}

/** Tests only: forget every address. */
export function _resetIpRateLimit(): void {
  entries.clear();
}
