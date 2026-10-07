'use client';

import { useEffect, useState } from 'react';
import { Hint, Panel, FONT_MONO } from '@whiteroom/ui';
import { handoverQuality, type HandoverQuality } from '@/lib/whiteroom/client';
import { qualityRows } from '@/lib/handover-quality';
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
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.label}</div>
              <div style={{ fontSize: 12.5, color: r.state === 'partly' ? 'var(--warn-tx)' : 'var(--tx2)' }}>{r.detail}</div>
            </div>
            <div aria-label={r.state === 'none' ? 'Not measured' : undefined} style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: r.state === 'measured' ? 'var(--tx)' : 'var(--tx2)' }}>{r.value}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
