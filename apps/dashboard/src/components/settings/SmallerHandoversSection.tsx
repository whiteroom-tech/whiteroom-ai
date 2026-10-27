'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel, SegmentedControl, Tag, FONT_MONO } from '@whiteroom/ui';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { LoadFailed } from '@/components/citadel/States';
import { compressionModeSet, compressionPreview, type CompressionMode, type CompressionPreview } from '@/lib/whiteroom/client';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { itemLine, modeText, shownItems } from '@/lib/smaller-handovers';
import { applyChange, loadOptional } from '@/lib/settings-flow';

const OPTIONS: Array<{ value: CompressionMode; label: string }> = [
  { value: 'off', label: 'Off' }, { value: 'dry_run', label: 'Preview' }, { value: 'on', label: 'On' },
];

/**
 * Settings › Smaller handovers (compression spec §14.1): Off / Preview / On
 * for the signed-in fleet. Preview changes nothing and shows how often each
 * change would have applied; On asks first. Nothing changes on screen until
 * the engine confirms. Hidden on engines without it.
 */
export function SmallerHandoversSection() {
  const { fleetId, status: authStatus } = useFleetAuth();
  const [preview, setPreview] = useState<CompressionPreview | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  // The fleet on screen now: a save that finishes after a fleet switch is dropped.
  const current = useRef(fleetId);
  current.current = fleetId;

  const load = useCallback(async (fleet: string) => {
    const out = await loadOptional(() => compressionPreview(fleet));
    if (current.current !== fleet) return;
    setLoadFailed(out.kind === 'failed');
    if (out.kind !== 'failed') setPreview(out.kind === 'loaded' ? out.value : null);
  }, []);

  useEffect(() => {
    // Another fleet starts clean: no confirm or note for the last one carries over.
    setPreview(null);
    setLoadFailed(false);
    setConfirmOn(false);
    setNote(null);
    if (authStatus !== 'authenticated' || !fleetId) return;
    void load(fleetId);
  }, [fleetId, authStatus, load]);

  if (!fleetId) return null;
  if (!preview) {
    if (!loadFailed) return null;
    const fleet = fleetId;
    return (
      <Panel title="Cheaper calls">
        <LoadFailed what="cheaper call settings" busy={reloading} onRetry={() => { setReloading(true); void load(fleet).finally(() => setReloading(false)); }} />
      </Panel>
    );
  }

  async function save(mode: CompressionMode) {
    const fleet = fleetId!;
    setBusy(true);
    setNote(null);
    try {
      const out = await applyChange(() => compressionModeSet(fleet, mode), () => current.current === fleet, (r) => r.success);
      if (out.kind === 'stale') return;
      setConfirmOn(false);
      if (out.kind === 'failed') { setNote(out.message); return; }
      const { compression_mode, cleared } = out.value;
      setPreview((prev) => prev && { ...prev, compression_mode, cleared });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Cheaper calls">
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '0 0 12px', maxWidth: '62ch' }}>
        Changes that make each call cheaper, tried one at a time. For fleet <span style={{ fontFamily: FONT_MONO }}>{fleetId}</span>.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <SegmentedControl label="Cheaper calls" value={preview.compression_mode} options={OPTIONS}
          onChange={(v) => {
            const mode = v as CompressionMode;
            if (busy || mode === preview.compression_mode) return;
            if (mode === 'on') setConfirmOn(true);
            else void save(mode);
          }} />
        {busy && !confirmOn && <span role="status" style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Saving…</span>}
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)', maxWidth: '62ch' }}>{modeText(preview)}</p>
      {note && <p role="alert" style={{ margin: '8px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--bad)' }}>{note}</p>}

      <div style={{ marginTop: 12 }}>
        {shownItems(preview).map((item, i) => (
          <div key={item.id} style={{ padding: '10px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--fs-md)', fontWeight: 600 }}>{item.title}</span>
              {preview.compression_mode === 'on' && preview.cleared.includes(item.id) && <Tag tone="brand">Applies</Tag>}
            </div>
            <p style={{ margin: '2px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)', maxWidth: '62ch' }}>{item.text}</p>
            <p style={{ margin: '2px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx3)' }}>{itemLine(preview, item.id)}</p>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmOn}
        title="Turn on cheaper calls?"
        body={preview.cleared.length
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
