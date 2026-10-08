'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Panel, SegmentedControl, Toggle, FONT_MONO } from '@whiteroom/ui';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { dataSettingsGet, dataSettingsSet, type DataSettings } from '@/lib/whiteroom/client';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { applyChange, confirmKind, mergeSettingsReply } from '@/lib/settings-flow';

const MAX_AGE_OPTIONS = [{ hours: 24, label: '24 hours' }, { hours: 72, label: '72 hours' }, { hours: 168, label: '7 days' }, { hours: 720, label: '30 days' }];
const ageLabel = (h: number) => MAX_AGE_OPTIONS.find((o) => o.hours === h)?.label ?? `${h} hours`;

type Pending = { patch: Partial<DataSettings>; title: string; body: string; confirm: string; cancel: string; tone: 'danger' | 'neutral' };

const CONFIRM: Record<'notesOff' | 'feedOff' | 'removePersonal', Omit<Pending, 'patch'>> = {
  notesOff: {
    title: 'Stop saving handover notes?',
    body: 'Notes stay in memory only. After a WhiteRoom update, agents start their next shift without them. Saved notes are deleted now.',
    confirm: 'Stop saving', cancel: 'Keep saving', tone: 'danger',
  },
  feedOff: {
    title: 'Turn off the live feed?',
    body: 'The live feed goes empty for this fleet, and entries already saved are deleted now. Your agents keep working as normal. Costs, runs and the audit record aren’t affected.',
    confirm: 'Turn off live feed', cancel: 'Keep live feed', tone: 'danger',
  },
  removePersonal: {
    title: 'Remove personal details from notes and the live feed?',
    body: 'Email addresses and phone numbers are removed from handover notes and the live feed, including what’s already saved. After a WhiteRoom update, agents resume without them. Lead, sales and support agents may not finish their tasks.',
    confirm: 'Remove them', cancel: 'Keep them', tone: 'neutral',
  },
};

/**
 * Settings › Data and privacy (compression spec §14): what WhiteRoom keeps
 * for the signed-in fleet. Turning something off, or removing personal
 * details, asks first. Nothing changes on screen until the engine confirms.
 * Hidden when no fleet is signed in or the engine doesn't have the setting.
 */
export function DataPrivacySection() {
  const { fleetId, status: authStatus } = useFleetAuth();
  const [settings, setSettings] = useState<DataSettings | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The change that failed, so Try again resends exactly it (a purge that
  // didn't finish is retried by saving the same setting again).
  const [retry, setRetry] = useState<Partial<DataSettings> | null>(null);
  // The fleet on screen now: a save that finishes after a fleet switch is dropped.
  const current = useRef(fleetId);
  current.current = fleetId;

  useEffect(() => {
    // Another fleet starts clean: no dialog, note or retry for the last one carries over.
    setSettings(null);
    setPending(null);
    setNote(null);
    setRetry(null);
    if (authStatus !== 'authenticated' || !fleetId) return;
    let live = true;
    dataSettingsGet(fleetId).then((s) => { if (live) setSettings(s); }, () => {});
    return () => { live = false; };
  }, [fleetId, authStatus]);

  if (!fleetId || !settings) return null;

  async function save(patch: Partial<DataSettings>) {
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
        title: `Keep notes for ${ageLabel(hours)}?`,
        body: `Saved notes older than ${ageLabel(hours)} are deleted now. After a WhiteRoom update, agents idle longer than that resume without them.`,
        confirm: `Change to ${ageLabel(hours)}`, cancel: 'Cancel', tone: 'neutral',
      });
    } else if (kind) setPending({ patch, ...CONFIRM[kind] });
    else void save(patch);
  };

  return (
    <Panel title="Data and privacy">
      <p style={{ fontSize: 13, color: 'var(--tx2)', margin: '0 0 6px', maxWidth: '62ch' }}>
        What WhiteRoom keeps for fleet <span style={{ fontFamily: FONT_MONO }}>{fleetId}</span>, and for how long. API keys, passwords and other credentials are always removed from handover notes and the live feed before they’re saved.
      </p>

      <Row
        title="Save handover notes"
        text={settings.handover_persistence
          ? 'Lets your agents pick up where they left off after a WhiteRoom update. Notes are encrypted.'
          : 'Notes stay in memory only. After a WhiteRoom update, agents start their next shift without them.'}
        control={<Toggle label="Save handover notes" checked={settings.handover_persistence} disabled={busy}
          onChange={(on) => change({ handover_persistence: on })} />}
      >
        {settings.handover_persistence && settings.handover_max_age_hours != null && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--tx2)' }}>Keep notes for</span>
            <SegmentedControl label="Keep notes for" value={MAX_AGE_OPTIONS.some((o) => o.hours === settings.handover_max_age_hours) ? String(settings.handover_max_age_hours) : null}
              options={MAX_AGE_OPTIONS.map((o) => ({ value: String(o.hours), label: o.label }))}
              onChange={(v) => {
                const hours = Number(v);
                if (busy || hours === settings.handover_max_age_hours) return;
                change({ handover_max_age_hours: hours });
              }} />
            <span style={{ fontSize: 12.5, color: 'var(--tx2)' }}>Each note is deleted that long after it&rsquo;s written.</span>
          </div>
        )}
      </Row>
      <Row
        title="Live feed"
        text={settings.content_capture
          ? 'What your agents said and did, with credentials removed. Deleted automatically after a short time (the live feed shows how long), never part of the audit record.'
          : 'Live feed is off for this fleet. Turning it on starts recording from now; nothing earlier comes back.'}
        control={<Toggle label="Live feed" checked={settings.content_capture} disabled={busy}
          onChange={(on) => change({ content_capture: on })} />}
      />
      <Row
        last
        title="Personal details in notes and the live feed"
        text="Email addresses and phone numbers your agents work with (names aren’t detected). Keep them if your agents need them to finish the job, like lead or support agents."
        control={<SegmentedControl label="Personal details in notes and the live feed" value={settings.personal_data}
          options={[{ value: 'keep', label: 'Keep' }, { value: 'exclude', label: 'Remove' }]}
          onChange={(v) => {
            if (busy || v === settings.personal_data) return;
            change({ personal_data: v as 'keep' | 'exclude' });
          }} />}
      />

      <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--tx2)' }}>
        Deleted data can stay in encrypted database backups until those backups expire.
      </p>
      {busy && !pending && <p role="status" style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--tx2)' }}>Saving…</p>}
      {note && (
        <div style={{ margin: '8px 0 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--bad)', flex: '1 1 260px' }}>{note}</p>
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
    </Panel>
  );
}

function Row({ title, text, control, last, children }: { title: string; text: string; control: React.ReactNode; last?: boolean; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', padding: '14px 0', borderBottom: last ? 'none' : '1px solid var(--line)' }}>
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--tx2)', maxWidth: '58ch' }}>{text}</p>
        {children}
      </div>
      <div style={{ flex: 'none' }}>{control}</div>
    </div>
  );
}
