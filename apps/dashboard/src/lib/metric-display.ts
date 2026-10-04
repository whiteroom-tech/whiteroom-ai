// How a figure reads when its source may have failed or be partial (dashboard
// audit M13, M16): unknown is "—" or "Unavailable", never a zero.

import { fmtCost, partialMark } from './format';
import { formatPrice, monthlyCostCents, type PlanId } from './plans';

/** A savings dollar figure: "—" when the savings couldn't be read, "+" when partly unpriced. */
export function savingsFigure(failed: boolean, micros: number, partial: boolean): string {
  return failed ? '—' : `${fmtCost(micros)}${partialMark(partial)}`;
}

/** The Settings plan stats about agents (M16), in display order. */
export function agentPlanStats(plan: PlanId, agents: number | null, billedAgents: number | null | undefined): Array<{ label: string; value: string }> {
  const out = [{ label: 'Agents registered', value: agents === null ? 'Unavailable' : String(agents) }];
  if (plan !== 'pro') return out;
  // Stripe's last confirmed quantity, which can lag a change in registered agents.
  if (billedAgents != null) out.push({ label: 'Billed for', value: `${billedAgents} agent${billedAgents === 1 ? '' : 's'}` });
  // From the live count: an estimate of the monthly rate, not an invoice.
  if (agents !== null) out.push({ label: 'Est. monthly', value: `${formatPrice(monthlyCostCents('pro', agents))}/mo` });
  return out;
}
