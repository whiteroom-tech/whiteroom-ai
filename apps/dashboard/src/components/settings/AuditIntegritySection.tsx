'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@whiteroom/ui';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { auditIntegrity, verifyAudit, WhiteRoomApiError } from '@/lib/whiteroom/client';
import { AuditExportProblem, buildAuditExport } from '@/lib/audit-export';
import { saveBlob } from '@/lib/download';
import type { AuditIntegrity } from '@/lib/whiteroom/types';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { fmtCount, fmtTime, timeAgo, plural } from '@/lib/format';
import { AUDIT_KEPT } from '@/lib/plans';

/**
 * Settings › Audit trail (Phase 1 spec H2): how much of the fleet's
 * audit trail has been checked, any recorded gaps, a check on demand and the
 * signed export of the whole history. Always shown, so a link to
 * #audit-integrity lands on it: without a fleet session it says to sign in.
 */
export function AuditIntegritySection({ preview }: { preview?: AuditIntegrity } = {}) {
  const auth = useFleetAuth();
  // /dev/settings: a sample check, nothing fetched.
  const fleetId = preview ? preview.fleetId : auth.fleetId;
  const authStatus = auth.status;
  const [info, setInfo] = useState<AuditIntegrity | null>(preview ?? null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState<'check' | 'export' | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad' | 'neutral'; text: string; check?: boolean } | null>(null);
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
    if (preview) return;
    setInfo(null);
    setLoadFailed(false);
    setUnsupported(false);
    if (authStatus !== 'authenticated' || !fleetId) return;
    let live = true;
    auditIntegrity(fleetId).then((i) => { if (live) setInfo(i); }, (e: unknown) => {
      if (!live) return;
      // An engine without audit integrity can't be fixed by a reload: the section stays hidden.
      if (e instanceof WhiteRoomApiError && e.status === 400 && e.reason === 'Unknown action.') setUnsupported(true);
      else setLoadFailed(true);
    });
    return () => { live = false; };
  }, [fleetId, authStatus, preview]);

  if (unsupported) return null;
  if (!info) {
    const signedOut = authStatus === 'unauthenticated' || (authStatus === 'authenticated' && !fleetId);
    const line = signedOut
      ? 'Sign in to your fleet to download the audit trail.'
      : loadFailed ? 'Couldn’t load the audit trail. Reload the page to try again.' : 'Loading the audit trail…';
    return (
      <SettingsCard id="audit" title="Audit trail" sub={AUDIT_SUB}>
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: 0 }}>{line}</p>
      </SettingsCard>
    );
  }

  async function check() {
    setBusy('check');
    setNote(null);
    try {
      const r = await verifyAudit(fleetId!);
      if (r.valid === true) setNote({ tone: 'ok', text: `All ${fmtCount(r.eventsVerified)} events check out${r.cached ? ' (checked in the last minute)' : ''}.` });
      else if (r.valid === false) setNote({ tone: 'bad', text: `A problem was found: ${r.message}` });
      // Part-way isn't a pass: no green until every event is checked.
      else setNote({ tone: 'neutral', text: `${fmtCount(r.eventsVerified)} events checked so far. Run the check again to continue.` });
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
      setNote(file.events !== null
        ? { tone: 'ok', text: `Downloaded ${fmtCount(file.events)} events, signed by WhiteRoom.` }
        // The older export: signed, but only the most recent events.
        : { tone: 'neutral', text: 'Downloaded the shorter signed export, with the most recent events only.' });
    } catch (e) {
      if (!current()) return;
      // The history itself didn't add up: trying again won't help, a check will say more.
      if (e instanceof AuditExportProblem) setNote({ tone: 'bad', text: `The export found a problem with the audit trail: ${e.plain}.`, check: true });
      else setNote({ tone: 'bad', text: 'The export didn’t download. Try again.' });
    } finally {
      if (exportRef.current === run) {
        setBusy(null);
        setProgress(null);
      }
    }
  }

  /** Stops the download in progress: it saves nothing. */
  function cancelDownload() {
    exportRef.current++;
    setBusy(null);
    setProgress(null);
  }

  const tracked = info.mode === 'sequenced';
  const checked = coverageLine(info.verifiedThroughSeq, info.headSeq, info.verifiedAt ? timeAgo(info.verifiedAt) : null);
  const gaps = info.gaps.count === 0
    ? 'nothing recorded missing'
    : `${info.gaps.count} ${plural(info.gaps.count, 'gap')} recorded where events may be missing`;

  return (
    <SettingsCard id="audit" title="Audit trail" sub={AUDIT_SUB}>
      {tracked ? (
        <p id="audit-integrity-status" style={{ fontSize: 'var(--fs-md)', margin: '0 0 6px' }}><strong style={{ fontWeight: 600 }}>{checked}</strong> · {gaps}</p>
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
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '0 0 6px' }}>Events before tracking started aren’t covered.</p>
      )}
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '0 0 14px', maxWidth: '62ch' }}>
        Not yet anchored outside WhiteRoom, so it can’t yet prove the history to someone who doesn’t trust WhiteRoom’s records. Kept for {AUDIT_KEPT}.
      </p>
      {tracked && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="primary" busy={busy === 'check'} busyLabel="Checking…" onClick={() => void check()}>Run check now</Button>
          {/* The label stays put while it works, so the button doesn't change width; progress has its own line. */}
          <Button disabled={busy === 'export'} aria-busy={busy === 'export' || undefined} onClick={() => void download()}>Download signed export</Button>
          {busy === 'export' && <Button variant="ghost" onClick={cancelDownload}>Cancel</Button>}
        </div>
      )}
      {busy === 'export' && <p role="status" className="wr-audit-progress" style={{ margin: '10px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{exportLabel(progress)}</p>}
      {note && (
        <p role="status" style={{ margin: '10px 0 0', fontSize: 'var(--fs-sm)', color: note.tone === 'ok' ? 'var(--ok)' : note.tone === 'bad' ? 'var(--bad)' : 'var(--tx2)' }}>
          {note.text}
          {note.check && <> <button type="button" className="wr-link" disabled={busy !== null} onClick={() => void check()} style={{ background: 'none', border: 0, padding: 0, font: 'inherit', fontWeight: 600, cursor: 'pointer' }}>Run check now.</button></>}
        </p>
      )}
    </SettingsCard>
  );
}

const AUDIT_SUB = 'Every event is linked to the one before it, so a changed or deleted event shows up when checked.';

/**
 * How much of the history the last complete check covered: "939 of 2,045
 * events checked (45%) · 2 hours ago". "All" only when it reached the newest
 * event, so a partial check never reads as a pass.
 */
export function coverageLine(verifiedThrough: number, head: number, when: string | null): string {
  if (!when) return 'Not checked yet';
  if (verifiedThrough >= head) return head > 0 ? `All ${fmtCount(head)} events checked · ${when}` : `Checked · nothing recorded yet · ${when}`;
  const pct = Math.min(99, Math.floor((verifiedThrough / Math.max(1, head)) * 100));
  return `${fmtCount(verifiedThrough)} of ${fmtCount(head)} events checked (${pct}%) · ${when}`;
}

/** The line under the buttons while a download works: how many events are in so far. */
export function exportLabel(p: { done: number; total: number } | null): string {
  if (!p || p.total === 0) return 'Preparing…';
  return `Preparing… ${fmtCount(p.done)} of ${fmtCount(p.total)} events`;
}
