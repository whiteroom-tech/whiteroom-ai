'use client';

// "Check audit trail": runs the same check as Settings › Audit integrity
// (verify_audit, then audit_integrity for how far it reaches) and says the
// result in one box. The full signed export stays in Settings.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@whiteroom/ui';
import { DialogFrame } from '@/components/citadel/DialogFrame';
import { coverageLine } from '@/components/settings/AuditIntegritySection';
import { auditIntegrity, verifyAudit, WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { AuditIntegrity, VerifyAuditResult } from '@/lib/whiteroom/types';
import { fmtCount } from '@/lib/format';
import { ROUTES } from '@/lib/routes';

type State =
  | { kind: 'checking' }
  | { kind: 'done'; result: VerifyAuditResult; info: AuditIntegrity | null }
  | { kind: 'untracked' }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

export function AuditCheckDialog({ open, fleetId, onClose }: { open: boolean; fleetId: string; onClose: () => void }) {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const run = useRef(0);

  const check = useCallback(async () => {
    const id = ++run.current;
    setState({ kind: 'checking' });
    try {
      // How far tracking reaches first: a fleet that hasn't started has nothing to check.
      const before = await auditIntegrity(fleetId);
      if (id !== run.current) return;
      if (before.mode !== 'sequenced') { setState({ kind: 'untracked' }); return; }
      const result = await verifyAudit(fleetId);
      const info = await auditIntegrity(fleetId).catch(() => before);
      if (id === run.current) setState({ kind: 'done', result, info });
    } catch (e) {
      if (id !== run.current) return;
      setState(e instanceof WhiteRoomApiError && e.status === 400 && e.reason === 'Unknown action.' ? { kind: 'unavailable' } : { kind: 'failed' });
    }
  }, [fleetId]);

  useEffect(() => {
    if (open) void check();
    else run.current++;
  }, [open, check]);

  const ok = state.kind === 'done' && state.result.valid === true;
  const bad = state.kind === 'done' && state.result.valid === false;

  return (
    <DialogFrame open={open} onCancel={onClose} labelledBy="audit-check-title">
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 id="audit-check-title" className="ctl-dlg__title">Audit trail check</h2>
        <div role="status" className={`ctl-audit${ok ? ' is-ok' : bad ? ' is-bad' : ''}`}>
          {(ok || bad) && (
            <svg width="22" height="22" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none' }}>
              <circle cx="9" cy="9" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              {ok ? <path d="M5 9.2l2.6 2.6L13 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" /> : <path d="M9 5v5M9 12.5v.5" stroke="currentColor" strokeWidth="1.6" />}
            </svg>
          )}
          <div style={{ minWidth: 0 }}>
            {state.kind === 'checking' && <strong>Checking…</strong>}
            {state.kind === 'untracked' && <strong>History tracking hasn’t started for this fleet yet.</strong>}
            {state.kind === 'unavailable' && <strong>The audit check isn’t available for this fleet yet.</strong>}
            {state.kind === 'failed' && <strong>The check didn’t run. Try again.</strong>}
            {state.kind === 'done' && (
              <>
                <strong>{ok ? 'Nothing changed or missing' : bad ? 'A problem was found' : `${fmtCount(state.result.eventsVerified)} events checked so far`}</strong>
                <div className="ctl-cap" style={{ marginTop: 4 }}>
                  {bad ? state.result.message
                    : !ok ? 'Run the check again to continue.'
                    : state.info ? `${coverageLine(state.info.verifiedThroughSeq, state.info.headSeq, 'just now')}.${state.info.prunedBeforeTracking ? ' Events before tracking started aren’t covered.' : ''}`
                    : `All ${fmtCount(state.result.eventsVerified)} events check out.`}
                </div>
                {state.info && state.info.gaps.count > 0 && (
                  <div className="ctl-cap" style={{ marginTop: 4 }}>{state.info.gaps.count} {state.info.gaps.count === 1 ? 'gap' : 'gaps'} recorded where events may be missing.</div>
                )}
              </>
            )}
          </div>
        </div>
        <p className="ctl-cap" style={{ margin: 0 }}>Not yet anchored outside WhiteRoom. The signed export is in <Link href={`${ROUTES.settings}#audit-integrity`} style={{ color: 'var(--brand)', fontWeight: 600 }}>Settings › Audit integrity</Link>.</p>
        <div className="wr-dialog-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          {(state.kind === 'failed' || (state.kind === 'done' && state.result.valid === null)) && <Button onClick={() => void check()}>Check again</Button>}
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </DialogFrame>
  );
}
