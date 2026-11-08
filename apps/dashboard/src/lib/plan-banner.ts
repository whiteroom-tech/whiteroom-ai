'use server';

import { auth } from '@/auth';
import { db } from '@/lib/db';
import { fleetOwners } from '@/lib/control-auth';
import { graceEndsAtNow, resolvePlan } from '@/lib/entitlements';
import { effectivePlan, hasLiveSubscription, hasProductionAccess, isOnFreePeriod, purchasablePlans } from '@/lib/plans';
import { decidePlanState, needsGate, subscriptionEnded, type PlanState } from '@/lib/plan-banner-shared';
import { readGateState } from '@/lib/prod-gate';

/**
 * The signed-in account's plan banner and connect-line caveat (PlanState).
 * A light read for every page: the plan and billing rows and, only for a
 * Suspended account or the last days of a free period, the region's gate
 * (kept process-wide). Never the agent count or anything else
 * that asks WhiteRoom about fleets. `fleetId`: the fleet the page is showing,
 * so a member looking at a paid organization's fleet gets no plan banner.
 * Null when signed out; 'unknown' when it couldn't be read.
 */
export async function getPlanBanner(fleetId?: string | null): Promise<PlanState | null | 'unknown'> {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;
    const { plan, sub, trialEndsAt } = await resolvePlan(userId);
    const paidOrgFleet = typeof fleetId === 'string' && fleetId.length > 0 && fleetId.length <= 200 && await isPaidOrgFleet(userId, fleetId);
    const onTrial = isOnFreePeriod(plan, sub);
    const facts = { plan, onTrial, trialEndsAt };
    return decidePlanState({
      ...facts,
      billingStatus: hasLiveSubscription(sub) ? sub!.status : null,
      // A cancellation that runs out isn't a failed payment: Settings keeps its own line for that.
      graceEndsAt: sub?.cancelAtPeriodEnd ? null : graceEndsAtNow(sub),
      subscriptionEnded: subscriptionEnded(sub?.status),
      paidOrgFleet,
      // As Settings decides it: nothing self-serve on a comped plan or a contract.
      canBuy: purchasablePlans().length > 0 && plan !== 'enterprise' && !sub?.planOverride,
      gate: needsGate(facts) ? await readGateState() : 'unknown',
    });
  } catch (err) {
    console.error('[plan-banner] couldn\'t read the plan state:', err instanceof Error ? err.message : 'unknown error');
    return 'unknown';
  }
}

/**
 * Whether `fleetId` is another account's, in an organization this account
 * is an active member of, whose owner runs a paid plan or free period.
 */
async function isPaidOrgFleet(userId: string, fleetId: string): Promise<boolean> {
  const owner = (await fleetOwners([fleetId])).get(fleetId);
  if (!owner || owner === userId) return false;
  const { rows } = await db().query(
    `SELECT s.plan, s.status, s.plan_override, s.lapsed_at::text, u.trial_ends_at::text, u.trial_state
       FROM organization_members me
       JOIN organization_members holder ON holder.org_id = me.org_id AND holder.user_id = $2 AND holder.status = 'active'
       JOIN organization_members o ON o.org_id = me.org_id AND o.role = 'owner' AND o.status = 'active'
       JOIN users u ON u.id = o.user_id
       LEFT JOIN subscriptions s ON s.user_id = o.user_id
      WHERE me.user_id = $1 AND me.status = 'active'`,
    [userId, owner],
  );
  return rows.some((r) => hasProductionAccess(effectivePlan(
    r.plan ? { plan: r.plan, status: r.status, planOverride: r.plan_override, lapsedAt: r.lapsed_at } : null,
    { endsAt: r.trial_ends_at ?? null, state: r.trial_state ?? null },
  )));
}
