'use client';

/**
 * Agent Diagnosis inside the Performance page (spec Rev 4.4 §6.2). There is no
 * separate panel: findings are recommendations, so they render as richer rows
 * in the Recommendations card, with a status line in its header and a strip
 * under the metric cards when something is open.
 */
import { useState } from 'react';
import Link from 'next/link';
import { FONT_MONO } from '@whiteroom/ui';
import type { FleetDiagnosis, RecommendationDetail } from '@/lib/whiteroom/types';
import {
  TITLES, WATCH_DEFINITION, RULE_LABEL, STATUS_LABEL, MARKED_FIXED_TOAST,
  findingSentence, costLine, limitationText, howtoParagraphs, isDiagnosisDetector, type SentencePart,
} from '@/lib/diagnosis/copy';
import { attentionStrip, checkedSummary, evidenceHeader, type StatusLine } from '@/lib/diagnosis/model';

const MONO = { fontFamily: FONT_MONO, fontVariantNumeric: 'tabular-nums' } as const;

// -- §6.2.1 Attention strip -----------------------------------------------

export function AttentionStrip({ data, onSeeFindings }: { data: FleetDiagnosis | null; onSeeFindings: () => void }) {
  const strip = attentionStrip(data);
  if (!strip) return null;
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: '8px 12px', flexWrap: 'wrap', marginBottom: 24,
      background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', color: 'var(--warn-tx)',
      borderRadius: 10, padding: '10px 14px', fontSize: 13.5,
    }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--warn)', flex: 'none' }} />
      <span><b style={{ fontWeight: 600 }}>{strip.lead}</b>{strip.names && <> <span style={{ ...MONO, fontSize: 12.5 }}>{strip.names}</span></>}</span>
      <span aria-hidden>·</span>
      <button type="button" className="dx-link dx-strong" onClick={onSeeFindings}>See findings</button>
    </div>
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

function StatusBadge({ status }: { status: string }) {
  const open = status === 'open';
  const good = status === 'resolved' || status === 'reported_implemented';
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
      background: open ? 'var(--warn-bg)' : good ? 'var(--ok-bg)' : 'var(--sunk)',
      color: open ? 'var(--warn-tx)' : good ? 'var(--ok)' : 'var(--tx2)',
      border: `1px solid ${open ? 'var(--warn-line)' : 'var(--line2)'}`,
    }}>{STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}</span>
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
  const [notice, setNotice] = useState<string | null>(null);
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
        <StatusBadge status={rec.status} />
      </div>
      <Sentence parts={findingSentence(detector, m)} />
      {cost && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--warn-tx)' }}>{cost}</p>}
      {limitation && <p style={{ margin: 0, fontSize: 12, color: 'var(--tx2)' }}>{limitation}</p>}

      <div className="dx-acts" style={{ display: 'flex', alignItems: 'center', gap: '8px 16px', flexWrap: 'wrap', marginTop: 2 }}>
        {open && action?.kind === 'rule' && (
          <Link href={`/governance?rec=${encodeURIComponent(rec.id)}`} className="dx-main-btn" style={{
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
        {open && <button type="button" className="dx-link" disabled={busy} onClick={() => void onFeedback('snooze')}>Snooze 7 days</button>}
        {open && <button type="button" className="dx-link" disabled={busy} onClick={() => void onFeedback('dismiss')}>Dismiss</button>}
      </div>

      {open && action?.kind === 'howto' && (
        <div id={howId} hidden={!howOpen} style={{ borderLeft: '2px solid var(--line2)', padding: '4px 0 4px 12px', fontSize: 13, color: 'var(--tx2)', lineHeight: 1.55, maxWidth: '78ch' }}>
          {howtoParagraphs(action.howtoId, m).map((p, i) => <p key={i} style={{ margin: '0 0 6px' }}>{p}</p>)}
          <button type="button" className="dx-link dx-strong" disabled={busy} onClick={async () => {
            if (await onFeedback('implemented')) setNotice(MARKED_FIXED_TOAST);
          }}>Mark as fixed</button>
        </div>
      )}
      <div aria-live="polite" style={{ fontSize: 12, color: 'var(--tx2)' }}>{notice}</div>
      {error && <div style={{ fontSize: 11.5, color: 'var(--bad)' }}>{error}</div>}
    </article>
  );
}

// -- §6.2.4 What we checked -------------------------------------------------

export function WhatWeChecked({ data }: { data: FleetDiagnosis | null }) {
  if (!data || data.reports.length === 0) {
    if (!data || data.waiting.length === 0) return null;
  }
  const s = checkedSummary(data);
  return (
    <details style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <summary className="dx-summary" style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--tx2)' }}>
        What we checked · <span style={MONO}>{s.agents}</span> {s.agents === 1 ? 'agent' : 'agents'}
      </summary>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--tx2)', lineHeight: 1.5 }}>
        {s.nothingFound.length > 0 && <div><b style={{ color: 'var(--tx)', fontWeight: 600 }}>Nothing found:</b> <span style={MONO}>{s.nothingFound.join(', ')}</span>.</div>}
        {s.perAgent.map((a) => (
          <div key={a.agentId}>
            <span style={{ ...MONO, color: 'var(--tx)' }}>{a.agentId}</span>:
            {a.looksFine.length > 0 && <> <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Looks fine:</b> {a.looksFine.join(', ')}.</>}
            {a.needsData.map((n) => <span key={n.title}> <b style={{ color: 'var(--tx)', fontWeight: 600 }}>Needs more data:</b> {n.title} ({n.text.replace(/\.$/, '')}).</span>)}
          </div>
        ))}
        {s.waiting.map((w) => <div key={w.agentId}><b style={{ color: 'var(--tx)', fontWeight: 600 }}>Not checked yet:</b> <span style={MONO}>{w.agentId}</span>, {w.text}</div>)}
        <div style={{ fontSize: 12.5, borderTop: '1px dashed var(--line2)', paddingTop: 8 }}>{WATCH_DEFINITION}</div>
      </div>
    </details>
  );
}

// -- §6.2.5 Evidence header -------------------------------------------------

export function DiagnosisEvidence({ detector, calls, measures }: { detector: string; calls: Array<Record<string, unknown>>; measures: Record<string, unknown> }) {
  const h = evidenceHeader(detector, calls, measures);
  if (!h) return null;
  const box = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, marginBottom: 24 } as const;
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
