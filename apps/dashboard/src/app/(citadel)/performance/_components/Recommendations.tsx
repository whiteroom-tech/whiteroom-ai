'use client';

/**
 * Performance › Recommendations: what to look at, Open first. Presentational:
 * the page owns the list, its paging and the feedback calls.
 */
import { useState, type ReactNode } from 'react';
import type { RecommendationDetail } from '@/lib/whiteroom/types';
import { SegmentedControl } from '@whiteroom/ui';
import { fmtDay, plural } from '@/lib/format';
import { SNOOZE_DAYS, fixCheckLine } from '@/lib/diagnosis/copy';
import { recCountSuffix, recEmptyText, recFeedback, recRowActions, recStatusLabel, recTitle, type RecRowAction, NO_FINDING_NOTE } from '@/lib/performance-insights';
import { Badge, Btn } from './primitives';
import { DiagnosisRow, isDiagnosisRow } from './Diagnosis';

/** Rows shown before "Show more". */
export const REC_COLLAPSED = 3;

/** A pinned row's mark: it was opened from a problem in the health table. */
export const PINNED_NOTE = 'Opened from the health table';

export const REC_STATUSES = ['all', 'open', 'snoozed', 'dismissed', 'reported_implemented', 'resolved', 'evaluating', 'validated'] as const;

type Feedback = ReturnType<typeof recFeedback>;

