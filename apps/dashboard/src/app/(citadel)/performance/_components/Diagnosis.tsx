'use client';

/**
 * Agent Diagnosis on the Performance page: its finding rows (in the
 * Recommendations card) and the evidence header. What each check found is
 * under Agent health › Health check.
 */
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { RecommendationDetail } from '@/lib/whiteroom/types';
import {
  TITLES, RULE_LABEL, STATUS_LABEL, SNOOZE_DAYS,
  findingSentence, costLine, limitationText, howtoParagraphs, isDiagnosisDetector, fixCheckLine, beforeFixText, linkedRuleLine, type SentencePart,
} from '@/lib/diagnosis/copy';
import { evidenceHeader } from '@/lib/diagnosis/model';
import { MONO } from '@/lib/diagnosis/ui';
import { Badge, CARD } from './primitives';
import { ROUTES } from '@/lib/routes';
import { plural } from '@/lib/format';

// -- §6.2.3 Diagnosis rows --------------------------------------------------

export function isDiagnosisRow(rec: RecommendationDetail): boolean {
  return isDiagnosisDetector(rec.detector) && !!rec.measures;
}

function Sentence({ parts }: { parts: SentencePart[] }) {
  return (
    <p style={{ fontSize: 'var(--fs-md)', lineHeight: 1.55, margin: 0, maxWidth: '80ch', color: 'var(--tx)' }}>
      {parts.map((p, i) => 'text' in p
        ? <span key={i}>{p.text}</span>
        : p.code
          ? <code key={i} style={{ ...MONO, fontSize: 'var(--fs-sm)', background: 'var(--sunk)', padding: '1px 5px', borderRadius: 4 }}>{p.value}</code>
          : <span key={i} style={MONO}>{p.value}</span>)}
    </p>
  );
}

