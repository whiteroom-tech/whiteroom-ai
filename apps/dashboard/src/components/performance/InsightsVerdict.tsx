'use client';

import { fmtCount, insightsVerdict, plural, type VerdictInput } from '@/lib/performance-insights';

/**
 * Performance › one line above Unusual behaviour, Agent health check and
 * Recommendations that says whether things are fine, from those cards' own
 * data. Hidden until at least the flags or the health check are known.
 */
export function InsightsVerdict({ input, onReview }: { input: VerdictInput; onReview: () => void }) {
  const v = insightsVerdict(input);
  if (!v) return null;
  const warn = v.tone === 'warn';
  return (
    <section aria-label="Agent summary" className={`wr-verdict${warn ? ' wr-verdict--warn' : ''}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <span aria-hidden style={{
          display: 'inline-flex', flex: 'none', width: 30, height: 30, borderRadius: '50%', alignItems: 'center', justifyContent: 'center',
          background: warn ? 'var(--warn-bg)' : 'var(--ok-bg)', color: warn ? 'var(--warn)' : 'var(--ok)',
        }}>
          {warn
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 7v6" /><path d="M12 17h.01" /></svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
        </span>
        <div style={{ minWidth: 0 }}>
          <div role="status" style={{ fontSize: 15.5, fontWeight: 700, color: warn ? 'var(--warn-tx)' : 'var(--tx)' }}>{v.title}</div>
        </div>
      </div>
      <div className="wr-verdict-counts">
        {input.flaggedRuns !== null && <span><b>{fmtCount(input.flaggedRuns, input.flaggedAtLeast)}</b>{plural(input.flaggedRuns, input.flaggedAtLeast, 'flagged run', 'flagged runs')} this week</span>}
        {input.problems !== null && <span><b>{input.problems.toLocaleString('en-US')}</b>{plural(input.problems, false, 'open problem', 'open problems')}</span>}
        {!!input.openRecs && (
          <button type="button" className="wr-link" onClick={onReview} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, fontWeight: 600, minHeight: 24 }}>
            <b>{input.openRecs.toLocaleString('en-US')}</b>open {plural(input.openRecs, false, 'recommendation', 'recommendations')} →
          </button>
        )}
      </div>
    </section>
  );
}
