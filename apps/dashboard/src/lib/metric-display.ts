// How a figure reads when its source may have failed or be partial (dashboard
// audit M13, M16): unknown is "—" or "Unavailable", never a zero.

import { formatPrice, monthlyCostCents, type PlanId } from './plans';
import { plural } from '@/lib/format';

/** The Settings plan stats about agents (M16), in display order. */
export function agentPlanStats(plan: PlanId, agents: number | null, billedAgents: number | null | undefined): Array<{ label: string; value: string }> {
  const out = [{ label: 'Agents registered', value: agents === null ? 'Unavailable' : String(agents) }];
  if (plan !== 'pro') return out;
  // Stripe's last confirmed quantity, which can lag a change in registered agents.
  if (billedAgents != null) out.push({ label: 'Billed for', value: `${billedAgents} ${plural(billedAgents, 'agent')}` });
  // From the live count: an estimate of the monthly rate, not an invoice.
  if (agents !== null) out.push({ label: 'Est. monthly', value: `${formatPrice(monthlyCostCents('pro', agents))}/mo` });
  return out;
}