export function RecommendationsCard({
  recs, total, status, onStatus, showStatuses, onShowStatuses, agentFilter, onAgentFilter, showAgentFilter, filtered, hasCalls,
  loading, error, notice, hasMore, onMore, expanded, onExpand, pinned = null, onSelectAgent, onSelectEvidence, onFeedback, onDiagnosisFeedback, feedbackLoading, feedbackError,
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
  /** All loaded rows show; otherwise the first REC_COLLAPSED and "Show more". */
  expanded: boolean;
  onExpand: () => void;
  /** The recommendation a health-table problem opened: shown first, whatever the list holds. */
  pinned?: RecommendationDetail | null;
  onSelectAgent: (id: string) => void;
  onSelectEvidence: (findingId: string, agentId: string, recId?: string) => void;
  onFeedback: (rec: RecommendationDetail, f: Feedback) => void;
  onDiagnosisFeedback: (rec: RecommendationDetail, action: 'dismiss' | 'snooze' | 'implemented') => Promise<boolean>;
  feedbackLoading: string | null;
  feedbackError: { recId: string; message: string } | null;
}) {
  const others = pinned ? recs.filter((r) => r.id !== pinned.id) : recs;
  const shown = expanded ? others : others.slice(0, REC_COLLAPSED);
  const list = pinned ? [pinned, ...shown] : shown;
  const mark = (rec: RecommendationDetail) => (rec.id === pinned?.id ? <span className="wr-rec__pin">{PINNED_NOTE}</span> : null);
  return (
    <div className="wr-pcard wr-recs" id="recommendations">
      <div className="wr-recs__head">
        <h3 className="wr-pcard__title" id="recommendations-heading" tabIndex={-1}>Recommendations</h3>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* One agent: nothing to filter by. */}
          {showAgentFilter && <input aria-label="Filter by agent" className="wr-input" value={agentFilter} onChange={e => onAgentFilter(e.target.value)} placeholder="Filter by agent…" style={{ width: 170, fontSize: 'var(--fs-sm)' }} />}
          <span className="wr-cap">{total > 0 ? `${total.toLocaleString()}${recCountSuffix(status)}` : status === 'open' ? 'none open' : ''}</span>
        </span>
      </div>
      <div className="wr-recs__body">
      <div aria-live="polite" style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: notice ? '0 0 8px' : 0 }}>{notice}</div>
      {showStatuses && <div style={{ marginBottom: 12 }}>
        <SegmentedControl<string> label="Show recommendations by status" value={status} onChange={onStatus} size={24}
          options={REC_STATUSES.map((st) => ({ value: st, label: recStatusLabel(st) }))} />
      </div>}

      {list.length > 0 ? list.map(rec => isDiagnosisRow(rec) ? (
        <DiagnosisRow
          key={rec.id}
          rec={rec}
          mark={mark(rec)}
          onSelectAgent={onSelectAgent}
          onSelectEvidence={() => onSelectEvidence(rec.currentFindingId ?? rec.id, rec.agentId, rec.id)}
          onFeedback={(action) => onDiagnosisFeedback(rec, action)}
          busy={feedbackLoading === rec.id}
          error={feedbackError?.recId === rec.id ? feedbackError.message : null}
        />
      ) : (
        <article key={rec.id} id={`rec-${rec.id}`} tabIndex={-1} className="wr-rec">
          <div className="wr-rec__text">
            {mark(rec)}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ color: 'var(--tx)' }}>{recTitle(rec.detector)}</strong>
              <button type="button" onClick={() => onSelectAgent(rec.agentId)} className="wr-agent-link">{rec.agentId}</button>
              {rec.status !== 'open' && <Badge status={rec.status} />}
              {/* A fix check has its own line below; without one, the verification state keeps its badge. */}
              {!rec.fixCheck && rec.verificationStatus && rec.verificationStatus !== 'none' && <Badge status={rec.verificationStatus} size="small" />}
            </div>
            {rec.summary && <p style={{ margin: 0, fontSize: 'var(--fs-md)', lineHeight: 1.5, color: 'var(--tx)' }}>{rec.summary}</p>}
            {rec.fixCheck && <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: rec.fixCheck.state === 'still_happening' ? 'var(--warn-tx)' : 'var(--tx2)' }}>{fixCheckLine(rec.fixCheck)}</p>}
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
              Since {fmtDay(rec.createdAt)}
              {rec.feedbackCount > 0 && <> &middot; {rec.feedbackCount} {plural(rec.feedbackCount, 'action')}</>}
            </div>
          </div>
          <RecActions
            open={rec.status === 'open'}
            hasFinding={!!rec.currentFindingId}
            busy={feedbackLoading === rec.id}
            onEvidence={() => onSelectEvidence(rec.currentFindingId ?? rec.id, rec.agentId, rec.id)}
            onFeedback={(f) => onFeedback(rec, f)}
          />
          {feedbackError?.recId === rec.id && <div role="alert" className="wr-rec__full" style={{ fontSize: 'var(--fs-sm)', color: 'var(--bad)' }}>{feedbackError.message}</div>}
        </article>
      )) : (
        <div style={{ color: 'var(--tx3)', fontSize: 'var(--fs-sm)', textAlign: 'center', padding: 16 }}>
          {loading ? 'Loading…' : error ? 'Recommendations unavailable.' : recEmptyText(status, hasCalls, filtered)}
        </div>
      )}


      {error && (
        <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>
          {error}
        </div>
      )}

      {!expanded && others.length > REC_COLLAPSED && (
        <p style={{ margin: 0, padding: '10px 0' }}><button type="button" className="wr-link" onClick={onExpand}>Show more</button></p>
      )}

      {expanded && hasMore && (
        <div style={{ textAlign: 'center', margin: '12px 0' }}>
          <button onClick={onMore} disabled={loading} style={{
            fontSize: 'var(--fs-sm)', fontWeight: 600, padding: '6px 16px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer',
            background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid var(--brand)', opacity: loading ? 0.5 : 1,
          }}>{loading ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
      </div>

      {!showStatuses && !error && (
        <div className="wr-recs__foot">
          <button type="button" className="wr-btn wr-btn--secondary wr-btn--h32" onClick={onShowStatuses}>Show past recommendations</button>
        </div>
      )}
    </div>
  );
}

/** View evidence up front; the rest behind More, so each row has one clear action. */
function RecActions({ open, hasFinding, busy, onEvidence, onFeedback }: { open: boolean; hasFinding: boolean; busy: boolean; onEvidence: () => void; onFeedback: (f: Feedback) => void }) {
  const [more, setMore] = useState(false);
  const buttons: Record<RecRowAction, ReactNode> = {
    evidence: <button key="evidence" type="button" className="wr-btn wr-btn--secondary wr-btn--h32 wr-btn--brand-outline" onClick={onEvidence}>See why</button>,
    toggle: <button key="toggle" type="button" className="wr-btn wr-btn--secondary wr-btn--h32" aria-expanded={more} onClick={() => setMore((v) => !v)}>Options</button>,
    fixed: <Btn key="fixed" label="Mark as fixed" onClick={() => onFeedback(recFeedback('fixed'))} loading={busy} />,
    snooze: <Btn key="snooze" label={`Snooze ${SNOOZE_DAYS} days`} onClick={() => onFeedback(recFeedback('snooze'))} loading={busy} />,
    dismiss: <Btn key="dismiss" label="Dismiss" onClick={() => onFeedback(recFeedback('dismiss'))} loading={busy} />,
  };
  return (
    <div className="wr-rec__acts">
      {recRowActions(open, more, hasFinding).map((a) => buttons[a])}
      {open && !hasFinding && <span style={{ alignSelf: 'center', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{NO_FINDING_NOTE}</span>}
    </div>
  );
}

