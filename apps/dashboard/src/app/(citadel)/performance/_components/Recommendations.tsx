'use client';

/**
 * Performance › Recommendations: what to look at, Open first. Presentational:
 * the page owns the list, its paging and the feedback calls.
 */
import { useState, type ReactNode } from 'react';
import type { RecommendationDetail } from '@/lib/whiteroom/types';
import { FONT_MONO, SegmentedControl } from '@whiteroom/ui';
import { fmtDay } from '@/lib/format';
import { SNOOZE_DAYS } from '@/lib/diagnosis/copy';
import { recCountSuffix, recEmptyText, recFeedback, recRowActions, recStatusLabel, recTitle, type RecRowAction } from '@/lib/performance-insights';
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
    <div style={{ ...CARD, marginBottom: 0 }} id="recommendations">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={H3} id="recommendations-heading" tabIndex={-1}>
          Recommendations
          {total > 0 && <span style={{ marginLeft: 8, fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)' }}><span style={{ fontFamily: FONT_MONO }}>{total}</span>{recCountSuffix(status)}</span>}
        </h3>
        {/* One agent: nothing to filter by. */}
        {showAgentFilter && <input aria-label="Filter by agent" value={agentFilter} onChange={e => onAgentFilter(e.target.value)} placeholder="Filter by agent..." style={{ fontSize: 'var(--fs-sm)', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--sunk)', color: 'var(--tx)', width: 160, outline: 'none' }} />}
      </div>
      <div aria-live="polite" style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: notice ? '0 0 8px' : 0 }}>{notice}</div>
      {showStatuses && <div style={{ marginBottom: 12 }}>
        <SegmentedControl<string> label="Show recommendations by status" value={status} onChange={onStatus} size={24}
          options={REC_STATUSES.map((st) => ({ value: st, label: recStatusLabel(st) }))} />
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
        <article key={rec.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--tx)' }}>{recTitle(rec.detector)}</span>
            <button type="button" onClick={() => onSelectAgent(rec.agentId)} style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{rec.agentId}</button>
            <Badge status={rec.status} />
            {rec.verificationStatus && rec.verificationStatus !== 'none' && <Badge status={rec.verificationStatus} size="small" />}
          </div>
          {rec.summary && <p style={{ margin: 0, fontSize: 'var(--fs-md)', lineHeight: 1.5, color: 'var(--tx)' }}>{rec.summary}</p>}
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
            Since {fmtDay(rec.createdAt)}
            {rec.feedbackCount > 0 && <> &middot; {rec.feedbackCount} action{rec.feedbackCount !== 1 ? 's' : ''}</>}
          </div>
          <RecActions
            open={rec.status === 'open'}
            busy={feedbackLoading === rec.id}
            onEvidence={() => onSelectEvidence(rec.currentFindingId ?? rec.id, rec.agentId, rec.id)}
            onFeedback={(f) => onFeedback(rec, f)}
          />
          {feedbackError?.recId === rec.id && <div role="alert" style={{ fontSize: 'var(--fs-xs)', color: 'var(--bad)' }}>{feedbackError.message}</div>}
        </article>
      )) : (
        <div style={{ color: 'var(--tx3)', fontSize: 'var(--fs-sm)', textAlign: 'center', padding: 16 }}>
          {loading ? 'Loading…' : error ? 'Recommendations unavailable.' : recEmptyText(status, hasCalls, filtered)}
        </div>
      )}

      {!showStatuses && !error && (
        <button type="button" className="wr-link" onClick={onShowStatuses} style={{ background: 'none', border: 'none', padding: 0, marginTop: 12, minHeight: 24, cursor: 'pointer', fontSize: 'var(--fs-sm)', fontWeight: 600 }}>
          Show closed and other statuses
        </button>
      )}

      {error && (
        <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>
          {error}
        </div>
      )}

      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button onClick={onMore} disabled={loading} style={{
            fontSize: 'var(--fs-sm)', fontWeight: 600, padding: '6px 16px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer',
            background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid var(--brand)', opacity: loading ? 0.5 : 1,
          }}>{loading ? 'Loading…' : 'Load more'}</button>
        </div>
      )}

    </div>
  );
}

/** View evidence up front; the rest behind More, so each row has one clear action. */
function RecActions({ open, busy, onEvidence, onFeedback }: { open: boolean; busy: boolean; onEvidence: () => void; onFeedback: (f: Feedback) => void }) {
  const [more, setMore] = useState(false);
  const buttons: Record<RecRowAction, ReactNode> = {
    evidence: <Btn key="evidence" label="View evidence" onClick={onEvidence} loading={false} accent />,
    toggle: (
      <button key="toggle" type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} style={{
        fontSize: 'var(--fs-xs)', fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
        background: 'transparent', color: 'var(--tx2)', border: '1px solid var(--line)',
      }}>{more ? 'Less' : 'More'}</button>
    ),
    fixed: <Btn key="fixed" label="Mark as fixed" onClick={() => onFeedback(recFeedback('fixed'))} loading={busy} />,
    snooze: <Btn key="snooze" label={`Snooze ${SNOOZE_DAYS} days`} onClick={() => onFeedback(recFeedback('snooze'))} loading={busy} />,
    dismiss: <Btn key="dismiss" label="Dismiss" onClick={() => onFeedback(recFeedback('dismiss'))} loading={busy} />,
  };
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
      {recRowActions(open, more).map((a) => buttons[a])}
    </div>
  );
}

