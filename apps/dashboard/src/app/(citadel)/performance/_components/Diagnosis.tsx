'use client';

/**
 * Agent Diagnosis on the Performance page. Its own card, under the metric
 * cards, says when agents were last checked, what's wrong or that nothing is,
 * and what each check found per agent. Findings are recommendations, so their
 * rows stay in the Recommendations card; "See findings" jumps there.
 */
import { useState } from 'react';
import Link from 'next/link';
import type { FleetDiagnosis, RecommendationDetail } from '@/lib/whiteroom/types';
import {
  TITLES, WATCH_DEFINITION, RULE_LABEL, STATUS_LABEL, SNOOZE_DAYS,
  findingSentence, costLine, limitationText, howtoParagraphs, isDiagnosisDetector, type SentencePart,
} from '@/lib/diagnosis/copy';
import { checkedSummary, diagnosisSummary, evidenceHeader, type StatusLine } from '@/lib/diagnosis/model';
import { MONO } from '@/lib/diagnosis/ui';
import { Badge, CARD } from './primitives';
import { ROUTES } from '@/lib/routes';
import { Hint } from '@whiteroom/ui';
import { HELP } from '@/lib/metric-definitions';

// -- The Agent Diagnosis card ---------------------------------------------

export function DiagnosisCard({ data, line, onCheck, onSeeFindings }: {
  data: FleetDiagnosis | null;
  line: StatusLine | null;
  onCheck: () => void;
  onSeeFindings: () => void;
}) {
  const summary = diagnosisSummary(data);
  // Hidden only when Diagnosis is off on the engine: no data and nothing running.
  if (!data && !line) return null;
  const warn = summary?.tone === 'warn';
  return (
    <section aria-labelledby="diagnosis-heading" style={{ ...CARD, marginBottom: 24, ...(warn ? { borderColor: 'var(--warn-line)' } : {}) }}>
      <h3 id="diagnosis-heading" style={{ fontSize: 15, fontWeight: 700, margin: 0, display: 'inline-flex', alignItems: 'center' }}>Agent health check<Hint text={HELP.agentHealthCheck} /></h3>
      <DiagnosisStatus line={line} onAction={onCheck} />
      {summary && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: '8px 12px', flexWrap: 'wrap', marginTop: 10, fontSize: 13.5,
          color: warn ? 'var(--warn-tx)' : 'var(--tx)',
        }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: warn ? 'var(--warn)' : 'var(--ok)', flex: 'none' }} />
          <span style={{ fontWeight: 600 }}>{summary.text}</span>
          {warn && <button type="button" className="dx-link dx-strong" onClick={onSeeFindings}>See findings</button>}
        </div>
      )}
      <WhatWeChecked data={data} />
    </section>
  );
}

// -- §6.2.2 Card header status line ---------------------------------------

export function DiagnosisStatus({ line, onAction }: { line: StatusLine | null; onAction: () => void }) {
  return (
    <div aria-live="polite" style={{ minHeight: line ? undefined : 0 }}>
      {line && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px 10px', flexWrap: 'wrap', margin: '10px 0 4px',
          padding: '9px 12px', borderRadius: 8, background: 'var(--sunk)', fontSize: 13,
          color: line.error ? 'var(--bad)' : 'var(--tx2)',
        }}>
          {line.busy && <span className="dx-spin" aria-hidden />}
          <span>{line.text}</span>
          {line.action && <button type="button" className="dx-link dx-strong" onClick={onAction}>{line.action.label}</button>}
        </div>
      )}
    </div>
  );
}

// -- §6.2.3 Diagnosis rows --------------------------------------------------

export function isDiagnosisRow(rec: RecommendationDetail): boolean {
  return isDiagnosisDetector(rec.detector) && !!rec.measures;
}

