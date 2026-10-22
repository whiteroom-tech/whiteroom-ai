// A watch-face per agent row in the By-agent table (audit M12): three equal
// ring segments (task success, cost diligence, speed) in their tier colors,
// the 0-10 score in the center, and a one-line legend that names each part
// so it reads without hovering. A part with no data is a faint track, not gray.
// No click handler — it's connected to the row it's already in.
import { FONT_MONO } from '@whiteroom/ui';
import { scoreColor, scoreWedges, wedgeSummary, wheelArcs } from '@/lib/agent-scores';
import type { AgentScore } from '@/lib/whiteroom/types';

const SIZE = 32;
const STROKE = 4;

export function AgentScoreWheel({ agent }: { agent: AgentScore }) {
  if (agent.score == null) return <span style={{ color: 'var(--tx3)', fontSize: 12 }}>–</span>;

  const wedges = scoreWedges(agent);
  const arcs = wheelArcs(wedges.length, SIZE, STROKE, 26);
  const summary = wedgeSummary(wedges);
  return (
    <div role="img" aria-label={`Performance score ${agent.score} of 10 — ${summary}`} title={summary} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span style={{ position: 'relative', width: SIZE, height: SIZE, flexShrink: 0 }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden style={{ display: 'block' }}>
          {wedges.map((w, i) => (
            <path key={w.label} d={arcs[i]} fill="none" strokeWidth={STROKE} strokeLinecap="round" stroke={w.value == null ? 'var(--track)' : w.color} />
          ))}
        </svg>
        <span style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: 700, color: scoreColor(agent.score),
        }}>{agent.score}</span>
      </span>
      <span aria-hidden style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5, whiteSpace: 'nowrap' }}>
        {wedges.map((w) => (
          <span key={w.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: w.value == null ? 'var(--track)' : w.color, boxShadow: w.value == null ? 'inset 0 0 0 1px var(--line2)' : undefined, flexShrink: 0 }} />
            <span style={{ color: 'var(--tx2)' }}>{w.short}</span>
            <span style={{ fontFamily: FONT_MONO, color: w.value == null ? 'var(--tx3)' : 'var(--tx)' }}>{w.value == null ? '–' : w.value}</span>
          </span>
        ))}
      </span>
    </div>
  );
}
