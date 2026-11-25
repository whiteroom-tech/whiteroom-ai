'use client';

import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { Hint } from '@whiteroom/ui';
import { HELP } from '@/lib/metric-definitions';
import { WATCH_DEFINITION } from '@/lib/diagnosis/copy';
import type { FleetDiagnosis } from '@/lib/whiteroom/types';
import { diagnosisSummary, type DiagnosisState, type StatusLine } from '@/lib/diagnosis/model';
import { HEALTH_READ_FAILED, HEALTH_ROW_CAP, healthByAgent } from '@/lib/agent-health';
import { pendingHealthRow, untrackedSignals, unusualRow } from '@/lib/performance-insights';
import { checkGroups, healthCounts, healthHeadline } from '@/lib/performance-overview';
import { Disclosure } from '@/app/(citadel)/performance/_components/primitives';
import { ROUTES } from '@/lib/routes';
import { fmtCount, plural } from '@/lib/format';
import { DayBars, flaggedRunCount, weekday, type FlaggedRuns } from './UnusualBehaviour';

// The two sources' own definitions, plus the one WhiteRoom word their detail uses.
const HINT = `${HELP.unusualBehaviour} Not tracked yet: ${untrackedSignals().join(', ').toLowerCase()}. ${HELP.agentHealthCheck} ${WATCH_DEFINITION}`;

const OK_ICON = <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none' }}><circle cx="9" cy="9" r="8" fill="none" stroke="var(--ok)" strokeWidth="1.5" /><path d="M5 9.2l2.6 2.6L13 6.5" fill="none" stroke="var(--ok)" strokeWidth="1.6" /></svg>;
const WARN_ICON = <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none' }}><circle cx="9" cy="9" r="8" fill="none" stroke="var(--warn)" strokeWidth="1.5" /><path d="M9 5v5M9 12.6v.1" fill="none" stroke="var(--warn)" strokeWidth="1.8" strokeLinecap="round" /></svg>;

/**
 * Agent health's heading, always on the page (the agent page links to it):
 * the title, the check's status line and its action when the check is on, and
 * the report download when there's anything to report on.
 */
export function AgentHealthHeader({ line, onCheck, onReport }: {
  /** The health check's status line (checked when, checking, failed); null when it's off. */
  line: StatusLine | null;
  onCheck: () => void;
  /** Download the health report; absent: no link. Resolves to an error message, or null. */
  onReport?: () => Promise<string | null>;
}) {
  const [report, setReport] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  return (
    <>
      <div className="wr-section-head">
        <div style={{ minWidth: 0 }}>
          <h2 id="agent-health-heading" tabIndex={-1} className="wr-section-head__title" style={{ display: 'inline-flex', alignItems: 'center' }}>Agent health<Hint text={HINT} /></h2>
          <p className="wr-section-head__sub">As of the last check. Flagged runs cover the last 7 days.</p>
        </div>
        <div className="wr-health__status wr-cap">
          {line && (
            <span aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: line.error ? 'var(--bad)' : undefined }}>
              {line.busy && <span className="dx-spin" aria-hidden />}
              <span>{line.text}</span>
              {line.action && <button type="button" className="wr-btn wr-btn--secondary wr-btn--h28" onClick={onCheck}>{line.action.label}</button>}
            </span>
          )}
          {onReport && (
            <button
              type="button" className="wr-link" disabled={report.busy}
              onClick={() => { setReport({ busy: true, error: null }); void onReport().then((error) => setReport({ busy: false, error }), () => setReport({ busy: false, error: 'The report couldn’t be made. Try again.' })); }}
            >{report.busy ? 'Preparing…' : 'Download report'}</button>
          )}
        </div>
      </div>
      {report.error && <p role="alert" className="wr-cap" style={{ margin: '0 0 8px', color: 'var(--bad)' }}>{report.error}</p>}
    </>
  );
}

/**
 * Agent health › problems by agent: what the checks and the run flags found,
 * as one top line each, then a row per agent with an open problem or a flagged
 * run. Each problem opens its own recommendation, where the fix is.
 */
