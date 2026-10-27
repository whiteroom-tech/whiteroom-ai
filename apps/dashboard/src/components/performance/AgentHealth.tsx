'use client';

import { useId, useState, type ReactNode } from 'react';
import { Hint } from '@whiteroom/ui';
import { HELP } from '@/lib/metric-definitions';
import { WATCH_DEFINITION } from '@/lib/diagnosis/copy';
import type { FleetDiagnosis } from '@/lib/whiteroom/types';
import { diagnosisSummary, type StatusLine } from '@/lib/diagnosis/model';
import { agentHealthView } from '@/lib/agent-health';
import { rowOpen, toggleChoice, untrackedSignals, type HealthRow } from '@/lib/performance-insights';
import { checkGroups, healthCounts, healthHeadline } from '@/lib/performance-overview';
import { Disclosure } from '@/app/(citadel)/performance/_components/primitives';
import { flaggedRunCount, UnusualDetails, type FlaggedRuns } from './UnusualBehaviour';

// The two sources' own definitions, plus the one WhiteRoom word their detail uses.
const HINT = `${HELP.unusualBehaviour} Streamed calls can’t be checked for repeats. Not tracked yet: ${untrackedSignals().join(', ').toLowerCase()}. ${HELP.agentHealthCheck} ${WATCH_DEFINITION}`;

const TONE: Record<HealthRow['tone'], string> = { ok: 'var(--tx)', warn: 'var(--warn-tx)', muted: 'var(--tx2)' };

const OK_ICON = <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none' }}><circle cx="9" cy="9" r="8" fill="none" stroke="var(--ok)" strokeWidth="1.5" /><path d="M5 9.2l2.6 2.6L13 6.5" fill="none" stroke="var(--ok)" strokeWidth="1.6" /></svg>;
const WARN_ICON = <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none' }}><circle cx="9" cy="9" r="8" fill="none" stroke="var(--warn)" strokeWidth="1.5" /><path d="M9 5v5M9 12.6v.1" fill="none" stroke="var(--warn)" strokeWidth="1.8" strokeLinecap="round" /></svg>;

/**
 * Performance › Agent health, beside Recommendations: what the health checks
 * found, as one headline; the Unusual behaviour line; and the checks folded
 * below, one row per check across agents.
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
  const [checksOpen, setChecksOpen] = useState<boolean | null>(null);
  const checksId = useId();
  if (!view) return null;
  const summary = diagnosisSummary(diagnosis);
  const headline = summary ? healthHeadline(summary) : null;
  // Before the first stored check: the verdict from flags, or the check's own pending line.
  const title = headline?.title ?? view.verdict?.title ?? view.health?.text ?? null;
  const warn = headline ? headline.tone === 'warn' : view.verdict?.tone === 'warn' || view.health?.tone === 'warn';
  const groups = diagnosis && summary ? checkGroups(diagnosis) : [];
  const open = rowOpen(checksOpen, view.healthOpen);

  return (
    <section aria-labelledby="agent-health-heading" className={`wr-pcard wr-health${warn ? ' wr-health--warn' : ''}`}>
      <div className="wr-health__head">
        <h3 id="agent-health-heading" className="wr-pcard__title" style={{ display: 'inline-flex', alignItems: 'center' }}>Agent health<Hint text={HINT} /></h3>
        {line && (
          <span aria-live="polite" className="wr-health__status wr-cap" style={{ color: line.error ? 'var(--bad)' : undefined }}>
            {line.busy && <span className="dx-spin" aria-hidden />}
            <span>{line.text}</span>
            {line.action && <button type="button" className="wr-btn wr-btn--secondary wr-btn--h28" onClick={onCheck}>{line.action.label}</button>}
          </span>
        )}
      </div>

      {title && (
        <div role="status" className="wr-health__summary">
          {warn ? WARN_ICON : OK_ICON}
          <span>
            <strong style={{ color: warn ? 'var(--warn-tx)' : 'var(--tx)' }}>{title}</strong>
            {headline?.sub && <span className="wr-cap" style={{ display: 'block' }}>{headline.sub}</span>}
            {warn && summary && summary.openFindings > 0 && <button type="button" className="wr-link wr-health__fix" onClick={onReview}>See the fix in Recommendations →</button>}
          </span>
        </div>
      )}

      {view.unusual && (
        <UnusualRow row={view.unusual} open={view.unusualHasDetail}>
          {view.unusualHasDetail && <UnusualDetails flagged={flagged} />}
        </UnusualRow>
      )}

      {summary && groups.length > 0 && (
        <Disclosure label="Health checks" note={healthCounts(summary)} open={open} onToggle={() => setChecksOpen(!open)} controls={checksId}>
          <div className="wr-health__checks">
            {groups.map((g) => (
              <div key={g.title} className="wr-health__check">
                <span>{g.title}</span>
                <span className="wr-cap" style={{ color: g.tone === 'problem' ? 'var(--warn-tx)' : g.tone === 'ok' ? 'var(--ok)' : 'var(--tx2)', fontWeight: g.tone === 'problem' ? 600 : undefined }}>
                  {g.status}{g.problemAgents.length > 0 && <> · <span className="wr-agent-name">{g.problemAgents.join(', ')}</span></>}
                </span>
              </div>
            ))}
            {diagnosis!.waiting.length > 0 && (
              <p className="wr-cap" style={{ margin: '8px 0 0' }}>
                Not checked yet: {diagnosis!.waiting.map((w) => w.agentId).join(', ')} ({diagnosis!.minCalls} calls a week needed).
              </p>
            )}
          </div>
        </Disclosure>
      )}
    </section>
  );
}

/**
 * Unusual behaviour's line. With detail (runs were flagged) it folds out, and
 * starts open; once someone opens or closes it, that choice sticks.
 */
export function UnusualRow({ row, open, children }: { row: HealthRow; open: boolean; children?: ReactNode }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const isOpen = rowOpen(chosen, open);
  const text = <span className="wr-health__text" style={{ color: TONE[row.tone], fontWeight: row.tone === 'warn' ? 600 : 400 }}>{row.text}</span>;
  if (!children) {
    return <div className="wr-health__row wr-health__row--plain"><span className="wr-health__label wr-cap">Unusual behaviour</span>{text}</div>;
  }
  return (
    <details open={isOpen} onToggle={(e) => { const nowOpen = e.currentTarget.open; setChosen((c) => toggleChoice(c, isOpen, nowOpen)); }} className="wr-health__row">
      <summary>
        <span className="wr-health__label wr-cap">Unusual behaviour</span>
        {text}
      </summary>
      <div className="wr-health__body">{children}</div>
    </details>
  );
}
