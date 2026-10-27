'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, SegmentedControl, Toggle } from '@whiteroom/ui';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { LoadFailed } from '@/components/citadel/States';
import { dataSettingsGet, dataSettingsSet, type DataSettings } from '@/lib/whiteroom/client';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { applyChange, confirmKind, loadOptional, mergeSettingsReply } from '@/lib/settings-flow';

const MAX_AGE_OPTIONS = [{ hours: 24, label: '24 hours' }, { hours: 72, label: '72 hours' }, { hours: 168, label: '7 days' }, { hours: 720, label: '30 days' }];
const ageLabel = (h: number) => MAX_AGE_OPTIONS.find((o) => o.hours === h)?.label ?? `${h} hours`;

type Pending = { patch: Partial<DataSettings>; title: string; body: string; confirm: string; cancel: string; tone: 'danger' | 'neutral' };

const CONFIRM: Record<'notesOff' | 'feedOff' | 'removePersonal', Omit<Pending, 'patch'>> = {
  notesOff: {
    title: 'Stop saving agents’ progress?',
    body: 'Progress is kept in memory only, and what’s saved now is deleted. After a restart, agents start their next run from the beginning.',
    confirm: 'Stop saving', cancel: 'Keep saving', tone: 'danger',
  },
  feedOff: {
    title: 'Turn off the live feed?',
    body: 'The live feed goes empty for this fleet, and entries already saved are deleted now. Your agents keep working as normal. Costs, runs and the audit record aren’t affected.',
    confirm: 'Turn off live feed', cancel: 'Keep live feed', tone: 'danger',
  },
  removePersonal: {
    title: 'Remove personal details from saved progress and the live feed?',
    body: 'Email addresses and phone numbers are removed from saved progress and the live feed, including what’s already saved. Lead, sales and support agents may not finish their tasks.',
    confirm: 'Remove them', cancel: 'Keep them', tone: 'neutral',
  },
};

/**
 * Settings › Data and privacy (compression spec §14): what WhiteRoom keeps
 * for the signed-in fleet. Turning something off, or removing personal
 * details, asks first. Nothing changes on screen until the engine confirms.
 * Hidden when no fleet is signed in or the engine doesn't have the setting;
 * a failed load says so, with Try again.
 */
