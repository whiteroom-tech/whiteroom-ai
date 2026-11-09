// getSandboxPlan (Free tier spec Part 1 §3.2, §3.3, §3.7): the account's own
// plan, only on a fleet it owns; Suspended's Choose a plan vs Talk to us; a
// pending invite's organization name; anything going wrong reads as today's page.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => vi.fn());
const fleetOwners = vi.hoisted(() => vi.fn());
const resolvePlan = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const buyable = vi.hoisted(() => ({ plans: [] as string[] }));
vi.mock('@/auth', () => ({ auth }));
vi.mock('@/lib/control-auth', () => ({ fleetOwners }));
vi.mock('@/lib/entitlements', () => ({ resolvePlan }));
vi.mock('@/lib/db', () => ({ db: () => ({ query }) }));
vi.mock('@/lib/plans', () => ({ purchasablePlans: () => buyable.plans }));

const { getSandboxPlan } = await import('@/lib/sandbox/sandbox-plan');
const OTHER = { plan: 'other', canBuy: false, invite: null };

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  fleetOwners.mockReset().mockResolvedValue(new Map([['prod-eu', 'u1']]));
  resolvePlan.mockReset().mockResolvedValue({ plan: 'free' });
  query.mockReset().mockResolvedValue({ rows: [] });
  buyable.plans = [];
});

describe('getSandboxPlan', () => {
  it('Free on its own fleet: the Free line, with the newest pending invite when there is one', async () => {
    expect(await getSandboxPlan('prod-eu')).toEqual({ plan: 'free', canBuy: false, invite: null });
    query.mockResolvedValue({ rows: [{ name: 'Acme Robotics' }] });
    expect(await getSandboxPlan('prod-eu')).toEqual({ plan: 'free', canBuy: false, invite: 'Acme Robotics' });
    expect(query.mock.calls[0][1]).toEqual(['u1']);
    expect(query.mock.calls[0][0]).toMatch(/status = 'invited'/);
  });

  it('a fleet another account owns (an organization’s): no plan lines, whatever the viewer’s plan', async () => {
    fleetOwners.mockResolvedValue(new Map([['prod-eu', 'owner-2']]));
    expect(await getSandboxPlan('prod-eu')).toEqual(OTHER);
    fleetOwners.mockResolvedValue(new Map());
    expect(await getSandboxPlan('prod-eu')).toEqual(OTHER);
    expect(query).not.toHaveBeenCalled();
  });

  it('Suspended: Choose a plan only when a plan can be bought; never an invite line', async () => {
    resolvePlan.mockResolvedValue({ plan: 'suspended' });
    expect(await getSandboxPlan('prod-eu')).toEqual({ plan: 'suspended', canBuy: false, invite: null });
    buyable.plans = ['starter'];
    expect(await getSandboxPlan('prod-eu')).toEqual({ plan: 'suspended', canBuy: true, invite: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('trial, paid and enterprise: today’s page', async () => {
    for (const plan of ['starter', 'pro', 'enterprise']) {
      resolvePlan.mockResolvedValue({ plan });
      expect(await getSandboxPlan('prod-eu')).toEqual(OTHER);
    }
  });

  it('signed out, no fleet, or any failure: today’s page', async () => {
    auth.mockResolvedValueOnce(null);
    expect(await getSandboxPlan('prod-eu')).toEqual(OTHER);
    expect(await getSandboxPlan('')).toEqual(OTHER);
    resolvePlan.mockRejectedValueOnce(new Error('db down'));
    expect(await getSandboxPlan('prod-eu')).toEqual(OTHER);
    query.mockRejectedValueOnce(new Error('db down'));
    expect(await getSandboxPlan('prod-eu')).toEqual(OTHER);
  });
});
