'use client';

import { useState, type ReactNode } from 'react';
import { FONT_MONO, Hint } from '@whiteroom/ui';
import { HELP } from '@/lib/metric-definitions';
import { WATCH_DEFINITION } from '@/lib/diagnosis/copy';
import type { FleetDiagnosis } from '@/lib/whiteroom/types';
import { checkRows, type CheckRow, type StatusLine } from '@/lib/diagnosis/model';
import { agentHealthView } from '@/lib/agent-health';
import { rowOpen, toggleChoice, untrackedSignals, type HealthRow } from '@/lib/performance-insights';
import { flaggedRunCount, UnusualDetails, type FlaggedRuns } from './UnusualBehaviour';

// The two sources' own definitions, plus the one WhiteRoom word their detail uses.
const HINT = `${HELP.unusualBehaviour} Streamed calls can\u2019t be checked for repeats. Not tracked yet: ${untrackedSignals().join(', ').toLowerCase()}. ${HELP.agentHealthCheck} ${WATCH_DEFINITION} Open a row for the detail.`;

const TONE: Record<HealthRow['tone'], string> = { ok: 'var(--tx)', warn: 'var(--warn-tx)', muted: 'var(--tx2)' };

/**
 * Performance › Agent health, beside Recommendations: the verdict, then one
 * line each for Unusual behaviour and the health check. A row unfolds for its
 * detail, and starts unfolded when it has a problem.
 */
export function AgentHealth({ flagged, diagnosis, line, onCheck, onReview }: {
  flagged: FlaggedRuns;
  diagnosis: FleetDiagnosis | null;
  /** The health check's status line (checked when, checking, failed); null when it's off. */
  line: StatusLine | null;
  onCheck: () => void;
  /** Jump to Recommendations, where each problem's fix is. */
  onReview: () => void;
}) {
  const view = agentHealthView({ count: flaggedRunCount(flagged), truncated: flagged.truncated, failed: flagged.failed, loading: flagged.loading }, diagnosis, line);
  if (!view) return null;
  const { verdict, unusual, health } = view;
  const warn = verdict?.tone === 'warn';

  return (
    <section aria-labelledby="agent-health-heading" className={`wr-health${warn ? ' wr-health--warn' : ''}`}>
      <div className="wr-health__head">
        <h3 id="agent-health-heading" style={{ margin: 0, fontSize: 14, fontWeight: 700, display: 'inline-flex', alignItems: 'center' }}>Agent health<Hint text={HINT} /></h3>
        {line && (
          <span aria-live="polite" className="wr-health__status" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: line.error ? 'var(--bad)' : 'var(--tx2)' }}>
            {line.busy && <span className="dx-spin" aria-hidden />}
            <span>{line.text}</span>
            {line.action && <button type="button" className="dx-link dx-strong" onClick={onCheck}>{line.action.label}</button>}
          </span>
        )}
      </div>

      {verdict && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px 4px' }}>
          <span aria-hidden style={{
            display: 'inline-flex', flex: 'none', width: 26, height: 26, borderRadius: '50%', alignItems: 'center', justifyContent: 'center',
            background: warn ? 'var(--warn-bg)' : 'var(--ok-bg)', color: warn ? 'var(--warn)' : 'var(--ok)',
          }}>
            {warn
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 7v6" /><path d="M12 17h.01" /></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
          </span>
          <span style={{ fontSize: 15.5, fontWeight: 700, color: warn ? 'var(--warn-tx)' : 'var(--tx)' }}>{verdict.title}</span>
        </div>
      )}

      <div className="wr-health__rows">
        {unusual && (
          <Row label="Unusual behaviour" row={unusual} open={view.unusualHasDetail}>
            {view.unusualHasDetail && <UnusualDetails flagged={flagged} />}
          </Row>
        )}
        {health && (
          <Row label="Health check" row={health} open={view.healthOpen}>
            {diagnosis && (diagnosis.reports.length > 0 || diagnosis.waiting.length > 0) && <CheckList data={diagnosis} onFix={onReview} />}
          </Row>
        )}
      </div>
    </section>
  );
}

/**
 * One line; with detail, a disclosure that starts open when it has news. Once
 * someone opens or closes it, that choice sticks until they change it, even
 * if new data changes the default.
 */
function Row({ label, row, open, children }: { label: string; row: HealthRow; open: boolean; children?: ReactNode }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const isOpen = rowOpen(chosen, open);
  const text = <span className="wr-health__text" style={{ color: TONE[row.tone], fontWeight: row.tone === 'warn' ? 600 : 400 }}>{row.text}</span>;
  if (!children) {
    return <div className="wr-health__row wr-health__row--plain"><span className="wr-health__label">{label}</span>{text}</div>;
  }
  return (
    <details open={isOpen} onToggle={(e) => setChosen((c) => toggleChoice(c, isOpen, e.currentTarget.open))} className="wr-health__row">
      <summary>
        <svg className="wr-health__chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="9 6 15 12 9 18" /></svg>
        <span className="wr-health__label">{label}</span>
        {text}
      </summary>
      <div className="wr-health__body">{children}</div>
    </details>
  );
}

const ICON: Record<CheckRow['tone'], { color: string; label: string; path: ReactNode }> = {
  problem: { color: 'var(--warn)', label: 'Problem', path: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4" /><path d="M12 16h.01" /></> },
  fine: { color: 'var(--ok)', label: 'Passed', path: <polyline points="20 6 9 17 4 12" /> },
  waiting: { color: 'var(--tx2)', label: 'Waiting for data', path: <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></> },
  'set-aside': { color: 'var(--tx2)', label: 'Set aside', path: <><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></> },
};

/** Health check, unfolded: one short row per check, per agent. */
function CheckList({ data, onFix }: { data: FleetDiagnosis; onFix: () => void }) {
  const agents = checkRows(data);
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 760 }}>
      {agents.map((a) => (
        <div key={a.agentId}>
          {agents.length > 1 && <div style={{ fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{a.agentId}</div>}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {a.rows.map((r, i) => (
              <li key={`${r.tone}-${r.title}-${i}`} style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '2px 10px', padding: '5px 0', fontSize: 13 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={ICON[r.tone].label} style={{ color: ICON[r.tone].color, flex: 'none', alignSelf: 'center' }}>{ICON[r.tone].path}</svg>
                <span style={{ color: r.tone === 'problem' ? 'var(--warn-tx)' : r.tone === 'set-aside' ? 'var(--tx2)' : 'var(--tx)', fontWeight: r.tone === 'problem' ? 600 : 400 }}>{r.title}</span>
                {r.note && <span style={{ color: 'var(--tx2)', fontSize: 12.5 }}>{r.note}</span>}
                {r.tone === 'problem' && <button type="button" className="dx-link dx-strong" onClick={onFix} style={{ fontSize: 12.5, minHeight: 24 }}>See the fix →</button>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {data.waiting.map((w) => (
        <p key={w.agentId} style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)' }}>
          <span style={{ fontFamily: FONT_MONO }}>{w.agentId}</span> isn&rsquo;t checked yet: {w.calls7d} of {data.minCalls} calls this week.
        </p>
      ))}
    </div>
  );
}
