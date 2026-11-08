'use server';

import { auth } from '@/auth';
import { fleetOwners } from '@/lib/control-auth';
import { resolvePlan } from '@/lib/entitlements';
import { pendingInviteOrgName } from '@/lib/organizations';
import { purchasablePlans } from '@/lib/plans';
import { OTHER_PLAN, type SandboxPlanView } from './plan-view';

/**
 * The signed-in account's plan as the Sandbox shows it (plan-view.ts), for
 * the Sandbox of production fleet `fleet`. A fleet another account owns (an
 * organization's) shows no plan lines: its owner's plan applies there
 * (Part 1 §3.2, R9). Any failure reads as `other`, today's page.
 */
export async function getSandboxPlan(fleet: string): Promise<SandboxPlanView> {
  try {
    const userId = (await auth())?.user?.id;
    if (!userId || typeof fleet !== 'string' || !fleet) return OTHER_PLAN;
    const [owners, { plan }] = await Promise.all([fleetOwners([fleet]), resolvePlan(userId)]);
    if (owners.get(fleet) !== userId || (plan !== 'free' && plan !== 'suspended')) return OTHER_PLAN;
    if (plan === 'suspended') return { plan, canBuy: purchasablePlans().length > 0, invite: null };
    return { plan, canBuy: false, invite: await pendingInviteOrgName(userId) };
  } catch {
    return OTHER_PLAN;
  }
}
