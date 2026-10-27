'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SegmentedControl, Tag } from '@whiteroom/ui';
import { SettingsCard } from '@/components/settings/SettingsCard';
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
 * Settings › Smaller context (compression spec §14.1): Off / Preview / On
 * for the signed-in fleet. Preview changes nothing and shows how often each
 * change would have applied; On asks first. Nothing changes on screen until
 * the engine confirms. Hidden on engines without it.
 */
export function SmallerHandoversSection({ sample }: { sample?: CompressionPreview } = {}) {
  const auth = useFleetAuth();
  // /dev/settings: sample counts, nothing fetched or saved.
  const fleetId = sample ? 'preview' : auth.fleetId;
  const authStatus = auth.status;
  const [preview, setPreview] = useState<CompressionPreview | null>(sample ?? null);
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
    if (sample) return;
    // Another fleet starts clean: no confirm or note for the last one carries over.
    setPreview(null);
    setLoadFailed(false);
    setConfirmOn(false);
    setNote(null);
    if (authStatus !== 'authenticated' || !fleetId) return;
    void load(fleetId);
  }, [fleetId, authStatus, load, sample]);

  if (!fleetId) return null;
  if (!preview) {
    if (!loadFailed) return null;
    const fleet = fleetId;
    return (
      <SettingsCard id="smaller-context" title="Smaller context">
        <LoadFailed what="smaller context settings" busy={reloading} onRetry={() => { setReloading(true); void load(fleet).finally(() => setReloading(false)); }} />
      </SettingsCard>
    );
  }

  async function save(mode: CompressionMode) {
    if (sample) { setConfirmOn(false); setPreview((prev) => prev && { ...prev, compression_mode: mode }); return; }
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
    <SettingsCard id="smaller-context" title="Smaller context" sub="Changes that make each call cheaper, tried one at a time">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <SegmentedControl label="Smaller context" value={preview.compression_mode} options={OPTIONS}
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
        title="Turn on smaller context?"
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
    </SettingsCard>
  );
}
