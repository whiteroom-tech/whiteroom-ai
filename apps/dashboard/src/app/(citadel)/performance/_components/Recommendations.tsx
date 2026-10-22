'use client';

/**
 * Performance › Recommendations: what to look at, Open first. Presentational:
 * the page owns the list, its paging and the feedback calls.
 */
import { useState, type ReactNode } from 'react';
import type { RecommendationDetail } from '@/lib/whiteroom/types';
import { FONT_MONO } from '@whiteroom/ui';
import { fmtDay } from '@/lib/format';
import { SNOOZE_DAYS } from '@/lib/diagnosis/copy';
import { recCountSuffix, recEmptyText, recFeedback, recRowActions, recStatusLabel, type RecRowAction } from '@/lib/performance-insights';
import { Badge, Btn, CARD, H3 } from './primitives';
import { DiagnosisRow, isDiagnosisRow } from './Diagnosis';

export const REC_STATUSES = ['all', 'open', 'snoozed', 'dismissed', 'reported_implemented', 'resolved', 'evaluating', 'validated'] as const;

type Feedback = ReturnType<typeof recFeedback>;

export function RecommendationsCard({
  recs, total, status, onStatus, showStatuses, onShowStatuses, agentFilter, onAgentFilter, showAgentFilter, filtered, hasCalls,
  loading, error, notice, hasMore, onMore, onSelectAgent, onSelectEvidence, onFeedback, onDiagnosisFeedback, feedbackLoading, feedbackError,
}: {
  recs: RecommendationDetail[];
  total: number;
  status: string;
  onStatus: (s: string) => void;
  showStatuses: boolean;
  onShowStatuses: () => void;
  agentFilter: string;
  onAgentFilter: (v: string) => void;
  showAgentFilter: boolean;
  /** An agent filter is applied, so an empty list isn't "nothing to review". */
  filtered: boolean;
  hasCalls: boolean;
  loading: boolean;
  error: string | null;
  /** A note about the last health-check action ("Marked as fixed"). */
  notice: string | null;
  hasMore: boolean;
  onMore: () => void;
  onSelectAgent: (id: string) => void;
  onSelectEvidence: (findingId: string, agentId: string, recId?: string) => void;
  onFeedback: (rec: RecommendationDetail, f: Feedback) => void;
  onDiagnosisFeedback: (rec: RecommendationDetail, action: 'dismiss' | 'snooze' | 'implemented') => Promise<boolean>;
  feedbackLoading: string | null;
  feedbackError: { recId: string; message: string } | null;
}) {
  return (
    <>
    <div style={{ ...CARD, marginBottom: 0 }} id="recommendations">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={H3} id="recommendations-heading" tabIndex={-1}>
          Recommendations
          {total > 0 && <span style={{ marginLeft: 8, fontSize: 12.5, fontWeight: 500, color: 'var(--tx2)' }}><span style={{ fontFamily: FONT_MONO }}>{total}</span>{recCountSuffix(status)}</span>}
        </h3>
        {/* One agent: nothing to filter by. */}
        {showAgentFilter && <input aria-label="Filter by agent" value={agentFilter} onChange={e => onAgentFilter(e.target.value)} placeholder="Filter by agent..." style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--sunk)', color: 'var(--tx)', width: 160, outline: 'none' }} />}
      </div>
      <div aria-live="polite" style={{ fontSize: 12.5, color: 'var(--tx2)', margin: notice ? '0 0 8px' : 0 }}>{notice}</div>
      {showStatuses && <div role="group" aria-label="Show recommendations by status" style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {REC_STATUSES.map(st => (
          <button key={st} type="button" aria-pressed={status === st} onClick={() => onStatus(st)} style={{
            fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
            background: status === st ? 'var(--brand-dim)' : 'transparent',
            color: status === st ? 'var(--brand)' : 'var(--tx3)',
            border: `1px solid ${status === st ? 'var(--brand)' : 'var(--line)'}`,
          }}>{recStatusLabel(st)}</button>
        ))}
      </div>}

      {recs.length > 0 ? recs.map(rec => isDiagnosisRow(rec) ? (
        <DiagnosisRow
          key={rec.id}
          rec={rec}
          onSelectAgent={onSelectAgent}
          onSelectEvidence={() => onSelectEvidence(rec.currentFindingId ?? rec.id, rec.agentId, rec.id)}
          onFeedback={(action) => onDiagnosisFeedback(rec, action)}
          busy={feedbackLoading === rec.id}
          error={feedbackError?.recId === rec.id ? feedbackError.message : null}
        />
      ) : (
        <div key={rec.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                <button onClick={() => onSelectAgent(rec.agentId)} style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{rec.agentId}</button>
                <Badge status={rec.status} />
                <Badge status={rec.verificationStatus} size="small" />
              </div>
              <div style={{ fontSize: 12, color: 'var(--tx3)' }}>
                {rec.detector.replace(/_/g, ' ')} &middot; {fmtDay(rec.createdAt)}
                {rec.feedbackCount > 0 && <> &middot; {rec.feedbackCount} action{rec.feedbackCount !== 1 ? 's' : ''}</>}
              </div>
            </div>
            <RecActions
              open={rec.status === 'open'}
              busy={feedbackLoading === rec.id}
              onEvidence={() => onSelectEvidence(rec.currentFindingId ?? rec.id, rec.agentId, rec.id)}
              onFeedback={(f) => onFeedback(rec, f)}
            />
          </div>
          {feedbackError?.recId === rec.id && (
            <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 6, textAlign: 'right' }}>{feedbackError.message}</div>
          )}
          {rec.summary && <div style={{ fontSize: 12, color: 'var(--tx2)', marginTop: 6, paddingLeft: 2, lineHeight: 1.5 }}>{rec.summary}</div>}
        </div>
      )) : (
        <div style={{ color: 'var(--tx3)', fontSize: 13, textAlign: 'center', padding: 16 }}>
          {loading ? 'Loading…' : error ? 'Recommendations unavailable.' : recEmptyText(status, hasCalls, filtered)}
        </div>
      )}

      {!showStatuses && !error && (
        <button type="button" className="wr-link" onClick={onShowStatuses} style={{ background: 'none', border: 'none', padding: 0, marginTop: 12, minHeight: 24, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
          Show closed and other statuses
        </button>
      )}

      {error && (
        <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 12, marginTop: 8 }}>
          {error}
        </div>
      )}

      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button onClick={onMore} disabled={loading} style={{
            fontSize: 12, fontWeight: 600, padding: '6px 16px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer',
            background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid var(--brand)', opacity: loading ? 0.5 : 1,
          }}>{loading ? 'Loading…' : 'Load more'}</button>
        </div>
      )}

    </div>
    </>
  );
}

/** View evidence up front; the rest behind More, so each row has one clear action. */
function RecActions({ open, busy, onEvidence, onFeedback }: { open: boolean; busy: boolean; onEvidence: () => void; onFeedback: (f: Feedback) => void }) {
  const [more, setMore] = useState(false);
  const buttons: Record<RecRowAction, ReactNode> = {
    evidence: <Btn key="evidence" label="View evidence" onClick={onEvidence} loading={false} accent />,
    toggle: (
      <button key="toggle" type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} style={{
        fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
        background: 'transparent', color: 'var(--tx2)', border: '1px solid var(--line)',
      }}>{more ? 'Less' : 'More'}</button>
    ),
    fixed: <Btn key="fixed" label="Mark as fixed" onClick={() => onFeedback(recFeedback('fixed'))} loading={busy} />,
    snooze: <Btn key="snooze" label={`Snooze ${SNOOZE_DAYS} days`} onClick={() => onFeedback(recFeedback('snooze'))} loading={busy} />,
    dismiss: <Btn key="dismiss" label="Dismiss" onClick={() => onFeedback(recFeedback('dismiss'))} loading={busy} />,
  };
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {recRowActions(open, more).map((a) => buttons[a])}
    </div>
  );
}

