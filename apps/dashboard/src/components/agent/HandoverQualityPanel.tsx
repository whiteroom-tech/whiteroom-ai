'use client';

import { useEffect, useState } from 'react';
import { Hint, Panel, FONT_MONO } from '@whiteroom/ui';
import { handoverQuality, type HandoverQuality } from '@/lib/whiteroom/client';
import { qualityRows, reviewFooter } from '@/lib/handover-quality';
import { HELP } from '@/lib/metric-definitions';

/** Agent detail › Handover quality (compression spec §14): last 7 days. Hidden on engines without it. */
export function HandoverQualityPanel({ fleetId, agentId }: { fleetId: string; agentId: string }) {
  const [q, setQ] = useState<HandoverQuality | null>(null);

  useEffect(() => {
    setQ(null);
    let live = true;
    handoverQuality(fleetId, agentId).then((r) => { if (live) setQ(r); }, () => {});
    return () => { live = false; };
  }, [fleetId, agentId]);

  if (!q) return null;
  return (
    <Panel
      title={<>Handover quality<Hint text={HELP.handoverQuality} /></>}
      actions={<span style={{ fontSize: 12, color: 'var(--tx2)' }}>Last 7 days · {q.handovers} handover{q.handovers === 1 ? '' : 's'}</span>}
    >
      <div style={{ display: 'grid' }}>
        {qualityRows(q).map((r, i) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', padding: '10px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                {r.label}
                {r.status && (
                  <span style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 500, color: 'var(--tx2)', background: 'var(--sunk)', borderRadius: 4, padding: '1px 6px' }}>
                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
                    {r.status}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: r.state === 'partly' ? 'var(--warn-tx)' : 'var(--tx2)' }}>{r.detail}</div>
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: r.state === 'measured' ? 'var(--tx)' : 'var(--tx2)' }}>
              {/* The dash says nothing to a screen reader; the words do. */}
              {r.state === 'none' ? <><span aria-hidden="true">{r.value}</span><span className="sr-only">Not measured</span></> : r.value}
            </div>
          </div>
        ))}
      </div>
      {reviewFooter(q.review).map((line) => (
        <p key={line} style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--tx2)' }}>{line}</p>
      ))}
    </Panel>
  );
}