function Sentence({ parts }: { parts: SentencePart[] }) {
  return (
    <p style={{ fontSize: 14, lineHeight: 1.55, margin: 0, maxWidth: '80ch', color: 'var(--tx)' }}>
      {parts.map((p, i) => 'text' in p
        ? <span key={i}>{p.text}</span>
        : p.code
          ? <code key={i} style={{ ...MONO, fontSize: 12.5, background: 'var(--sunk)', padding: '1px 5px', borderRadius: 4 }}>{p.value}</code>
          : <span key={i} style={MONO}>{p.value}</span>)}
    </p>
  );
}

export function DiagnosisRow({ rec, onSelectAgent, onSelectEvidence, onFeedback, busy, error }: {
  rec: RecommendationDetail;
  onSelectAgent: (id: string) => void;
  onSelectEvidence: () => void;
  onFeedback: (action: 'dismiss' | 'snooze' | 'implemented') => Promise<boolean>;
  busy: boolean;
  error: string | null;
}) {
  const [howOpen, setHowOpen] = useState(false);
  if (!isDiagnosisDetector(rec.detector) || !rec.measures) return null;
  const detector = rec.detector;
  const m = rec.measures;
  const open = rec.status === 'open';
  const action = rec.suggestedAction;
  const cost = costLine(rec.estWastedTokens, rec.estWastedCostMicros);
  const limitation = limitationText(detector, rec.limitations);
  const howId = `how-${rec.id}`;
  const calls = rec.evidenceCount ?? 0;

  return (
    <article style={{ padding: '16px 0', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tx)' }}>{TITLES[detector]}</span>
        <button type="button" onClick={() => onSelectAgent(rec.agentId)} style={{ ...MONO, fontSize: 12.5, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>{rec.agentId}</button>
        <Badge status={rec.status} label={STATUS_LABEL[rec.status]} />
      </div>
      <Sentence parts={findingSentence(detector, m)} />
      {cost && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--warn-tx)' }}>{cost}</p>}
      {limitation && <p style={{ margin: 0, fontSize: 12, color: 'var(--tx2)' }}>{limitation}</p>}

      <div className="dx-acts" style={{ display: 'flex', gap: '8px 16px', flexWrap: 'wrap', marginTop: 2 }}>
        {open && action?.kind === 'rule' && (
          <Link href={`${ROUTES.controls}?rec=${encodeURIComponent(rec.id)}`} className="dx-main-btn" style={{
            display: 'inline-flex', alignItems: 'center', fontSize: 12.5, fontWeight: 600, padding: '6px 14px', borderRadius: 6,
            background: 'var(--brand)', color: 'var(--bg)', border: '1px solid var(--brand)', textDecoration: 'none',
          }}>Add {RULE_LABEL[action.rule]} in Watch</Link>
        )}
        {open && action?.kind === 'howto' && (
          <button type="button" className="dx-main-btn" aria-expanded={howOpen} aria-controls={howId} onClick={() => setHowOpen((v) => !v)} style={{
            fontSize: 12.5, fontWeight: 600, padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
            background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid var(--brand)',
          }}>{howOpen ? 'Hide how to fix' : 'How to fix'}</button>
        )}
        {calls > 0 && <button type="button" className="dx-link" onClick={onSelectEvidence}>See the {calls} calls</button>}
        {open && <button type="button" className="dx-link" disabled={busy} onClick={() => void onFeedback('snooze')}>Snooze {SNOOZE_DAYS} days</button>}
        {open && <button type="button" className="dx-link" disabled={busy} onClick={() => void onFeedback('dismiss')}>Dismiss</button>}
      </div>

      {open && action?.kind === 'howto' && (
        <div id={howId} hidden={!howOpen} style={{ borderLeft: '2px solid var(--line2)', padding: '4px 0 4px 12px', fontSize: 13, color: 'var(--tx2)', lineHeight: 1.55, maxWidth: '78ch' }}>
          {howtoParagraphs(action.howtoId, m).map((p, i) => <p key={i} style={{ margin: '0 0 6px' }}>{p}</p>)}
          <button type="button" className="dx-link dx-strong" disabled={busy} onClick={() => void onFeedback('implemented')}>Mark as fixed</button>
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: 11.5, color: 'var(--bad)' }}>{error}</div>}
    </article>
  );
}

// -- §6.2.4 What we checked -------------------------------------------------

export function WhatWeChecked({ data }: { data: FleetDiagnosis | null }) {
  // Open by default for a few agents, where it's short enough to read at a glance.
  const defaultOpen = (data?.reports.length ?? 0) <= 3;
  const [open, setOpen] = useState(defaultOpen);
  if (!data || data.reports.length === 0) return null;
  const agents = data.reports.length;
  return (
    <details open={defaultOpen} onToggle={(e) => setOpen(e.currentTarget.open)} style={{ paddingTop: 12 }}>
      <summary className="dx-summary" style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--tx2)' }}>
        What we checked · <span style={MONO}>{agents}</span> {agents === 1 ? 'agent' : 'agents'}
      </summary>
      {open && <CheckedDetails data={data} />}
    </details>
  );
}

function CheckedDetails({ data }: { data: FleetDiagnosis }) {
  const s = checkedSummary(data);
  const strong = { color: 'var(--tx)', fontWeight: 600 } as const;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, color: 'var(--tx2)', lineHeight: 1.5 }}>
      {s.nothingFound.length > 0 && <div><b style={strong}>Nothing found:</b> <span style={MONO}>{s.nothingFound.join(', ')}</span></div>}
      {s.perAgent.map((a) => (
        <div key={a.agentId}>
          <div style={{ ...MONO, ...strong }}>{a.agentId}</div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {a.looksFine.length > 0 && <li><b style={strong}>Looks fine:</b> {a.looksFine.join(', ')}</li>}
            {a.needsData.map((n) => <li key={n.title}><b style={strong}>Needs more data:</b> {n.title}, {n.text}</li>)}
          </ul>
        </div>
      ))}
      {s.waiting.map((w) => <div key={w.agentId}><b style={strong}>Not checked yet:</b> <span style={MONO}>{w.agentId}</span>, {w.text}</div>)}
      <div style={{ fontSize: 12.5, borderTop: '1px dashed var(--line2)', paddingTop: 8 }}>{WATCH_DEFINITION}</div>
    </div>
  );
}

