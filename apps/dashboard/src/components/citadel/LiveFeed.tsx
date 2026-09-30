'use client';

import { useCallback, useState } from 'react';
import { performanceLiveFeed } from '@/lib/whiteroom/client';
import { safeGet, safeSet } from '@/lib/safe-storage';
import { ActivityFeed } from '@/components/ActivityFeed';
import { isFeedVariant, type FeedVariant } from '@/lib/activity';
import type { AuditEntry } from '@/lib/whiteroom/types';
import { FONT_MONO } from '@whiteroom/ui';

const CTRL_BTN: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, padding: '3px 8px', borderRadius: 4, cursor: 'pointer' };

/**
 * The live feed: full, un-redacted detail (real reply text, real tool-call
 * values) — a different store from the audit log, kept only a short while
 * (ttlHours) and then deleted. Never fetched automatically; revealing it is
 * a deliberate action since it contains actual customer content.
 */
export function LiveFeedSection({ fleetId, authKey }: { fleetId: string; authKey?: string }) {
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [ttlHours, setTtlHours] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [feedVariant, setFeedVariant] = useState<FeedVariant>(() => {
    const v = safeGet('wr_perf_feed_variant');
    return isFeedVariant(v) ? v : 'log';
  });
  const [technical, setTechnical] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [feedPage, setFeedPage] = useState(0);

  const fetchLiveFeed = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await performanceLiveFeed(fleetId, { limit: 100 }, authKey);
      if (res.error) { setError('Live feed unavailable. Try Refresh.'); return; }
      setEntries(res.entries ?? []);
      setTtlHours(res.ttlHours ?? null);
    } catch {
      setError('Live feed unavailable. Try Refresh.');
    } finally { setLoading(false); }
  }, [fleetId, authKey]);

  function reveal() {
    setRevealed(true);
    fetchLiveFeed();
  }

  function changeVariant(v: string) {
    if (!isFeedVariant(v)) return;
    setFeedVariant(v);
    safeSet('wr_perf_feed_variant', v);
  }

  return (
    <div className="flex flex-col" style={{ marginTop: 16, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', overflow: 'hidden' }}>
      <div className="flex items-center justify-between" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', gap: 8 }}>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx2)', textTransform: 'uppercase' as const }}>Live Feed</span>
          {revealed && (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'var(--info-bg)', color: 'var(--info)', fontFamily: FONT_MONO }}>
              ◉ KEPT {ttlHours ?? 72}H · THEN DELETED
            </span>
          )}
        </div>
        {revealed ? (
          <div className="flex items-center gap-2">
            <select aria-label="Live feed style" value={feedVariant} onChange={e => changeVariant(e.target.value)} style={{ borderRadius: 4, padding: '3px 6px', fontSize: 11.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }}>
              <option value="log">Log</option>
              <option value="tape">Tape</option>
              <option value="manifest">Manifest</option>
            </select>
            <button onClick={() => setTechnical(t => !t)} style={{ ...CTRL_BTN, background: technical ? 'var(--info-bg)' : 'var(--sunk)', color: technical ? 'var(--info)' : 'var(--tx3)', border: `1px solid ${technical ? 'var(--info)' : 'var(--line2)'}` }}>Tech</button>
            <button onClick={fetchLiveFeed} disabled={loading} style={{ ...CTRL_BTN, background: 'var(--sunk)', color: 'var(--tx3)', border: '1px solid var(--line2)', cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.5 : 1 }}>{loading ? 'Refreshing...' : 'Refresh'}</button>
          </div>
        ) : (
          <button onClick={reveal} style={{ ...CTRL_BTN, background: 'var(--brand-dim)', color: 'var(--brand)', border: '1px solid var(--brand)' }}>Show live feed</button>
        )}
      </div>
      {revealed && error && (
        <div role="alert" style={{ fontSize: 12, color: 'var(--bad)', padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>{error}</div>
      )}
      {revealed ? (
        <ActivityFeed
          entries={entries}
          page={feedPage}
          onPageChange={setFeedPage}
          variant={feedVariant}
          technical={technical}
          expanded={expanded}
          onToggleExpanded={key => setExpanded(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
        />
      ) : (
        <p style={{ fontSize: 12, color: 'var(--tx3)', margin: 0, padding: '10px 12px' }}>
          Full, un-redacted detail of what agents actually said and did — real content, not the redacted Activity record above. Kept briefly, then deleted; never part of the permanent audit record.
        </p>
      )}
    </div>
  );
}
