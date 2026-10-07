'use client';

import { useEffect, useRef, useState } from 'react';
import { Panel, SegmentedControl, Tag, FONT_MONO } from '@whiteroom/ui';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { compressionModeSet, compressionPreview, type CompressionMode, type CompressionPreview } from '@/lib/whiteroom/client';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { ITEM_COPY, itemLine, modeText } from '@/lib/smaller-handovers';

const OPTIONS: Array<{ value: CompressionMode; label: string }> = [
  { value: 'off', label: 'Off' }, { value: 'dry_run', label: 'Preview' }, { value: 'on', label: 'On' },
];

/**
 * Settings › Smaller handovers (compression spec §14.1): Off / Preview / On.
 * Preview changes nothing and shows how often each change would have applied;
 * On applies only the changes that have passed testing, and asks first.
 * Nothing changes on screen until the engine confirms. Hidden on engines without it.
 */
export function SmallerHandoversSection() {
  const { fleetId, status: authStatus } = useFleetAuth();
  const [p, setP] = useState<CompressionPreview | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const current = useRef(fleetId);
  current.current = fleetId;

  useEffect(() => {
    setP(null);
    if (authStatus !== 'authenticated' || !fleetId) return;
    let live = true;
    compressionPreview(fleetId).then((r) => { if (live) setP(r); }, () => {});
    return () => { live = false; };
  }, [fleetId, authStatus]);

  if (!fleetId || !p) return null;

  async function save(mode: CompressionMode) {
    const fleet = fleetId!;
    setBusy(true);
    setNote(null);
    try {
      const r = await compressionModeSet(fleet, mode);
      if (current.current !== fleet) return;
      if (r) setP((prev) => (prev ? { ...prev, compression_mode: r.compression_mode, cleared: r.cleared } : prev));
      setConfirmOn(false);
    } catch (e) {
      if (current.current !== fleet) return;
      setNote(e instanceof Error ? e.message : 'That didn’t save. Try again.');
      setConfirmOn(false);
    } finally {
      setBusy(false); // always: the section stays mounted across a fleet switch
    }
  }

  return (
    <Panel title="Smaller handovers">
      <p style={{ fontSize: 13, color: 'var(--tx2)', margin: '0 0 12px', maxWidth: '62ch' }}>
        Changes that make handover notes smaller and more accurate, tried one at a time. For fleet <span style={{ fontFamily: FONT_MONO }}>{fleetId}</span>.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <SegmentedControl label="Smaller handovers" value={p.compression_mode} options={OPTIONS}
          onChange={(v) => {
            const mode = v as CompressionMode;
            if (busy || mode === p.compression_mode) return;
            if (mode === 'on') setConfirmOn(true);
            else void save(mode);
          }} />
        {busy && !confirmOn && <span role="status" style={{ fontSize: 12.5, color: 'var(--tx2)' }}>Saving…</span>}
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--tx2)', maxWidth: '62ch' }}>{modeText(p)}</p>
      {note && <p role="alert" style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--bad)' }}>{note}</p>}

      <div style={{ marginTop: 12 }}>
        {ITEM_COPY.map((item, i) => (
          <div key={item.id} style={{ padding: '10px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{item.title}</span>
              {p.compression_mode === 'on' && p.cleared.includes(item.id) && <Tag tone="brand">Applies</Tag>}
            </div>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--tx2)', maxWidth: '62ch' }}>{item.text}</p>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--tx3)' }}>{itemLine(p, item.id)}</p>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmOn}
        title="Turn on smaller handovers?"
        body={p.cleared.length
          ? 'Changes that have passed testing start applying to what your agents receive from their next call. You can switch back to Preview or Off at any time.'
          : 'None of the changes has passed testing yet, so nothing your agents receive changes for now. Changes start applying as they pass, without asking again.'}
        confirmLabel="Turn on"
        cancelLabel="Keep current setting"
        tone="neutral"
        busy={busy}
        onConfirm={() => void save('on')}
        onCancel={() => setConfirmOn(false)}
      />
    </Panel>
  );
}
