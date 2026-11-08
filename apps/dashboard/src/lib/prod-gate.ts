import 'server-only';

import { PROXY_URL } from '@/lib/whiteroom/client';
import type { GateState } from '@/lib/plan-banner-shared';

/** How long a read of the region's gate is reused, process-wide: it changes only when a flag is flipped. */
export const GATE_READ_TTL_MS = 5 * 60_000;
const GATE_READ_TIMEOUT_MS = 2_000;

let known: { at: number; value: Exclude<GateState, 'unknown'> } | null = null;
let inFlight: Promise<GateState> | null = null;

/**
 * Whether this region refuses live calls for accounts without a live plan,
 * from WhiteRoom's status read (dashboard secret). Reused for
 * GATE_READ_TTL_MS. Anything but a clear answer (not configured, an error, a
 * non-200, an unreadable body) is `unknown`, treated as not on, and isn't
 * kept, so the next page asks again.
 */
export async function readGateState(): Promise<GateState> {
  if (known && Date.now() - known.at < GATE_READ_TTL_MS) return known.value;
  inFlight ??= fetchGate().finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchGate(): Promise<GateState> {
  const secret = process.env.WR_ENTITLEMENT_SYNC_SECRET;
  if (!secret) return 'unknown';
  try {
    const res = await fetch(`${PROXY_URL}/internal/status`, {
      headers: { 'x-wr-sync-secret': secret },
      cache: 'no-store',
      signal: AbortSignal.timeout(GATE_READ_TIMEOUT_MS),
    });
    if (res.status !== 200) return 'unknown';
    const gate = ((await res.json()) as { gate?: unknown } | null)?.gate;
    if (gate !== 'off' && gate !== 'shadow' && gate !== 'on') return 'unknown';
    known = { at: Date.now(), value: gate };
    return gate;
  } catch {
    return 'unknown';
  }
}

/** Test hook: forget the kept answer. */
export function _forgetGateState(): void {
  known = null;
  inFlight = null;
}
