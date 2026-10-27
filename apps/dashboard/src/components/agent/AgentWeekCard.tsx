'use client';

import { useCallback, useState } from 'react';
import { FONT_MONO } from '@whiteroom/ui';
import { auditSummary, performanceAgentScores, ruleActions } from '@/lib/whiteroom/client';
import { usePoll } from '@/hooks/usePoll';
import { AgentScoreWheel } from '@/components/performance/AgentScoreWheel';
import { localDay } from '@/lib/runs';
import { agentWeekFrom, shortTokens, type AgentWeek } from '@/lib/home-agents';
import { scoreParts } from '@/lib/agent-scores';
import { tallyShort, tallyTotal } from '@/lib/governance';
import { weekTokens } from '@/lib/agent-detail';

const label = { fontSize: 'var(--fs-sm)', color: 'var(--tx2)' } as const;
const figure = { fontFamily: FONT_MONO, fontSize: 'var(--fs-xl)', fontWeight: 600 } as const;

/**
 * One agent's last 7 days (redesign screen 3): tokens with and without
 * WhiteRoom, rule activity and score, with how the score is worked out. The
 * same reads as Home's agent list. A part that has never loaded shows "—",
 * never 0; a refresh that fails keeps the last figures.
 */
export function AgentWeekCard({ fleetId, authKey, agentId, preview }: {
  fleetId: string;
  authKey?: string;
  agentId: string;
  /** /dev/agent sample: nothing is fetched. */
  preview?: AgentWeek;
}) {
  const [week, setWeek] = useState<AgentWeek | undefined>(preview);
  const [loaded, setLoaded] = useState(!!preview);
  const load = useCallback(async (stale: () => boolean) => {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 6);
    // Whole UTC hours back to the hour holding local midnight six days ago, as on Home.
    const HOUR = 3_600_000;
    const hours = (Math.floor(Date.now() / HOUR) + 1) - Math.floor(start.getTime() / HOUR);
    const [audit, scores, rules] = await Promise.all([
      auditSummary(fleetId, start, authKey).catch(() => null),
      performanceAgentScores(fleetId, hours, authKey).catch(() => null),
      ruleActions(fleetId, { fromDay: localDay(start.getTime()), toDay: localDay() }, authKey).catch(() => null),
    ]);
    if (stale()) return;
    // A read that failed keeps what loaded before; one that worked and doesn't mention the agent is none.
    setWeek((prev) => agentWeekFrom(prev, agentId, audit, scores, rules));
    setLoaded(true);
  }, [fleetId, authKey, agentId]);
  usePoll(load, { intervalMs: 60_000, enabled: !!fleetId && !preview });

  const tokens = weekTokens(week);
  const score = week?.score;
  const rules = week?.rules;
  const dash = loaded ? '—' : '…';
  return (
    <section className="wr-panel" aria-labelledby="agent-week" style={{ overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 40px', alignItems: 'center', padding: '16px 20px' }}>
        <h2 id="agent-week" className="wr-panel__title" style={{ margin: 0 }}>Last 7 days</h2>
        <span><span style={label}>Tokens without WhiteRoom, est.</span><br /><strong style={figure}>{tokens ? shortTokens(tokens.without) : dash}</strong></span>
        <span>
          <span style={label}>With WhiteRoom</span><br />
          <strong style={figure}>{tokens ? shortTokens(tokens.used) : dash}</strong>
          {tokens && tokens.saved > 0 && <span style={{ ...label, color: 'var(--ok)' }}> {shortTokens(tokens.saved)} less ({tokens.pct}%)</span>}
        </span>
        <span>
          <span style={label}>Rule activity</span><br />
          {rules && tallyTotal(rules) > 0
            ? <strong style={{ fontSize: 'var(--fs-md)', fontWeight: 600 }}>{tallyShort(rules)}</strong>
            : <strong style={figure}>{rules ? '0' : dash}</strong>}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {score ? <AgentScoreWheel agent={score} /> : <span><span style={label}>Score</span><br /><strong style={figure}>{dash}</strong></span>}
        </span>
      </div>
      {score && (
        <details style={{ borderTop: '1px solid var(--line)' }}>
          <summary style={{ padding: '12px 20px', cursor: 'pointer', fontSize: 'var(--fs-md)' }}>
            How is the score worked out?
          </summary>
          <div style={{ padding: '0 20px 18px' }}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
              {scoreParts(score).map((p) => (
                <li key={p.label} style={{ display: 'grid', gap: 2 }}>
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                    <strong style={{ fontWeight: 600 }}>{p.label}</strong>
                    {p.value == null ? <span style={label}>not scored</span> : <span><strong style={{ fontFamily: FONT_MONO }}>{p.value}</strong> <span style={label}>of 100</span></span>}
                  </span>
                  <span style={label}>{p.measures}{p.value == null && p.missing ? ` ${p.missing}` : ''}</span>
                </li>
              ))}
            </ul>
            <p style={{ ...label, margin: '10px 0 0' }}>The score out of 10 is the average of the parts that have data. Last 7 days.</p>
          </div>
        </details>
      )}
    </section>
  );
}
