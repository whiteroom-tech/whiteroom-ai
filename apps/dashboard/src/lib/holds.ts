import type { AgentHold } from '@/lib/whiteroom/types';

/**
 * A hold that refuses calls, or null. The engine will record a resume as a
 * `none` tombstone (Phase 1 spec, rollout step 4); every screen treats
 * anything but paused or stopped as no hold, whatever the engine sends.
 */
export function activeHold(hold: AgentHold | { state: string } | null | undefined): AgentHold | null {
  return hold && (hold.state === 'paused' || hold.state === 'stopped') ? (hold as AgentHold) : null;
}

/** A fleet report's holds, keeping only those that refuse calls. */
export function activeHolds(holds: Record<string, AgentHold> | undefined): Record<string, AgentHold> | undefined {
  if (!holds) return holds;
  return Object.fromEntries(Object.entries(holds).filter(([, h]) => activeHold(h)));
}
