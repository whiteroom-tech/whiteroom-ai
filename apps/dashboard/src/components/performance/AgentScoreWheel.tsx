// A small, static watch-face per agent row in the By-agent table (audit
// M12): three equal wedges (task success, cost diligence, speed), flat
// colors, the 0-10 score in the center. No needle, no click handler — it's
// connected to the row it's already in, not a separate drill-down.
import { scoreColor, scoreWedges, wedgeSummary, wheelGradient } from '@/lib/agent-scores';
import type { AgentScore } from '@/lib/whiteroom/types';

const SIZE = 28;
const HOLE = 16;

export function AgentScoreWheel({ agent }: { agent: AgentScore }) {
  if (agent.score == null) return <span style={{ color: 'var(--tx3)', fontSize: 12 }}>–</span>;

  const wedges = scoreWedges(agent);
  return (
    <div
      role="img"
      aria-label={`Performance score ${agent.score} of 10`}
      title={wedgeSummary(wedges)}
      style={{ position: 'relative', width: SIZE, height: SIZE, borderRadius: '50%', background: wheelGradient(wedges), flexShrink: 0 }}
    >
      <div
        style={{
          position: 'absolute', top: (SIZE - HOLE) / 2, left: (SIZE - HOLE) / 2, width: HOLE, height: HOLE,
          borderRadius: '50%', background: 'var(--card)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9.5, fontWeight: 700, color: scoreColor(agent.score),
        }}
      >
        {agent.score}
      </div>
    </div>
  );
}
