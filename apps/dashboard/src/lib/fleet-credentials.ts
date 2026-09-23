// Single authority for the LEGACY fleet credential pair in browser storage.
//
// The pair is `wr_fleet` (fleet id) + `wr_fleet_token` (fleet token), plus the
// older `wr_token` key from before fleet tokens were split out.
//
// As of the httpOnly-cookie migration, fleet tokens live in server-side
// custody (`wr_fleet_auth` cookie via /api/fleet/session) and NOTHING should
// write tokens to localStorage any more. This module survives only so
// useFleetAuth can read a pre-migration session once (and move it into the
// cookie) and so sign-out can sweep the old keys away.

import { safeGet, safeRemove, safeSet } from './safe-storage';

export interface FleetCredentials {
  fleetId: string | null;
  fleetToken: string | null;
}

export function getFleetCredentials(): FleetCredentials {
  return {
    fleetId: safeGet('wr_fleet'),
    // Fall back to the legacy key for sessions created before the split.
    fleetToken: safeGet('wr_fleet_token') || safeGet('wr_token'),
  };
}

/**
 * @deprecated Tokens belong in the httpOnly cookie now — POST them to
 * /api/fleet/session instead. Kept only so any straggling caller keeps
 * compiling until it is migrated; do not add new call sites.
 */
export function setFleetCredentials(fleetId: string, fleetToken: string): void {
  safeSet('wr_fleet', fleetId);
  safeSet('wr_fleet_token', fleetToken);
  // The legacy key is superseded; leaving it behind would let a stale token
  // win the fallback read above after the next clear.
  safeRemove('wr_token');
}

export function clearFleetCredentials(): void {
  safeRemove('wr_token');
  safeRemove('wr_fleet');
  safeRemove('wr_fleet_token');
  // Deliberately does NOT touch `wr_sandbox_token`: the sandbox session has
  // its own lifecycle and must survive a fleet sign-out.
}
