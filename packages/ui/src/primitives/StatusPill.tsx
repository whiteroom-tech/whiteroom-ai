export type AgentState =
  | 'working' | 'resting' | 'idle' | 'paused' | 'stopped'
  | 'pausing' | 'stopping' | 'resuming'
  // What the engine reports today besides the five above.
  | 'handover' | 'stale' | 'disconnected';

// A dot and a word; colour is never the only signal (README › Status
// vocabulary). The pending states show while the engine hasn't confirmed a
// Pause, Stop or Resume yet (screen 11). Tooltips say what the state means
// for the customer, never how WhiteRoom works: a resting or handing-over
// agent reads as Waiting or Working like any other.
const STATES: Record<AgentState, { word: string; tone: 'ok' | 'muted' | 'warn'; dot: 'fill' | 'ring'; title: string }> = {
  working: { word: 'Working', tone: 'ok', dot: 'fill', title: 'Making calls right now.' },
  handover: { word: 'Working', tone: 'ok', dot: 'fill', title: 'Making calls right now.' },
  resting: { word: 'Waiting', tone: 'muted', dot: 'ring', title: 'Connected and waiting for work.' },
  idle: { word: 'Waiting', tone: 'muted', dot: 'ring', title: 'Connected and waiting for work.' },
  paused: { word: 'Paused', tone: 'warn', dot: 'fill', title: 'Paused by a person or a rule. Its calls are refused until someone resumes it.' },
  stopped: { word: 'Stopped', tone: 'warn', dot: 'fill', title: 'Stopped. It refuses every call until someone resumes it.' },
  pausing: { word: 'Pausing…', tone: 'muted', dot: 'ring', title: 'Waiting for WhiteRoom to confirm.' },
  stopping: { word: 'Stopping…', tone: 'muted', dot: 'ring', title: 'Waiting for WhiteRoom to confirm.' },
  resuming: { word: 'Resuming…', tone: 'muted', dot: 'ring', title: 'Waiting for WhiteRoom to confirm.' },
  stale: { word: 'Not reporting', tone: 'warn', dot: 'ring', title: 'WhiteRoom hasn’t heard from this agent recently.' },
  disconnected: { word: 'Disconnected', tone: 'muted', dot: 'ring', title: 'The agent’s connection to WhiteRoom dropped.' },
};

export function StatusPill({ state }: { state: AgentState }) {
  const s = STATES[state];
  return (
    <span className={`wr-pill wr-pill--${s.tone}`} title={s.title}>
      <span className={`wr-pill__dot wr-pill__dot--${s.dot}`} aria-hidden="true" />
      {s.word}
    </span>
  );
}