// -- §6.2.5 Evidence header -------------------------------------------------

export function DiagnosisEvidence({ detector, calls, measures }: { detector: string; calls: Array<Record<string, unknown>>; measures: Record<string, unknown> }) {
  const h = evidenceHeader(detector, calls, measures);
  if (!h) return null;
  const box = CARD;
  const caption = <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx2)', marginBottom: 10 }}>{h.caption}</div>;
  if (h.kind === 'watches') {
    return (
      <div style={box}>
        {caption}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {h.watches.map((w) => (
            <span key={w.watch} style={{
              ...MONO, fontSize: 11, padding: '2px 6px', borderRadius: 4,
              border: `1px solid ${w.calls <= 2 ? 'var(--warn-line)' : 'var(--line2)'}`,
              background: w.calls <= 2 ? 'var(--warn-bg)' : 'transparent',
              color: w.calls <= 2 ? 'var(--warn-tx)' : 'var(--tx2)',
            }}>watch {w.watch} · {w.calls} {w.calls === 1 ? 'call' : 'calls'}</span>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div style={box}>
      {caption}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 420, borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr>{h.columns.map((c) => <th key={c} style={{ textAlign: 'left', fontSize: 11.5, fontWeight: 600, color: 'var(--tx2)', padding: '6px 8px', borderBottom: '1px solid var(--line)' }}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {h.rows.map((r, i) => (
              <tr key={i}>{r.map((cell, j) => <td key={j} style={{ padding: '6px 8px', borderBottom: '1px solid var(--line)', color: 'var(--tx)', ...(j > 0 ? MONO : {}) }}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {h.note && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--tx2)' }}>{h.note}</p>}
    </div>
  );
}