export function DiagnosisRow({ rec, mark, onSelectAgent, onSelectEvidence, onFeedback, busy, error }: {
  rec: RecommendationDetail;
  /** A note above the title (why this row is first). */
  mark?: ReactNode;
  onSelectAgent: (id: string) => void;
  onSelectEvidence: () => void;
  onFeedback: (action: 'dismiss' | 'snooze' | 'implemented') => Promise<boolean>;
  busy: boolean;
  error: string | null;
}) {
  const [howOpen, setHowOpen] = useState(false);
  const [options, setOptions] = useState(false);
  if (!isDiagnosisDetector(rec.detector) || !rec.measures) return null;
  const detector = rec.detector;
  const m = rec.measures;
  const open = rec.status === 'open';
  const action = rec.suggestedAction;
  const cost = costLine(rec.estWastedTokens, rec.estWastedCostMicros);
  const limitation = limitationText(detector, rec.limitations);
  const howId = `how-${rec.id}`;
  const calls = rec.evidenceCount ?? 0;
  // A rule already made from this suggestion: say what it did, and link to it (its mode is changed there), in place of "Add … in Watch".
  const rule = action?.kind === 'rule' ? rec.linkedRule : undefined;
  const ruleLine = linkedRuleLine(rule);
  const fixLine = fixCheckLine(rec.fixCheck);
  const beforeFix = beforeFixText(detector, rec.fixCheck);

  return (
    <article id={`rec-${rec.id}`} tabIndex={-1} className="wr-rec">
      <div className="wr-rec__text">
      {mark}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ color: 'var(--tx)' }}>{TITLES[detector]}</strong>
        <button type="button" onClick={() => onSelectAgent(rec.agentId)} className="wr-agent-link">{rec.agentId}</button>
        {!open && <Badge status={rec.status} label={STATUS_LABEL[rec.status]} />}
      </div>
      <Sentence parts={findingSentence(detector, m)} />
      {cost && <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--warn-tx)' }}>{cost}</p>}
      {limitation && <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{limitation}</p>}
      {fixLine && <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: rec.fixCheck?.state === 'still_happening' ? 'var(--warn-tx)' : 'var(--tx2)' }}>{fixLine}</p>}
      {beforeFix && <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)', maxWidth: '80ch' }}>{beforeFix}</p>}
      {ruleLine && <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx)' }}>{ruleLine}</p>}
      </div>

      <div className="dx-acts wr-rec__acts">
        {open && action?.kind === 'rule' && !rule && (
          <Link href={`${ROUTES.controls}?rec=${encodeURIComponent(rec.id)}`} className="dx-main-btn" style={{
            display: 'inline-flex', alignItems: 'center', fontSize: 'var(--fs-sm)', fontWeight: 600, padding: '6px 14px', borderRadius: 6,
            background: 'var(--brand)', color: 'var(--bg)', border: '1px solid var(--brand)', textDecoration: 'none',
          }}>Add {RULE_LABEL[action.rule]} in Watch</Link>
        )}
        {open && rule && (
          <Link href={`${ROUTES.controls}?rule=${encodeURIComponent(rule.id)}`} className="dx-main-btn" style={{
            display: 'inline-flex', alignItems: 'center', fontSize: 'var(--fs-sm)', fontWeight: 600, padding: '6px 14px', borderRadius: 6,
            background: rule.mode === 'watch' ? 'var(--brand)' : 'var(--brand-dim)', color: rule.mode === 'watch' ? 'var(--bg)' : 'var(--brand)', border: '1px solid var(--brand)', textDecoration: 'none',
          }}>Open the rule</Link>
        )}
        {open && action?.kind === 'howto' && (
          <button type="button" className="dx-main-btn" aria-expanded={howOpen} aria-controls={howId} onClick={() => setHowOpen((v) => !v)} style={{
            fontSize: 'var(--fs-sm)', fontWeight: 600, padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
            background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid var(--brand)',
          }}>{howOpen ? 'Hide how to fix' : 'How to fix'}</button>
        )}
        {calls > 0 && <button type="button" className="wr-btn wr-btn--secondary wr-btn--h32 wr-btn--brand-outline" onClick={onSelectEvidence} aria-label={`See why: the ${calls} ${plural(calls, 'call')}`}>See why</button>}
        {open && <button type="button" className="wr-btn wr-btn--secondary wr-btn--h32" aria-expanded={options} onClick={() => setOptions((v) => !v)}>Options</button>}
        {open && options && <button type="button" className="dx-link" disabled={busy} onClick={() => void onFeedback('snooze')}>Snooze {SNOOZE_DAYS} days</button>}
        {open && options && <button type="button" className="dx-link" disabled={busy} onClick={() => void onFeedback('dismiss')}>Dismiss</button>}
      </div>

      {open && action?.kind === 'howto' && (
        <div id={howId} hidden={!howOpen} className="wr-rec__full" style={{ borderLeft: '2px solid var(--line2)', padding: '4px 0 4px 12px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)', lineHeight: 1.55, maxWidth: '78ch' }}>
          {howtoParagraphs(action.howtoId, m).map((p, i) => <p key={i} style={{ margin: '0 0 6px' }}>{p}</p>)}
          <button type="button" className="dx-link dx-strong" disabled={busy} onClick={() => void onFeedback('implemented')}>Mark as fixed</button>
        </div>
      )}
      {error && <div role="alert" className="wr-rec__full" style={{ fontSize: 'var(--fs-sm)', color: 'var(--bad)' }}>{error}</div>}
    </article>
  );
}

// -- §6.2.5 Evidence header -------------------------------------------------

export function DiagnosisEvidence({ detector, calls, measures }: { detector: string; calls: Array<Record<string, unknown>>; measures: Record<string, unknown> }) {
  const h = evidenceHeader(detector, calls, measures);
  if (!h) return null;
  const box = CARD;
  const caption = <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx2)', marginBottom: 10 }}>{h.caption}</div>;
  if (h.kind === 'watches') {
    return (
      <div style={box}>
        {caption}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {h.watches.map((w) => (
            <span key={w.watch} style={{
              ...MONO, fontSize: 'var(--fs-sm)', padding: '2px 6px', borderRadius: 4,
              border: `1px solid ${w.calls <= 2 ? 'var(--warn-line)' : 'var(--line2)'}`,
              background: w.calls <= 2 ? 'var(--warn-bg)' : 'transparent',
              color: w.calls <= 2 ? 'var(--warn-tx)' : 'var(--tx2)',
            }}>run {w.watch} · {w.calls} {plural(w.calls, 'call')}</span>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div style={box}>
      {caption}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 420, borderCollapse: 'collapse', fontSize: 'var(--fs-sm)' }}>
          <thead>
            <tr>{h.columns.map((c) => <th key={c} style={{ textAlign: 'left', fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx2)', padding: '6px 8px', borderBottom: '1px solid var(--line)' }}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {h.rows.map((r, i) => (
              <tr key={i}>{r.map((cell, j) => <td key={j} style={{ padding: '6px 8px', borderBottom: '1px solid var(--line)', color: 'var(--tx)', ...(j > 0 ? MONO : {}) }}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {h.note && <p style={{ margin: '8px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{h.note}</p>}
    </div>
  );
}
