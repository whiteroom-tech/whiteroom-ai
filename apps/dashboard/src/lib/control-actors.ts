// Naming the person behind a control change. The engine records every
// dashboard change as by "dashboard"; the dashboard keeps who it was
// (lib/control-actions.ts, served by /api/fleet/control-actions). These match
// an engine record to that row by target and time.

import type { AgentHold } from '@/lib/whiteroom/types';

export interface ControlActor {
  action: string;
  agentId: string | null;
  ruleId: string | null;
  by: string;
  at: string;
}

/** How far apart the engine's time and the dashboard's row can be and still be the same change. */
const SAME_CHANGE_MS = 2 * 60_000;

function near(a: string, b: string): boolean {
  const d = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Number.isFinite(d) && d <= SAME_CHANGE_MS;
}

const HOLD_ACTION: Record<AgentHold['state'], string> = { paused: 'pause_agent', stopped: 'stop_agent' };

/** "by R Haque", "by a rule", or "from the dashboard" when the person isn't known. */
export function holdWho(hold: AgentHold, agentId: string, actions: ControlActor[]): string {
  if (hold.by.startsWith('rule:')) return 'by a rule';
  const row = actions.find((a) => a.agentId === agentId && a.action === HOLD_ACTION[hold.state] && near(a.at, hold.at));
  return row ? `by ${row.by}` : 'from the dashboard';
}

/** The person behind a rule-history entry, else the engine's own "by". */
export function historyWho(entry: { ruleId: string; time: string; by: string }, actions: ControlActor[]): string {
  if (entry.by !== 'dashboard') return entry.by;
  return actions.find((a) => a.ruleId === entry.ruleId && near(a.at, entry.time))?.by ?? entry.by;
}

/** Who acted, for this fleet. Empty on any failure: the page then says "dashboard" as before. */
export async function fetchControlActors(fleetId: string): Promise<ControlActor[]> {
  try {
    const res = await fetch(`/api/fleet/control-actions?fleet_id=${encodeURIComponent(fleetId)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return [];
    const data = (await res.json()) as { actions?: ControlActor[] };
    return Array.isArray(data.actions) ? data.actions : [];
  } catch {
    return [];
  }
}
