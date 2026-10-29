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

export function preferProductionFleet(
  fleets: Array<{ fleetId: string }>,
): Array<{ fleetId: string }> {
  // A Sandbox fleet is never a production page's fleet: none at all rather than a sandbox- one.
  return fleets.filter((f) => !f.fleetId.startsWith('sandbox-'));
}
