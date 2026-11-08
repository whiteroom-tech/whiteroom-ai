'use client';

import { Banner } from '@whiteroom/ui';
import { useViewerZone } from '@/hooks/useViewerZone';
import { SANDBOX_CLEARED } from '@/lib/home-fleet-shared';
import { safeGet, safeRemove, safeSet } from '@/lib/safe-storage';
import { sandboxOpensLine } from '@/lib/sandbox-opens-line';

// The Free home fleet's two info lines (free tier §3.8, S15 and S17), in the
// plan banners' wrapper (its info fill). Used by Sandbox and Fleet key.

/**
 * The new home fleet that replaced a retired one, until a page shows the
 * cleared line over it: a session re-check can reload the page in between.
 * Sandbox and Fleet key both read it, show the line only for that fleet, and
 * drop it once a fleet is shown.
 */
const CLEARED_KEY = 'wr_sandbox_cleared';
export const rememberCleared = (fleetId: string) => safeSet(CLEARED_KEY, fleetId);
export const clearedFleet = () => safeGet(CLEARED_KEY);
export const forgetCleared = () => safeRemove(CLEARED_KEY);

/** S17: shown once, over the new Sandbox that replaced one retired after 30 idle days. */
export function SandboxClearedLine() {
  return <div className="wr-plan-banner"><Banner variant="info">{SANDBOX_CLEARED}</Banner></div>;
}

/** S15: a Free account made over the day's sign-up cap, before its Sandbox opens. */
export function SandboxOpensLaterLine({ opensAt, now }: { opensAt: string; now?: number }) {
  // Null while server-rendering and hydrating: the time waits for the viewer's zone.
  const zone = useViewerZone();
  const at = new Date(opensAt).getTime();
  if (!zone || Number.isNaN(at)) return null;
  return <div className="wr-plan-banner"><Banner variant="info">{sandboxOpensLine(at, now ?? Date.now(), zone)}</Banner></div>;
}
