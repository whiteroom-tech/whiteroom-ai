export function deriveDisplayStatus(status: string, stale?: boolean): string {
  return stale ? 'stale' : (status || 'idle');
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
