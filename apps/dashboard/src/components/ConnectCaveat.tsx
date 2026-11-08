import { CAVEAT, type PlanState } from '@/lib/plan-banner-shared';

/** The line under a connect line that can't work yet (Free; Suspended once the gate is on), or nothing. Home and Fleet key. */
export function ConnectCaveat({ caveat }: { caveat: PlanState['caveat'] | undefined }) {
  if (!caveat) return null;
  return <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{CAVEAT[caveat]}</p>;
}