export function HealthByAgent({ flagged, diagnosis, state, line, onOpenRec, onSelectAgent }: {
  flagged: FlaggedRuns;
  diagnosis: FleetDiagnosis | null;
  /** Where the health check's read stands: a failed read is said, never shown as nothing found. */
  state: DiagnosisState;
  line: StatusLine | null;
  onOpenRec: (recommendationId: string, agentId: string) => void;
  onSelectAgent: (agentId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const table = useMemo(() => healthByAgent(diagnosis, state, flagged), [diagnosis, state, flagged]);
  const count = flaggedRunCount(flagged);
  const summary = state === 'ready' ? diagnosisSummary(diagnosis) : null;
  const headline = summary ? healthHeadline(summary) : null;
  const failed = state === 'failed';
  // Before the first stored check, the check's own pending line; off, it says nothing.
  const pending = !summary && !failed ? pendingHealthRow(line) : null;
  const title = failed ? HEALTH_READ_FAILED : headline?.title ?? pending?.text ?? null;
  const flags = unusualRow({ count, atLeast: flagged.truncated, failed: flagged.failed });
  const problems = (summary?.openFindings ?? 0) > 0;
  const warn = problems || (count ?? 0) > 0;
  if (!title && !flags) return null;

  const rows = all ? table.rows : table.rows.slice(0, HEALTH_ROW_CAP);
  const cols = `wr-hba__row${table.showProblems ? '' : ' wr-hba__row--noproblems'}${table.showFlags ? '' : ' wr-hba__row--noflags'}`;

  return (
    <section aria-label="Problems by agent" className="wr-pcard wr-hba">
      <div role="status" className={`wr-hba__top${warn ? ' wr-hba__top--warn' : ''}`}>
        {title && (
          <span className="wr-hba__headline">
            {!failed && headline && (problems ? WARN_ICON : OK_ICON)}
            <span>
              <strong style={{ fontWeight: 600, color: problems ? 'var(--warn-tx)' : failed || !headline ? 'var(--tx2)' : 'var(--tx)' }}>{title}</strong>
              {headline?.sub && <span className="wr-cap" style={{ display: 'block' }}>{headline.sub}</span>}
            </span>
          </span>
        )}
        {flags && <span className="wr-cap" style={{ color: flags.tone === 'warn' ? 'var(--warn-tx)' : undefined, fontWeight: flags.tone === 'warn' ? 600 : undefined }}>{flags.text}</span>}
      </div>

      {rows.length > 0 && (
        <>
          <div className={`${cols} wr-hba__head wr-cap`} aria-hidden="true">
            <span>Agent</span>
            {table.showProblems && <span>Open problems</span>}
            {!table.showProblems && <span>Flagged for</span>}
            {table.showFlags && <span style={{ display: 'grid', whiteSpace: 'nowrap' }}><span>Flagged runs</span><span style={{ fontWeight: 400 }}>{weekday(flagged.days[0])} → today</span></span>}
            {table.showFlags && <span style={{ textAlign: 'right' }}>Runs</span>}
          </div>
          {rows.map((r) => (
            <div key={r.agentId} className={cols}>
              <button type="button" className="wr-agent-link wr-hba__agent" title={r.agentId} onClick={() => onSelectAgent(r.agentId)}>{r.agentId}</button>
              <div className="wr-hba__problems">
                {r.tags.length > 0 && (
                  <span className="wr-hba__tags">
                    {r.tags.map((t) => (
                      <button key={t.recommendationId} type="button" className="wr-hba__tag" aria-label={`${t.title}: see the fix`} onClick={() => onOpenRec(t.recommendationId, r.agentId)}>{t.title}</button>
                    ))}
                  </span>
                )}
                {r.checkState && <span className="wr-cap">{r.checkState}</span>}
                {r.flaggedFor && <span className="wr-cap" style={{ color: 'var(--tx3)' }}>{table.showProblems ? 'Flagged for: ' : ''}{r.flaggedFor}</span>}
              </div>
              {table.showFlags && (r.perDay
                ? <DayBars agentId={r.agentId} perDay={r.perDay} days={flagged.days} max={table.max} />
                : <span className="wr-cap" title="Not among the newest flagged runs read">—</span>)}
              {table.showFlags && (r.total
                ? <Link href={`${ROUTES.runs}?agent=${encodeURIComponent(r.agentId)}&show=flagged`} className="wr-link wr-hba__runs" aria-label={`${fmtCount(r.total, table.atLeast)} flagged ${plural(r.total, 'run', 'runs', table.atLeast)} for ${r.agentId}`}>{r.runsLabel} →</Link>
                : <span className="wr-cap wr-hba__runs">{r.total === 0 ? '0 runs' : '—'}</span>)}
            </div>
          ))}
          {table.rows.length > rows.length && (
            <p className="wr-hba__foot"><button type="button" className="wr-link" onClick={() => setAll(true)}>Show all {table.rows.length}</button></p>
          )}
        </>
      )}
      {flagged.runs && flagged.truncated && <p className="wr-hba__foot wr-cap">Showing the newest {fmtCount(flagged.runs.length)} flagged runs.</p>}
    </section>
  );
}

/**
 * Agent health › Health checks, folded: one row per check across agents,
 * problems first. Closed by default: each problem is already in the table
 * above, beside its fix.
 */
export function HealthChecks({ diagnosis }: { diagnosis: FleetDiagnosis | null }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const summary = diagnosisSummary(diagnosis);
  if (!diagnosis || !summary) return null;
  const groups = checkGroups(diagnosis);
  if (groups.length === 0) return null;

  return (
    <div className="wr-pcard wr-hck" style={{ overflow: 'hidden' }}>
      <Disclosure first label="Health checks" note={healthCounts(summary)} open={open} onToggle={() => setOpen((v) => !v)} controls={bodyId}>
        <div className="wr-hck__row wr-hck__head wr-cap" aria-hidden="true">
          <span>Check</span><span>Problem in</span><span>Passed</span><span>Waiting for</span>
        </div>
        {groups.map((g) => (
          <div key={g.title} className="wr-hck__row">
            <span>{g.title}</span>
            <span className="wr-agent-name" style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--warn-tx)' }}>{g.problemAgents.join(', ')}</span>
            <span className="wr-cap" style={{ color: g.passed ? 'var(--ok)' : undefined }}>
              {[g.passed ? `${g.passed} passed` : '', g.setAside ? `${g.setAside} set aside` : ''].filter(Boolean).join(' · ')}
            </span>
            <span className="wr-cap">
              {g.waiting.map((w) => <span key={w.note} style={{ display: 'block' }}>{w.note} · {w.agents} {plural(w.agents, 'agent')}</span>)}
            </span>
          </div>
        ))}
        {diagnosis.waiting.length > 0 && (
          <p className="wr-cap" style={{ margin: 0, padding: '10px 20px 14px' }}>
            Not checked yet: {diagnosis.waiting.map((w) => w.agentId).join(', ')} ({diagnosis.minCalls} calls a week needed).
          </p>
        )}
      </Disclosure>
    </div>
  );
}