export function DataPrivacySection({ preview }: { preview?: DataSettings } = {}) {
  const auth = useFleetAuth();
  // /dev/settings: sample settings, nothing fetched or saved.
  const fleetId = preview ? 'preview' : auth.fleetId;
  const authStatus = auth.status;
  const [settings, setSettings] = useState<DataSettings | null>(preview ?? null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The change that failed, so Try again resends exactly it (a purge that
  // didn't finish is retried by saving the same setting again).
  const [retry, setRetry] = useState<Partial<DataSettings> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  // The fleet on screen now: a save that finishes after a fleet switch is dropped.
  const current = useRef(fleetId);
  current.current = fleetId;

  const load = useCallback(async (fleet: string) => {
    const out = await loadOptional(() => dataSettingsGet(fleet));
    if (current.current !== fleet) return;
    setLoadFailed(out.kind === 'failed');
    if (out.kind !== 'failed') setSettings(out.kind === 'loaded' ? out.value : null);
  }, []);

  useEffect(() => {
    if (preview) return;
    // Another fleet starts clean: no dialog, note or retry for the last one carries over.
    setSettings(null);
    setLoadFailed(false);
    setPending(null);
    setNote(null);
    setRetry(null);
    if (authStatus !== 'authenticated' || !fleetId) return;
    void load(fleetId);
  }, [fleetId, authStatus, load, preview]);

  if (!fleetId) return null;
  if (!settings) {
    if (!loadFailed) return null;
    const fleet = fleetId;
    return (
      <SettingsCard id="data-privacy" title="Data and privacy">
        <LoadFailed what="data and privacy settings" busy={reloading} onRetry={() => { setReloading(true); void load(fleet).finally(() => setReloading(false)); }} />
      </SettingsCard>
    );
  }

  async function save(patch: Partial<DataSettings>) {
    if (preview) { setPending(null); setSettings((prev) => prev && { ...prev, ...patch }); return; }
    const fleet = fleetId!;
    setBusy(true);
    setNote(null);
    setRetry(null);
    try {
      const out = await applyChange(() => dataSettingsSet(fleet, patch), () => current.current === fleet);
      if (out.kind === 'stale') return;
      setPending(null);
      if (out.kind === 'applied') {
        const reply = out.value;
        setSettings((prev) => mergeSettingsReply(prev, reply));
        return;
      }
      setNote(out.message);
      setRetry(patch);
      // The change may have been saved even though a later step failed: show what the engine has.
      dataSettingsGet(fleet).then((s) => { if (s && current.current === fleet) setSettings(s); }, () => {});
    } finally {
      setBusy(false);
    }
  }

  /** Saves, or asks first when the change deletes something or changes what agents keep. */
  const change = (patch: Partial<DataSettings>) => {
    const kind = confirmKind(patch, settings);
    if (kind === 'shorterRetention') {
      const hours = patch.handover_max_age_hours!;
      setPending({
        patch,
        title: `Keep saved progress for ${ageLabel(hours)}?`,
        body: `Saved progress older than ${ageLabel(hours)} is deleted now. After a restart, agents idle longer than that start from the beginning.`,
        confirm: `Change to ${ageLabel(hours)}`, cancel: 'Cancel', tone: 'neutral',
      });
    } else if (kind) setPending({ patch, ...CONFIRM[kind] });
    else void save(patch);
  };

  return (
    <SettingsCard id="data-privacy" title="Data and privacy" sub="What WhiteRoom keeps for this fleet, and for how long. Credentials are always removed first.">
      <Row
        title="Save agents’ progress"
        text={settings.handover_persistence
          ? 'Lets your agents keep their place after a restart. Encrypted.'
          : 'Progress is kept in memory only. After a restart, agents start their next run from the beginning.'}
        control={<Toggle label="Save agents’ progress" checked={settings.handover_persistence} disabled={busy}
          onChange={(on) => change({ handover_persistence: on })} />}
      >
        {settings.handover_persistence && settings.handover_max_age_hours != null && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--tx2)' }}>Keep it for</span>
            <SegmentedControl label="Keep saved progress for" value={MAX_AGE_OPTIONS.some((o) => o.hours === settings.handover_max_age_hours) ? String(settings.handover_max_age_hours) : null}
              options={MAX_AGE_OPTIONS.map((o) => ({ value: String(o.hours), label: o.label }))}
              onChange={(v) => {
                const hours = Number(v);
                if (busy || hours === settings.handover_max_age_hours) return;
                change({ handover_max_age_hours: hours });
              }} />
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Deleted that long after it&rsquo;s saved.</span>
          </div>
        )}
        {carriesOnlyInLabeledRuns(settings) && (
          <p style={{ margin: '10px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
            Progress is kept only between calls with the same run label. <a href="https://whiteroom.tech/docs.html#runs" target="_blank" rel="noopener noreferrer">How to label runs</a>
          </p>
        )}
      </Row>
      <Row
        title="Live feed"
        text={settings.content_capture
          ? 'What your agents said and did, with credentials removed. Deleted automatically after a short time (the live feed shows how long), never part of the audit record.'
          : liveFeedLocked(settings)
            ? 'Live feed is off. It can’t be turned on while personal details are removed.'
            : 'Live feed is off for this fleet. Turning it on starts recording from now; nothing earlier comes back.'}
        control={<Toggle label="Live feed" checked={settings.content_capture} disabled={busy || liveFeedLocked(settings)}
          onChange={(on) => change({ content_capture: on })} />}
      />
      <Row
        last
        title="Personal details"
        text="Email addresses and phone numbers in saved progress and the live feed (names aren’t detected). Keep them if your agents need them, like lead or support agents."
        control={<SegmentedControl label="Personal details" value={settings.personal_data}
          options={[{ value: 'keep', label: 'Keep' }, { value: 'exclude', label: 'Remove' }]}
          onChange={(v) => {
            if (busy || v === settings.personal_data) return;
            change({ personal_data: v as 'keep' | 'exclude' });
          }} />}
      />

      <p style={{ margin: '12px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        Deleted data can stay in encrypted database backups until those backups expire.
      </p>
      {busy && !pending && <p role="status" style={{ margin: '8px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Saving…</p>}
      {note && (
        <div style={{ margin: '8px 0 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--bad)', flex: '1 1 260px' }}>{note}</p>
          {retry && <Button size={28} busy={busy} busyLabel="Saving…" onClick={() => void save(retry)}>Try again</Button>}
        </div>
      )}

      <ConfirmDialog
        open={!!pending}
        title={pending?.title ?? ''}
        body={pending?.body ?? ''}
        confirmLabel={pending?.confirm ?? ''}
        cancelLabel={pending?.cancel}
        tone={pending?.tone}
        busy={busy}
        onConfirm={() => { if (pending) void save(pending.patch); }}
        onCancel={() => setPending(null)}
      />
    </SettingsCard>
  );
}

/** The engine refuses to turn the live feed on while personal details are removed (P0 #9). */
export const liveFeedLocked = (s: DataSettings) => !s.content_capture && s.personal_data === 'exclude';
/** Saved progress carries from one job to the next only within a labeled run (P0 #3a). */
export const carriesOnlyInLabeledRuns = (s: DataSettings) => s.handover_carry_forward_effective === 'explicit_run';

function Row({ title, text, control, last, children }: { title: string; text: string; control: React.ReactNode; last?: boolean; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', padding: '14px 0', borderBottom: last ? 'none' : '1px solid var(--line)' }}>
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600 }}>{title}</div>
        <p style={{ margin: '4px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)', maxWidth: '58ch' }}>{text}</p>
        {children}
      </div>
      <div style={{ flex: 'none' }}>{control}</div>
    </div>
  );
}
