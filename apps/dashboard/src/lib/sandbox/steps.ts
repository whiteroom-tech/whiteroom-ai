// Which Sandbox step is current (first-run UX spec §6.1): Connect, Run your
// agent, or Results. Pure, so the page and the tests share it.

import type { CheckState } from './checks';

export type SandboxStep = 'connect' | 'run' | 'results';

export const SANDBOX_STEPS: readonly { id: SandboxStep; title: string }[] = [
  { id: 'connect', title: 'Connect' },
  { id: 'run', title: 'Run your agent' },
  { id: 'results', title: 'Results' },
];

/**
 * Connect until there's a Sandbox with a key (or while connecting a different
 * one), Results once the latest check has ended, Run your agent otherwise
 * (waiting for a first call, or a check in progress). A new check starting
 * moves Results back to Run.
 */
export function sandboxStepOf(o: { connected: boolean; replacing: boolean; checks: CheckState | null }): SandboxStep {
  if (!o.connected || o.replacing) return 'connect';
  return o.checks?.window?.endedAt ? 'results' : 'run';
}
