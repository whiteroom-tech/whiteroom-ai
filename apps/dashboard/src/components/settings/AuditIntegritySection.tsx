'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Panel } from '@whiteroom/ui';
import { auditIntegrity, verifyAudit } from '@/lib/whiteroom/client';
import { buildAuditExport, saveBlob } from '@/lib/audit-export';
import type { AuditIntegrity } from '@/lib/whiteroom/types';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { fmtTime, timeAgo } from '@/lib/format';
import { AUDIT_KEPT } from '@/lib/plans';

/**
 * Settings › Audit integrity (Phase 1 spec H2): how much of the fleet's
 * audit trail has been checked, any recorded gaps, a check on demand and the
 * signed export of the whole history. Hidden when no fleet is signed in or the engine predates it.
 */
export function AuditIntegritySection() {
  const { fleetId, status: authStatus } = useFleetAuth();
  const [info, setInfo] = useState<AuditIntegrity | null>(null);
  const [busy, setBusy] = useState<'check' | 'export' | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad' | 'neutral'; text: string } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // The fleet shown now: an export still running for another one stops and saves nothing.
  const fleetRef = useRef(fleetId);
  // Which download is current: an older one finishing late can't touch a newer one's state.
  const exportRef = useRef(0);
  useEffect(() => {
    fleetRef.current = fleetId;
    return () => {
      // Leaving a fleet cancels its download, so the next fleet's button is free at once.
      fleetRef.current = null;
      exportRef.current++;
      setBusy((b) => (b === 'export' ? null : b));
      setProgress(null);
    };
  }, [fleetId]);

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
      if (r.valid === true) setNote({ tone: 'ok', text: `All ${r.eventsVerified.toLocaleString('en-US')} events check out${r.cached ? ' (checked in the last minute)' : ''}.` });
      else if (r.valid === false) setNote({ tone: 'bad', text: `A problem was found: ${r.message}` });
      // Part-way isn't a pass: no green until every event is checked.
      else setNote({ tone: 'neutral', text: `${r.eventsVerified.toLocaleString('en-US')} events checked so far. Run the check again to continue.` });
      await reload(fleetId!);
    } catch {
      setNote({ tone: 'bad', text: 'The check didn’t run. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    const id = fleetId!;
    const run = ++exportRef.current;
    const current = () => exportRef.current === run && fleetRef.current === id;
    setBusy('export');
    setNote(null);
    setProgress(null);
    try {
      const file = await buildAuditExport(id, (done, total) => {
        if (current()) setProgress({ done, total });
      }, { isCancelled: () => !current() });
      if (!file || !current()) return;
      saveBlob(file.blob, `whiteroom-audit-${id}-${new Date().toISOString().slice(0, 10)}.json`);
      if (file.events !== null) setNote({ tone: 'neutral', text: `Downloaded ${file.events.toLocaleString('en-US')} events, signed by WhiteRoom.` });
    } catch {
      if (current()) setNote({ tone: 'bad', text: 'The export didn’t download. Try again.' });
    } finally {
      if (exportRef.current === run) {
        setBusy(null);
        setProgress(null);
      }
    }
  }

  const tracked = info.mode === 'sequenced';
  const checked = coverageLine(info.verifiedThroughSeq, info.headSeq, info.verifiedAt ? timeAgo(info.verifiedAt) : null);
  const gaps = info.gaps.count === 0
    ? 'nothing recorded missing'
    : `${info.gaps.count} gap${info.gaps.count === 1 ? '' : 's'} recorded where events may be missing`;

  return (
    <Panel title="Audit integrity">
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '0 0 12px', maxWidth: '62ch' }}>
        Every event in this fleet’s history is linked to the one before it, so a changed or deleted event shows up when the history is checked. Kept for {AUDIT_KEPT}.
      </p>
      {tracked ? (
        <p id="audit-integrity-status" style={{ fontSize: 'var(--fs-md)', margin: '0 0 6px' }}>{checked} · {gaps}</p>
      ) : (
        <p style={{ fontSize: 'var(--fs-md)', margin: '0 0 6px' }}>History tracking hasn’t started for this fleet yet.</p>
      )}
      {info.gaps.recent.length > 0 && (
        <ul style={{ margin: '0 0 6px', paddingLeft: 18, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          {info.gaps.recent.map((g, i) => (
            <li key={i}>{g.from && g.to ? `${fmtTime(g.from)} – ${fmtTime(g.to)}` : 'Time unknown'}: events may be missing</li>
          ))}
        </ul>
      )}
      {info.prunedBeforeTracking && (
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '0 0 6px' }}>Older events were removed before tracking started, so the check begins after them.</p>
      )}
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '0 0 14px', maxWidth: '62ch' }}>
        Not yet anchored outside WhiteRoom: a check shows any change to the stored history, but can’t yet prove it to someone who doesn’t trust WhiteRoom’s records.
      </p>
      {tracked && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size={28} busy={busy === 'check'} busyLabel="Checking…" onClick={() => void check()}>Run check now</Button>
          <Button variant="ghost" size={28} busy={busy === 'export'} busyLabel={exportLabel(progress)} onClick={() => void download()}>Download signed export</Button>
        </div>
      )}
      {note && <p role="status" style={{ margin: '10px 0 0', fontSize: 'var(--fs-sm)', color: note.tone === 'ok' ? 'var(--ok)' : note.tone === 'bad' ? 'var(--bad)' : 'var(--tx2)' }}>{note.text}</p>}
    </Panel>
  );
}

/**
 * How much of the history the last complete check covered: "939 of 2,045
 * events checked (45%) · 2 hours ago". "All" only when it reached the newest
 * event, so a partial check never reads as a pass.
 */
export function coverageLine(verifiedThrough: number, head: number, when: string | null): string {
  if (!when) return 'Not checked yet';
  const n = (x: number) => x.toLocaleString('en-US');
  if (verifiedThrough >= head) return head > 0 ? `All ${n(head)} events checked · ${when}` : `Checked · nothing recorded yet · ${when}`;
  const pct = Math.min(99, Math.floor((verifiedThrough / Math.max(1, head)) * 100));
  return `${n(verifiedThrough)} of ${n(head)} events checked (${pct}%) · ${when}`;
}

/** The Download button while it works: how many events are in so far. */
export function exportLabel(p: { done: number; total: number } | null): string {
  if (!p || p.total === 0) return 'Preparing…';
  const n = (x: number) => x.toLocaleString('en-US');
  return `Preparing… ${n(p.done)} of ${n(p.total)} events`;
}
