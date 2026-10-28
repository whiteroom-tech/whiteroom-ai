// How a figure reads when its source may have failed or be partial (dashboard
// audit M13, M16): unknown is "—" or "Unavailable", never a zero.

import { PLANS, shareCents, type PlanId } from './plans';

/**
 * The Settings Agents line (M16): the live count against the plan's included
 * agents. Soft: going over stops nothing, so `over` only adds the
 * talk-to-us note. Null on a plan that includes no number (Enterprise, and
 * an ended free period, which keeps its hard zero).
 */
export function agentsIncluded(plan: PlanId, agents: number | null): { value: string; over: boolean } | null {
  const included = PLANS[plan].limits.includedAgents;
  if (included === null) return null;
  if (agents === null) return { value: 'Unavailable', over: false };
  return { value: `${agents} of ${included} included`, over: agents > included };
}

/** "$12.34". */
export function fmtDollars(cents: number): string {
  return `$${(Math.floor(cents) / 100).toFixed(2)}`;
}

/**
 * "This month: $X saved · your share $Y" for a plan with a savings share,
 * "—" for both while the figure loads or can't be read. Null on a plan
 * without a share.
 */
export function monthShareLine(plan: PlanId, savedCents: number | null): string | null {
  if (!PLANS[plan].pricing) return null;
  if (savedCents === null) return 'This month: — saved · your share —';
  return `This month: ${fmtDollars(savedCents)} saved · your share ${fmtDollars(shareCents(plan, savedCents) ?? 0)}`;
}
