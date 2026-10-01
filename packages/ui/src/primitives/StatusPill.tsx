import { Icon, type IconName } from './icons';

export type AgentState = 'working' | 'resting' | 'idle' | 'paused' | 'stopped' | 'pausing' | 'stopping' | 'resuming';

// Icon and word always go together; color is never the only signal
// (README › Status vocabulary). The pending states show while the engine
// hasn't confirmed a Pause, Stop or Resume yet (screen 11).
const STATES: Record<AgentState, { word: string; icon: IconName; tone: string; title: string }> = {
  working: { word: 'Working', icon: 'play', tone: 'ok', title: 'Doing a task right now.' },
  resting: { word: 'Resting', icon: 'moon', tone: 'brand', title: 'A short planned break between shifts. It picks up again on its own.' },
  idle: { word: 'Idle', icon: 'clock', tone: 'muted', title: 'Connected, waiting for work.' },
  paused: { word: 'Paused', icon: 'pause', tone: 'warn', title: 'Held by a rule or a person. It makes no calls until someone resumes it.' },
  stopped: { word: 'Stopped', icon: 'square', tone: 'muted', title: 'It refuses every call until someone resumes it.' },
  pausing: { word: 'Pausing…', icon: 'clock', tone: 'muted', title: 'Waiting for WhiteRoom to confirm.' },
  stopping: { word: 'Stopping…', icon: 'clock', tone: 'muted', title: 'Waiting for WhiteRoom to confirm.' },
  resuming: { word: 'Resuming…', icon: 'clock', tone: 'muted', title: 'Waiting for WhiteRoom to confirm.' },
};

export function StatusPill({ state }: { state: AgentState }) {
  const s = STATES[state];
  return (
    <span className={`wr-pill wr-pill--${s.tone}`} title={s.title}>
      <Icon name={s.icon} size={11} strokeWidth={2.4} />
      {s.word}
    </span>
  );
}
