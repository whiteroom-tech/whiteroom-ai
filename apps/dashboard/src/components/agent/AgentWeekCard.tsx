'use client';

import { useCallback, useState } from 'react';
import { Button, ScoreRing } from '@whiteroom/ui';
import { usePoll } from '@/hooks/usePoll';
import { agentWeekFrom, loadWeekReads, WEEK_POLL_MS, type AgentWeek } from '@/lib/home-agents';
import { fmtTokens } from '@/lib/format';
import { RULE_ACTIVITY } from '@/lib/vocab';
import { outOfTen, scoreParts, scoreSummary, scoreWorking } from '@/lib/agent-scores';
import { weekRuleWords, weekTokens } from '@/lib/agent-detail';

const label = { fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx2)' } as const;
const cap = { fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)' } as const;
const figure = { fontSize: 'var(--fs-md)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' } as const;

/**
 * One agent's last 7 days: input with and without
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
    const { audit, scores, rules, agentCalls } = await loadWeekReads(fleetId, authKey, { agentId });
    if (stale()) return;
    // A read that failed keeps what loaded before; one that worked and doesn't mention the agent is none.
    setWeek((prev) => agentWeekFrom(prev, agentId, audit, scores, rules, agentCalls));
    setLoaded(true);
  }, [fleetId, authKey, agentId]);
  usePoll(load, { intervalMs: WEEK_POLL_MS, enabled: !!fleetId && !preview });

  const tokens = weekTokens(week);
  const score = week?.score;
  const rules = week?.rules;
  const dash = loaded ? '—' : '…';
  const parts = score ? scoreParts(score) : [];
  const working = scoreWorking(parts);
  // One score for the ring, the words and the worked sum: worked out from the
  // parts shown, else the engine's when no part has data.
  const shown = working?.score ?? (score?.score != null ? Math.round(score.score) : null);
  const ruleWords = rules ? weekRuleWords(rules) : null;
  return (
    <section className="wr-panel wr-agent-week" aria-labelledby="agent-week">
      <div className="wr-agent-week__row">
        <h2 id="agent-week" className="wr-panel__title" style={{ margin: 0 }}>Last 7 days</h2>
        <span><span style={label}>Input without WhiteRoom, est.</span><br /><strong style={figure}>{tokens ? fmtTokens(tokens.without) : dash}</strong></span>
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
          {shown != null && <ScoreRing score={shown} size={52} decorative />}
          <span><span style={label}>Score</span><br />{shown != null ? <span style={{ ...cap, color: 'var(--tx)' }}>{shown} out of 10</span> : <strong style={figure}>{dash}</strong>}</span>
        </span>
      </div>
      {score && (
        <details className="wr-agent-disc">
          <summary>
            <span className="wr-agent-disc__chev" aria-hidden="true">›</span>
            <span>How is the score worked out?</span>
            <span className="wr-agent-disc__meta">{scoreSummary(parts)}</span>
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
                          ? <> <Button onClick={onSetTaskType}>Set a task type</Button> to include it.</>
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
