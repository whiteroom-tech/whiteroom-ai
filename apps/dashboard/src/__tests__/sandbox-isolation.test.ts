// Sandbox fleets (sandbox-…) never reach the production side of the dashboard:
// not a production page's fleet, not billed, not counted toward the plan
// (Sandbox v2 spec §12 L2–L4).
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/auth', () => ({ auth: async () => null }));
const queries: string[] = [];
vi.mock('@/lib/db', () => ({ db: () => ({ query: async (sql: string) => { queries.push(sql); return { rows: [] }; } }) }));

const { loginFleet, preferProductionFleet, SANDBOX_KEY_MESSAGE } = await import('@/lib/fleet-helpers');
const { countAgents, fleetCountSql } = await import('@/lib/entitlements');
const { savingsByUtcDay } = await import('@/lib/savings-billing');
/** Every query that reads an account's fleets must leave Sandbox fleets out of both sources. */
const excludesSandbox = (sql: string) => (sql.match(/NOT LIKE 'sandbox-%'/g) ?? []).length >= 2;

describe('Sandbox fleets stay out of production', () => {
  it('a fleet key with only Sandbox fleets opens no production fleet', () => {
    expect(preferProductionFleet([{ fleetId: 'sandbox-1' }, { fleetId: 'prod-1' }])).toEqual([{ fleetId: 'prod-1' }]);
    expect(preferProductionFleet([{ fleetId: 'sandbox-1' }])).toEqual([]);
  });

  it('a fleet key with only Sandbox fleets says so at login, not "register an agent"', () => {
    expect(loginFleet([{ fleetId: 'sandbox-1' }])).toEqual({ error: SANDBOX_KEY_MESSAGE });
    expect(loginFleet([])).toEqual({ error: 'No fleets found for this fleet key. Register an agent first.' });
    expect(loginFleet([{ fleetId: 'sandbox-1' }, { fleetId: 'prod-1' }])).toEqual({ fleetId: 'prod-1' });
  });

  it('the plan count, the entitlement push and billing never read a Sandbox fleet', async () => {
    expect(excludesSandbox(fleetCountSql('u'))).toBe(true);
    queries.length = 0;
    await countAgents('u-1');
    await savingsByUtcDay('u-1', '2026-10-01');
    const fleetReads = queries.filter((q) => q.includes('user_fleets'));
    expect(fleetReads.length).toBeGreaterThanOrEqual(2);
    for (const q of fleetReads) expect(excludesSandbox(q)).toBe(true);
  });
});
