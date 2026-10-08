'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Hint, Panel, FONT_MONO } from '@whiteroom/ui';
import { LoadFailed } from '@/components/citadel/States';
import { handoverQuality, type HandoverQuality } from '@/lib/whiteroom/client';
import { qualityRows } from '@/lib/handover-quality';
import { HELP } from '@/lib/metric-definitions';
import { loadOptional } from '@/lib/settings-flow';

/** Agent detail › Handover quality (compression spec §14): last 7 days. Hidden on engines without it; a failed load says so, with Try again. */
export function HandoverQualityPanel({ fleetId, agentId }: { fleetId: string; agentId: string }) {
  const [q, setQ] = useState<HandoverQuality | null>(null);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // The agent on screen now: a result for one the user moved away from is dropped.
  const current = useRef(`${fleetId}:${agentId}`);
  current.current = `${fleetId}:${agentId}`;

  const load = useCallback(async () => {
    const target = `${fleetId}:${agentId}`;
    const out = await loadOptional(() => handoverQuality(fleetId, agentId));
    if (current.current !== target) return;
    setFailed(out.kind === 'failed');
    if (out.kind !== 'failed') setQ(out.kind === 'loaded' ? out.value : null);
  }, [fleetId, agentId]);

  useEffect(() => {
    setQ(null);
    setFailed(false);
    void load();
  }, [load]);

  if (!q) {
    if (!failed) return null;
    return (
      <Panel title={<>Handover quality<Hint text={HELP.handoverQuality} /></>}>
        <LoadFailed what="handover quality" busy={retrying} onRetry={() => { setRetrying(true); void load().finally(() => setRetrying(false)); }} />
      </Panel>
    );
  }
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
            <div style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: r.state === 'measured' ? 'var(--tx)' : 'var(--tx2)' }}>
              {/* The dash says nothing to a screen reader; the words do. */}
              {r.state === 'none' ? <><span aria-hidden="true">{r.value}</span><span className="sr-only">Not measured</span></> : r.value}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
