'use client';

import { useCallback, useState } from 'react';
import { usePoll } from '@/hooks/usePoll';
import { ScoreRing } from '@/components/agent/ScoreRing';
import { agentWeekFrom, loadWeekReads, WEEK_POLL_MS, type AgentWeek } from '@/lib/home-agents';
import { fmtTokens } from '@/lib/format';
import { RULE_ACTIVITY } from '@/lib/vocab';
import { outOfTen, scoreParts, scoreSummary, scoreWorking } from '@/lib/agent-scores';
import { weekRuleWords, weekTokens } from '@/lib/agent-detail';

const label = { fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx2)' } as const;
const cap = { fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)' } as const;
const figure = { fontSize: 'var(--fs-md)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' } as const;

/**
 * One agent's last 7 days: tokens with and without
 * WhiteRoom, rule activity and score, with how the score is worked out. The
 * same reads as Home's agent list. A part that has never loaded shows "—",
 * never 0; a refresh that fails keeps the last figures.
 */
export function AgentWeekCard({ fleetId, authKey, agentId, preview, hasTaskType = false, onSetTaskType }: {
  fleetId: string;
  authKey?: string;
  agentId: string;
  /** /dev/agent sample: nothing is fetched. */
  preview?: AgentWeek;
  /** Whether the agent has a task type; without one the Cost row offers to set it. */
  hasTaskType?: boolean;
  /** Takes the visitor to the Task type card. */
  onSetTaskType?: () => void;
}) {
  const [week, setWeek] = useState<AgentWeek | undefined>(preview);
  const [loaded, setLoaded] = useState(!!preview);
  const load = useCallback(async (stale: () => boolean) => {
    const { audit, scores, rules } = await loadWeekReads(fleetId, authKey, { agentId });
    if (stale()) return;
    // A read that failed keeps what loaded before; one that worked and doesn't mention the agent is none.
    setWeek((prev) => agentWeekFrom(prev, agentId, audit, scores, rules));
    setLoaded(true);
  }, [fleetId, authKey, agentId]);
  usePoll(load, { intervalMs: WEEK_POLL_MS, enabled: !!fleetId && !preview });

  const tokens = weekTokens(week);
  const score = week?.score;
  const rules = week?.rules;
  const dash = loaded ? '—' : '…';
  const parts = score ? scoreParts(score) : [];
  const working = scoreWorking(parts);
  const ruleWords = rules ? weekRuleWords(rules) : null;
  return (
    <section className="wr-panel wr-agent-week" aria-labelledby="agent-week">
      <div className="wr-agent-week__row">
        <h2 id="agent-week" className="wr-panel__title" style={{ margin: 0 }}>Last 7 days</h2>
        <span><span style={label}>Tokens without WhiteRoom, est.</span><br /><strong style={figure}>{tokens ? fmtTokens(tokens.without) : dash}</strong></span>
        <span>
          <span style={label}>With WhiteRoom</span><br />
          <strong style={figure}>{tokens ? fmtTokens(tokens.used) : dash}</strong>
          {tokens && tokens.saved > 0 && <span style={{ ...cap, color: 'var(--ok)' }}> {fmtTokens(tokens.saved)} less ({tokens.pct}%)</span>}
        </span>
        <span>
          <span style={label}>{RULE_ACTIVITY}</span><br />
          {ruleWords
            ? ruleWords.map((w, i) => <span key={w.word}>{i > 0 && <span style={cap}> · </span>}<strong style={figure}>{w.count}</strong> <span style={cap}>{w.word}</span></span>)
            : <strong style={figure}>{dash}</strong>}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {score?.score != null && <ScoreRing score={Math.round(score.score)} />}
          <span><span style={label}>Score</span><br />{score?.score != null ? <span style={{ ...cap, color: 'var(--tx)' }}>{Math.round(score.score)} out of 10</span> : <strong style={figure}>{dash}</strong>}</span>
        </span>
      </div>
      {score && (
        <details className="wr-disc">
          <summary>
            <span className="wr-disc__chev" aria-hidden="true">›</span>
            <span>How is the score worked out?</span>
            <span className="wr-disc__meta">{scoreSummary(parts)}</span>
          </summary>
          <div style={{ padding: '0 20px 18px' }}>
            <div className="wr-agent-week__scroll">
              <table className="wr-score-table">
                <thead><tr><th>Part</th><th className="is-num">Score</th><th>What it measures</th></tr></thead>
                <tbody>
                  {parts.map((p) => (
                    <tr key={p.label}>
                      <td>{p.label}</td>
                      <td className="is-num">{p.value == null ? <span style={cap}>not scored</span> : <><strong>{outOfTen(p.value)}</strong> <span style={cap}>of 10</span></>}</td>
                      <td>
                        {p.measures}
                        {p.value == null && (p.label === 'Cost' && !hasTaskType && onSetTaskType
                          ? <> <button type="button" className="wr-btn wr-btn--secondary wr-btn--h32" onClick={onSetTaskType}>Set a task type</button> to include it.</>
                          : p.missing ? ` ${p.missing}` : '')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {working && <p style={{ ...cap, margin: '10px 0 0' }}>The score is the average of the parts that have data, rounded: {working.sum}. Last 7 days.</p>}
          </div>
        </details>
      )}
    </section>
  );
}
