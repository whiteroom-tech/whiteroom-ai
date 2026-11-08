'use client';

import { PlanStatePreview } from '@/components/AccountPlanBanner';
import { planPreview } from './states';

/** Gives the page a fixed plan state (?plan=<name> from states.ts); without one, the page reads as usual. */
export function PlanPreview({ name, fleetKey, children }: { name: unknown; fleetKey?: boolean; children: React.ReactNode }) {
  const p = planPreview(name);
  if (!p) return children;
  return <PlanStatePreview.Provider value={{ state: p.state, goLive: p.goLive, fleetKey }}>{children}</PlanStatePreview.Provider>;
}
