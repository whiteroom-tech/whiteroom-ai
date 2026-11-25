// Replay (gap-closing spec C3): what a rule would have matched over past
// calls. Types for the engine's replay_get reply, and the words shown for it.

export type ReplayPartial =
  | { kind: 'dropped'; calls: number }
  | { kind: 'not_recorded'; gaps: number; calls: number }
  | { kind: 'tools_not_recorded'; calls: number }
  | { kind: 'record_limit'; limit: number }
  | { kind: 'time_limit'; minutes: number };

export interface ReplayResult {
  supported: true;
  records: number;
  evaluated: number;
  matched: number;
  partial: ReplayPartial[] | null;
}

export interface ReplayRun {
  id: string;
  status: 'running' | 'done' | 'failed';
  from: string;
  to: string;
  result: ReplayResult | null;
}

/** Rule types the engine can estimate. Others get no Estimate button. */
export const REPLAY_RULE_TYPES: ReadonlySet<string> = new Set(['model_allowlist', 'tool_list']);

export const REPLAY_DAYS = 7;

const calls = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'call' : 'calls'}`;

/** The estimate in one line, in the rule's own terms. */
export function replayLine(r: ReplayResult, ruleType: string = 'model_allowlist', days: number = REPLAY_DAYS): string {
  if (r.evaluated === 0) return `No calls in the last ${days} days to check.`;
  if (ruleType === 'tool_list') {
    if (r.matched === 0) return `In the last ${days} days, none of ${calls(r.evaluated)} asked an agent to run a tool on this list.`;
    return `In the last ${days} days, ${r.matched.toLocaleString('en-US')} of ${calls(r.evaluated)} asked an agent to run a tool on this list.`;
  }
  if (r.matched === 0) return `In the last ${days} days, all ${calls(r.evaluated)} used a model on this list.`;
  return `In the last ${days} days, ${r.matched.toLocaleString('en-US')} of ${calls(r.evaluated)} used a model not on this list.`;
}

/** What an estimate leaves out by design, said once under it; null when nothing. */
export function replayScopeNote(ruleType: string): string | null {
  return ruleType === 'tool_list' ? 'Counts tools your agents run themselves, not ones the provider runs, like web search.' : null;
}

/** Why the estimate is partial, in words; null when it isn't. Unknown kinds (a newer engine) still say Partial. */
export function partialLine(p: ReplayPartial[] | null): string | null {
  if (!p || p.length === 0) return null;
  const parts = p.map((x) => {
    switch (x.kind) {
      case 'dropped': return `${calls(x.calls)} weren’t stored`;
      case 'not_recorded': return x.calls > 0 ? `${calls(x.calls)} weren’t recorded` : 'some calls weren’t recorded';
      case 'tools_not_recorded': return `${calls(x.calls)} came before their tools were recorded`;
      case 'record_limit': return `only the first ${calls(x.limit)} were checked`;
      case 'time_limit': return 'it ran out of time';
      default: return null;
    }
  }).filter((s): s is string => s !== null);
  return parts.length ? `Partial: ${parts.join('; ')}.` : 'Partial.';
}
