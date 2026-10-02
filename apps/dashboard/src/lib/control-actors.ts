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

function gap(a: string, b: string): number {
  const d = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Number.isFinite(d) ? d : Infinity;
}

/** The candidate closest in time to `at`, within the same-change window. */
function closest(rows: ControlActor[], at: string): ControlActor | undefined {
  let best: ControlActor | undefined;
  for (const r of rows) if (gap(r.at, at) <= SAME_CHANGE_MS && (!best || gap(r.at, at) < gap(best.at, at))) best = r;
  return best;
}

const HOLD_ACTION: Record<AgentHold['state'], string> = { paused: 'pause_agent', stopped: 'stop_agent' };

/** "by R Haque", "by a rule", or "from the dashboard" when the person isn't known. */
export function holdWho(hold: AgentHold, agentId: string, actions: ControlActor[]): string {
  if (hold.by.startsWith('rule:')) return 'by a rule';
  const row = closest(actions.filter((a) => a.agentId === agentId && a.action === HOLD_ACTION[hold.state]), hold.at);
  return row ? `by ${row.by}` : 'from the dashboard';
}

/** The person behind a rule-history entry, else the engine's own "by". */
export function historyWho(entry: { ruleId: string; time: string; by: string }, actions: ControlActor[]): string {
  if (entry.by !== 'dashboard') return entry.by;
  return closest(actions.filter((a) => a.ruleId === entry.ruleId), entry.time)?.by ?? entry.by;
}

/** The oldest time in a list, as ISO; undefined when empty. */
export function oldestTime(entries: { time: string }[]): string | undefined {
  const t = Math.min(...entries.map((e) => Date.parse(e.time)).filter(Number.isFinite));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Who acted on this fleet since `since` (default: the server's 30 days). Empty on any failure: the page then says "dashboard" as before. */
export async function fetchControlActors(fleetId: string, since?: string): Promise<ControlActor[]> {
  try {
    // A little before the oldest change on screen, so its row is inside the window.
    const from = since && Number.isFinite(Date.parse(since)) ? `&since=${encodeURIComponent(new Date(Date.parse(since) - SAME_CHANGE_MS).toISOString())}` : '';
    const res = await fetch(`/api/fleet/control-actions?fleet_id=${encodeURIComponent(fleetId)}${from}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return [];
    const data = (await res.json()) as { actions?: ControlActor[] };
    return Array.isArray(data.actions) ? data.actions : [];
  } catch {
    return [];
  }
}
