'use client';

// Home › "Check audit trail" (mockup): runs the engine's chain check when
// opened and says what it found, plainly. Download proof saves the result.
// Runs and Controls carry the same dialog in their own PRs; once all three
// are merged it should become one shared component.

import { useRef, useState } from 'react';
import { Button } from '@whiteroom/ui';
import { DialogFrame } from '@/components/citadel/DialogFrame';
import { fmtCount } from '@/lib/format';
import { saveBlob } from '@/lib/download';
import { auditIntegrity, isAuthError, verifyAudit } from '@/lib/whiteroom/client';
import type { AuditIntegrity, VerifyAuditResult } from '@/lib/whiteroom/types';

type AuditCheck =
  | { state: 'checking' }
  | { state: 'done'; result: VerifyAuditResult; info: AuditIntegrity | null; at: number }
  | { state: 'failed' };

export function AuditCheckDialog({ open, fleetId, authKey, onClose, onAuthError, preview }: {
  open: boolean;
  fleetId: string;
  authKey?: string;
  onClose: () => void;
  /** The session expired: the page signs out, as its own loads do. */
  onAuthError?: (message: string) => void;
  /** /dev/home: a sample result; nothing is fetched. */
  preview?: { result: VerifyAuditResult; info: AuditIntegrity | null };
}) {
  const [check, setCheck] = useState<AuditCheck>({ state: 'checking' });
  // Each opening is one check: one from an earlier opening that answers late is ignored.
  const current = useRef(0);
  async function run() {
    const id = ++current.current;
    const live = () => id === current.current;
    if (preview) { setCheck({ state: 'done', ...preview, at: Date.now() }); return; }
    setCheck({ state: 'checking' });
    try {
      const result = await verifyAudit(fleetId, authKey);
      const info = await auditIntegrity(fleetId, authKey).catch(() => null);
      if (live()) setCheck({ state: 'done', result, info, at: Date.now() });
    } catch (e) {
      if (!live()) return;
      if (isAuthError(e)) { onAuthError?.('Session expired. Please sign in again.'); return; }
      setCheck({ state: 'failed' });
    }
  }
  function close() {
    current.current++;
    onClose();
  }
  function downloadProof() {
    if (check.state !== 'done') return;
    const report = { fleetId, checkedAt: new Date(check.at).toISOString(), result: check.result, integrity: check.info };
    saveBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `whiteroom-audit-check-${new Date(check.at).toISOString().slice(0, 10)}.json`);
  }
  const summary = check.state === 'done' ? auditCheckText(check.result, check.info) : null;
  return (
    <DialogFrame open={open} onCancel={close} onOpen={() => void run()} labelledBy="home-audit-check-title">
      <div className="wr-home-dialog">
        <h2 id="home-audit-check-title" className="wr-home-dialog__title">Audit trail check</h2>
        <div className="wr-home-auditbox" aria-live="polite">
          {check.state === 'checking' && <span className="wr-home-dialog__sub">Checking your audit trail…</span>}
          {check.state === 'failed' && <span>The check didn&rsquo;t run. Close this and try again.</span>}
          {summary && (
            <>
              <svg width="22" height="22" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none' }}>
                <circle cx="9" cy="9" r="8" fill="none" stroke={summary.tone === 'ok' ? 'var(--ok)' : summary.tone === 'bad' ? 'var(--bad)' : 'var(--tx2)'} strokeWidth="1.5" />
                {summary.tone === 'ok' && <path d="M5 9.2l2.6 2.6L13 6.5" fill="none" stroke="var(--ok)" strokeWidth="1.6" />}
                {summary.tone === 'bad' && <path d="M9 5v5M9 12.5v.5" fill="none" stroke="var(--bad)" strokeWidth="1.6" />}
              </svg>
              <div><strong>{summary.title}</strong><div className="wr-home-dialog__sub" style={{ marginTop: 4 }}>{summary.detail}</div></div>
            </>
          )}
        </div>
        {check.state === 'done' && (
          <p className="wr-home-dialog__sub" style={{ margin: 0 }}>
            Checked {check.result.cached ? 'in the last minute' : 'just now'}{check.info && !check.info.anchoring.enabled ? ' · not yet anchored outside WhiteRoom' : ''}.
          </p>
        )}
        <div className="wr-dialog-actions wr-home-dialog__actions">
          <Button onClick={downloadProof} disabled={check.state !== 'done'}>Download proof</Button>
          <Button variant="primary" onClick={close}>Done</Button>
        </div>
      </div>
    </DialogFrame>
  );
}

/** What a chain check found, in words: "Nothing changed or missing" only when every event checked out. */
export function auditCheckText(r: VerifyAuditResult, info: AuditIntegrity | null): { tone: 'ok' | 'bad' | 'neutral'; title: string; detail: string } {
  if (r.valid === false) return { tone: 'bad', title: 'A problem was found', detail: r.message };
  const before = info && (info.prunedBeforeTracking || info.legacyEvents > 0) ? ' Events before tracking started aren’t covered.' : '';
  const gaps = info && info.gaps.count > 0 ? ` ${info.gaps.count} recorded ${info.gaps.count === 1 ? 'gap' : 'gaps'} where events may be missing.` : '';
  // Green only for a whole check: the engine says complete, or (when it doesn't say) every recorded event is verified.
  const whole = r.valid === true && (r.complete ?? (!!info && info.headSeq > 0 && info.verifiedThroughSeq >= info.headSeq));
  if (whole) {
    const all = info?.headSeq ? `All ${fmtCount(info.headSeq)} events verified.` : `All ${fmtCount(r.eventsVerified)} events verified.`;
    return { tone: gaps ? 'neutral' : 'ok', title: gaps ? 'Nothing changed' : 'Nothing changed or missing', detail: `${all}${before}${gaps}` };
  }
  // A partial check says only what it covered.
  const through = info?.headSeq ? `Verified through event ${fmtCount(info.verifiedThroughSeq || r.eventsVerified)} of ${fmtCount(info.headSeq)}.` : `${fmtCount(r.eventsVerified)} events verified.`;
  if (r.valid === true) return { tone: 'neutral', title: 'Nothing changed in the events checked', detail: `${through}${before} The rest hasn’t been checked yet.` };
  return { tone: 'neutral', title: 'Checked part of the trail', detail: `${fmtCount(r.eventsVerified)} events checked so far. Open this again to continue.` };
}
