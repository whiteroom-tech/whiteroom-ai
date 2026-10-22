// A watch-face per agent row in the By-agent table (audit M12): three equal
// wedges (task success, cost diligence, speed), flat colors, the 0-10 score
// in the center — plus the same three numbers spelled out as small colored
// dots beside it, so the breakdown reads at a glance without hovering.
// No click handler — it's connected to the row it's already in.
import { FONT_MONO } from '@whiteroom/ui';
import { scoreColor, scoreWedges, wedgeSummary, wheelGradient } from '@/lib/agent-scores';
import type { AgentScore } from '@/lib/whiteroom/types';

const SIZE = 40;
const HOLE = 24;

export function AgentScoreWheel({ agent }: { agent: AgentScore }) {
  if (agent.score == null) return <span style={{ color: 'var(--tx3)', fontSize: 12 }}>–</span>;

  const wedges = scoreWedges(agent);
  return (
    <div role="img" aria-label={`Performance score ${agent.score} of 10 — ${wedgeSummary(wedges)}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <div
        title={wedgeSummary(wedges)}
        style={{ position: 'relative', width: SIZE, height: SIZE, borderRadius: '50%', background: wheelGradient(wedges), flexShrink: 0 }}
      >
        <div
          style={{
            position: 'absolute', top: (SIZE - HOLE) / 2, left: (SIZE - HOLE) / 2, width: HOLE, height: HOLE,
            borderRadius: '50%', background: 'var(--card)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700, color: scoreColor(agent.score), fontFamily: FONT_MONO,
          }}
        >
          {agent.score}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {wedges.map((w) => (
          <div key={w.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, lineHeight: 1 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: w.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--tx2)' }}>{w.value == null ? '–' : w.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
