export function deriveDisplayStatus(
  status: string,
  stale?: boolean,
  minutesRemaining?: number,
  disconnected?: boolean,
): string {
  if (disconnected) return 'disconnected';
  if (stale) return 'stale';
  if (status === 'working' && minutesRemaining !== undefined && minutesRemaining <= 0) return 'idle';
  return status || 'idle';
}

export function resolveAuthKey(fleetToken: string | null): string | undefined {
  return fleetToken || undefined;
}

export function isApiKey(token: string): boolean {
  return token.startsWith('sk-');
}

export function buildCredentials(
  resolvedFleetId: string,
  resolvedFleetToken: string,
): { fleetId: string; fleetToken: string } {
  return { fleetId: resolvedFleetId, fleetToken: resolvedFleetToken };
}

/** A Sandbox fleet (sandbox-…): never a production page's fleet. */
export const isSandboxFleetId = (fleetId: string) => fleetId.startsWith('sandbox-');

/** What a Sandbox fleet's key or token gets on the production side: Sandbox data stays in Sandbox. */
export const SANDBOX_KEY_MESSAGE = 'That’s a Sandbox key. Open it from Sandbox, not here.';

/** The fleet a fleet key's login opens, or why none: no fleets at all, or only Sandbox ones. */
export function loginFleet(fleets: Array<{ fleetId: string }>): { fleetId: string } | { error: string } {
  const production = preferProductionFleet(fleets);
  if (production.length) return production[0];
  return { error: fleets.length ? SANDBOX_KEY_MESSAGE : 'No fleets found for this fleet key. Register an agent first.' };
}

export function preferProductionFleet(
  fleets: Array<{ fleetId: string }>,
): Array<{ fleetId: string }> {
  // A Sandbox fleet is never a production page's fleet: none at all rather than a sandbox- one.
  return fleets.filter((f) => !isSandboxFleetId(f.fleetId));
}
