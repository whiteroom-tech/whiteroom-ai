// Sandbox fleets (sandbox-…) never reach the production side of the dashboard:
// not a production page's fleet, not billed, not counted toward the plan
// (Sandbox v2 spec §12 L2–L4).
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: async () => ({ rows: [] }) }) }));

const { preferProductionFleet } = await import('@/lib/fleet-helpers');
const { fleetCountSql } = await import('@/lib/entitlements');

describe('Sandbox fleets stay out of production', () => {
  it('a fleet key with only Sandbox fleets opens no production fleet', () => {
    expect(preferProductionFleet([{ fleetId: 'sandbox-1' }, { fleetId: 'prod-1' }])).toEqual([{ fleetId: 'prod-1' }]);
    expect(preferProductionFleet([{ fleetId: 'sandbox-1' }])).toEqual([]);
  });

  it('the plan count never includes a Sandbox fleet', () => {
    const sql = fleetCountSql('u');
    expect(sql.match(/NOT LIKE 'sandbox-%'/g)).toHaveLength(2);
  });
});
