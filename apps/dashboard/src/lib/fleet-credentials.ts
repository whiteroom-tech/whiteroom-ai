// Single authority for the fleet credential pair in browser storage.
//
// The pair is `wr_fleet` (fleet id) + `wr_fleet_token` (fleet token), plus the
// legacy `wr_token` key from before fleet tokens were split out. Reading and
// writing them anywhere else caused the credential-mismatch bugs this module
// exists to end: onboarding once wrote only the token, leaving a stale
// `wr_fleet` from a previous fleet, and Citadel tabs then logged users out at
// random. Always write the pair together via setFleetCredentials.

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

/** Writes the pair atomically-in-spirit: never one key without the other. */
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
