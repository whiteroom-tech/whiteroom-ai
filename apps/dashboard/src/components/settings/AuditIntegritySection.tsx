'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Panel } from '@whiteroom/ui';
import { auditIntegrity, exportAuditSigned, verifyAudit } from '@/lib/whiteroom/client';
import type { AuditIntegrity } from '@/lib/whiteroom/types';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { fmtTime, timeAgo } from '@/lib/format';

/**
 * Settings › Audit integrity (Phase 1 spec H2): how much of the fleet's
 * audit trail has been checked, any recorded gaps, a check on demand and the
 * signed export. Hidden when no fleet is signed in or the engine predates it.
 */
export function AuditIntegritySection() {
  const { fleetId, status: authStatus } = useFleetAuth();
  const [info, setInfo] = useState<AuditIntegrity | null>(null);
  const [busy, setBusy] = useState<'check' | 'export' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  // After a check, unless the fleet changed meanwhile.
  const reload = useCallback(async (id: string) => {
    const i = await auditIntegrity(id);
    setInfo((cur) => (cur?.fleetId === id ? i : cur));
  }, []);

  useEffect(() => {
    setInfo(null);
    if (authStatus !== 'authenticated' || !fleetId) return;
    let live = true;
    auditIntegrity(fleetId).then((i) => { if (live) setInfo(i); }, () => {});
    return () => { live = false; };
  }, [fleetId, authStatus]);

  if (!fleetId || !info) return null;

  async function check() {
    setBusy('check');
    setNote(null);
    try {
      const r = await verifyAudit(fleetId!);
      if (r.valid === true) setNote({ ok: true, text: `All ${r.eventsVerified.toLocaleString('en-US')} events check out${r.cached ? ' (checked in the last minute)' : ''}.` });
      else if (r.valid === false) setNote({ ok: false, text: `A problem was found: ${r.message}` });
      else setNote({ ok: true, text: `${r.eventsVerified.toLocaleString('en-US')} events checked so far. Run the check again to continue.` });
      await reload(fleetId!);
    } catch {
      setNote({ ok: false, text: 'The check didn’t run. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy('export');
    setNote(null);
    try {
      const signed = await exportAuditSigned(fleetId!);
      const url = URL.createObjectURL(new Blob([JSON.stringify(signed, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `whiteroom-audit-${fleetId}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setNote({ ok: false, text: 'The export didn’t download. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  const tracked = info.mode === 'sequenced';
  const checked = info.verifiedAt
    ? `Verified through event ${info.verifiedThroughSeq.toLocaleString('en-US')} of ${info.headSeq.toLocaleString('en-US')} · ${timeAgo(info.verifiedAt)}`
    : 'Not checked yet';
  const gaps = info.gaps.count === 0
    ? 'nothing recorded missing'
    : `${info.gaps.count} gap${info.gaps.count === 1 ? '' : 's'} recorded where events may be missing`;

  return (
    <Panel title="Audit integrity">
      <p style={{ fontSize: 13, color: 'var(--tx2)', margin: '0 0 12px', maxWidth: '62ch' }}>
        Every event in this fleet’s history is linked to the one before it, so a changed or deleted event shows up when the history is checked.
      </p>
      {tracked ? (
        <p id="audit-integrity-status" style={{ fontSize: 13.5, margin: '0 0 6px' }}>{checked} · {gaps}</p>
      ) : (
        <p style={{ fontSize: 13.5, margin: '0 0 6px' }}>History tracking hasn’t started for this fleet yet.</p>
      )}
      {info.gaps.recent.length > 0 && (
        <ul style={{ margin: '0 0 6px', paddingLeft: 18, fontSize: 12.5, color: 'var(--tx2)' }}>
          {info.gaps.recent.map((g, i) => (
            <li key={i}>{g.from && g.to ? `${fmtTime(g.from)} – ${fmtTime(g.to)}` : 'Time unknown'}: events may be missing</li>
          ))}
        </ul>
      )}
      {info.prunedBeforeTracking && (
        <p style={{ fontSize: 12.5, color: 'var(--tx2)', margin: '0 0 6px' }}>Older events were removed before tracking started, so the check begins after them.</p>
      )}
      <p style={{ fontSize: 12.5, color: 'var(--tx2)', margin: '0 0 14px', maxWidth: '62ch' }}>
        Not yet anchored outside WhiteRoom: a check shows any change to the stored history, but can’t yet prove it to someone who doesn’t trust WhiteRoom’s records.
      </p>
      {tracked && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size={28} busy={busy === 'check'} busyLabel="Checking…" onClick={() => void check()}>Run check now</Button>
          <Button variant="ghost" size={28} busy={busy === 'export'} busyLabel="Preparing…" onClick={() => void download()}>Download signed export</Button>
        </div>
      )}
      {note && <p role="status" style={{ margin: '10px 0 0', fontSize: 12.5, color: note.ok ? 'var(--ok)' : 'var(--bad)' }}>{note.text}</p>}
    </Panel>
  );
}
