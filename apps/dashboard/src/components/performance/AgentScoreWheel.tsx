// An agent's score as a small wheel (Home's agents, the agent page): three equal
// ring segments (clean calls, cost, speed) in their tier colors,
// the 0-10 score in the center, and a small legend that names each part with
// a bar and its value, so it reads without hovering. A part with no data is a
// faint track, not gray. No click handler: the row or card it sits in is the link.
import { FONT_MONO } from '@whiteroom/ui';
import { scoreColor, scoreWedges, wedgeStroke, wedgeSummary, wheelArcs } from '@/lib/agent-scores';
import type { AgentScore } from '@/lib/whiteroom/types';

const SIZE = 48;
const STROKE = 5;
const BAR = 56;

export function AgentScoreWheel({ agent }: { agent: AgentScore }) {
  if (agent.score == null) return <span style={{ color: 'var(--tx3)', fontSize: 'var(--fs-sm)' }}>—</span>;

  const wedges = scoreWedges(agent);
  const arcs = wheelArcs(wedges.length, SIZE, STROKE, 18);
  const summary = wedgeSummary(wedges);
  return (
    <div role="img" aria-label={`Performance score ${agent.score} of 10 — ${summary}`} title={summary} style={{ display: 'inline-flex', alignItems: 'center', gap: 14, verticalAlign: 'middle' }}>
      <span style={{ position: 'relative', width: SIZE, height: SIZE, flexShrink: 0 }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden style={{ display: 'block' }}>
          {wedges.map((w, i) => (
            <path key={w.label} d={arcs[i]} fill="none" strokeWidth={STROKE} strokeLinecap="round" stroke={wedgeStroke(w)} />
          ))}
        </svg>
        <span style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT_MONO, fontWeight: 700, color: scoreColor(agent.score),
        }}>
          <span style={{ fontSize: 'var(--fs-md)', lineHeight: 1 }}>{agent.score}</span>
        </span>
      </span>
      <span aria-hidden style={{ display: 'grid', gridTemplateColumns: `auto ${BAR}px auto`, alignItems: 'center', columnGap: 8, rowGap: 1, fontSize: 'var(--fs-xs)', lineHeight: 1.1, whiteSpace: 'nowrap' }}>
        {wedges.map((w) => (
          <span key={w.label} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--tx2)' }}>{w.short}</span>
            <span style={{ height: 4, borderRadius: 2, background: 'var(--track)', overflow: 'hidden' }}>
              {w.value != null && <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, w.value))}%`, borderRadius: 2, background: w.color }} />}
            </span>
            <span style={{ fontFamily: FONT_MONO, textAlign: 'right', color: w.value == null ? 'var(--tx3)' : 'var(--tx)' }}>{w.value == null ? '—' : w.value}</span>
          </span>
        ))}
      </span>
    </div>
  );
}
