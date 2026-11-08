// The Free home fleet (free tier §4): what opening the Sandbox or Fleet key
// learns about it. Client-safe: types and copy only.

/**
 * - `not_free`: nothing to do (not a Free account, or no account session): the page goes on as before.
 * - `unknown`: the plan couldn't be read, so whether it's Free isn't known.
 * - `ready`: the account's home fleet is in place. `changed`: this browser's
 *   fleet session now names a new fleet (re-check it). `cleared`: it replaced
 *   one retired after 30 idle days. `firstFleet`: the account had none before.
 * - `over_cap`: made over the day's sign-up cap; its Sandbox opens at `opensAt` (ISO).
 * - `failed`: couldn't be made now (an error, or the engine's new-fleet limit); try again.
 */
export type HomeFleetResult =
  | { kind: 'not_free' }
  | { kind: 'unknown' }
  | { kind: 'ready'; fleetId: string; changed: boolean; cleared: boolean; firstFleet: boolean }
  | { kind: 'over_cap'; opensAt: string }
  | { kind: 'failed' };

export const SANDBOX_OPEN_FAILED = 'Couldn’t open your Sandbox. Try again.';
export const SANDBOX_CLEARED = 'Your Sandbox was cleared after 30 days unused. This is a new one.';
export const SANDBOX_OPENING = 'Opening your Sandbox…';
