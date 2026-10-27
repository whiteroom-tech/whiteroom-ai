'use client';

import { useRef, useState } from 'react';
import { Button, SelectChip } from '@whiteroom/ui';
import { DialogFrame } from '@/components/citadel/DialogFrame';
import { fmtCount } from '@/lib/format';
import { saveBlob } from '@/lib/download';
import { auditIntegrity, verifyAudit } from '@/lib/whiteroom/client';
import type { AuditIntegrity, VerifyAuditResult } from '@/lib/whiteroom/types';
import { dayLabel, exportDays, zoneName, type ExportSpan } from '@/lib/runs';

/**
 * Runs › Export .xlsx: which days (yesterday, last 7, last 30), which agents,
 * and the time zone the file uses. Download hands the choice back; the page
 * builds the file and says how it went.
 */
export function ExportRunsDialog({ open, agents, initialAgent, shown, busy, error, onDownload, onCancel }: {
  open: boolean;
  /** When the page shows something narrower than a preset (a day, an hour, a filter): what it shows, offered first. */
  shown?: string | null;
  agents: string[];
  initialAgent: string;
  busy: boolean;
  /** Why the last try failed, shown in the dialog. */
  error: string | null;
  onDownload: (choice: { span: ExportSpan; agent: string }) => void;
  onCancel: () => void;
}) {
  const first: ExportSpan = shown ? 'shown' : '7d';
  const [span, setSpan] = useState<ExportSpan>(first);
  const [agent, setAgent] = useState(initialAgent);
  const now = Date.now();
  const md = (d: string) => dayLabel(d, now, false).replace(/^\w+, /, '');
  const y = exportDays('yesterday', now);
  const w = exportDays('7d', now);
  const options: { value: ExportSpan; label: string; sub: string }[] = [
    ...(shown ? [{ value: 'shown' as const, label: 'What’s shown now', sub: shown }] : []),
    { value: 'yesterday', label: 'Yesterday', sub: dayLabel(y.fromDay, now, false) },
    { value: '7d', label: 'Last 7 days', sub: `${md(w.fromDay)} – ${md(w.toDay)}` },
    { value: '30d', label: 'Last 30 days', sub: 'Everything kept on your plan' },
  ];
  return (
    <DialogFrame open={open} busy={busy} onCancel={onCancel} onOpen={() => { setSpan(first); setAgent(initialAgent); }} labelledBy="export-runs-title">
      <form method="dialog" className="wr-runs-dialog" onSubmit={(e) => { e.preventDefault(); onDownload({ span, agent }); }}>
        <h2 id="export-runs-title" className="wr-runs-dialog__title">Export runs</h2>
        <fieldset className="wr-runs-dialog__set">
          <legend className="wr-runs-dialog__label">Which days</legend>
          {options.map((o) => (
            <label key={o.value} className="wr-runs-opt">
              <input type="radio" name="export-span" value={o.value} checked={span === o.value} onChange={() => setSpan(o.value)} />
              <span>{o.label}<br /><span className="wr-runs-dialog__sub">{o.sub}</span></span>
            </label>
          ))}
        </fieldset>
        <div style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
          {/* The select carries the same name for screen readers. */}
          <span className="wr-runs-dialog__label" aria-hidden="true">Agents</span>
          <SelectChip label="Agents" value={agent} onChange={setAgent} options={[{ value: 'all', label: 'All agents' }, ...agents.map((a) => ({ value: a, label: a }))]} />
        </div>
        <p className="wr-runs-dialog__sub" style={{ margin: 0 }}>Times are in your time zone ({zoneName()}). Each row is one run, with its spend and anything your rules caught.</p>
        {error && <p role="alert" style={{ margin: 0, color: 'var(--bad)', fontSize: 'var(--fs-sm)' }}>{error}</p>}
        <div className="wr-dialog-actions wr-runs-dialog__actions">
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} busyLabel="Preparing…">Download .xlsx</Button>
        </div>
      </form>
    </DialogFrame>
  );
}

type AuditCheck =
  | { state: 'checking' }
  | { state: 'done'; result: VerifyAuditResult; info: AuditIntegrity | null; at: number }
  | { state: 'failed' };

/**
 * Check audit trail: runs the engine's chain check when opened and says what
 * it found, plainly. Download proof saves the check's result as a file.
 */
export function AuditCheckDialog({ open, fleetId, authKey, onClose, onDownloaded, preview }: {
  open: boolean;
  fleetId: string | null;
  authKey?: string;
  onClose: () => void;
  onDownloaded: () => void;
  /** /dev/runs: a sample result; nothing is fetched. */
  preview?: { result: VerifyAuditResult; info: AuditIntegrity | null };
}) {
  const [check, setCheck] = useState<AuditCheck>({ state: 'checking' });
  // Each opening is one check: a check from an earlier opening that answers late is ignored.
  const current = useRef(0);
  async function run() {
    const id = ++current.current;
    const live = () => id === current.current;
    if (preview) { setCheck({ state: 'done', ...preview, at: Date.now() }); return; }
    if (!fleetId) { setCheck({ state: 'failed' }); return; }
    setCheck({ state: 'checking' });
    try {
      const result = await verifyAudit(fleetId, authKey);
      const info = await auditIntegrity(fleetId, authKey).catch(() => null);
      if (live()) setCheck({ state: 'done', result, info, at: Date.now() });
    } catch {
      if (live()) setCheck({ state: 'failed' });
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
    onDownloaded();
  }
  const summary = check.state === 'done' ? auditCheckText(check.result, check.info) : null;
  return (
    <DialogFrame open={open} onCancel={close} onOpen={() => void run()} labelledBy="audit-check-title">
      <div className="wr-runs-dialog">
        <h2 id="audit-check-title" className="wr-runs-dialog__title">Audit trail check</h2>
        <div className="wr-runs-auditbox" aria-live="polite">
          {check.state === 'checking' && <span className="wr-runs-dialog__sub">Checking your audit trail…</span>}
          {check.state === 'failed' && <span>The check didn&rsquo;t run. Close this and try again.</span>}
          {summary && (
            <>
              <svg width="22" height="22" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none' }}>
                <circle cx="9" cy="9" r="8" fill="none" stroke={summary.tone === 'ok' ? 'var(--ok)' : summary.tone === 'bad' ? 'var(--bad)' : 'var(--tx2)'} strokeWidth="1.5" />
                {summary.tone === 'ok' && <path d="M5 9.2l2.6 2.6L13 6.5" fill="none" stroke="var(--ok)" strokeWidth="1.6" />}
                {summary.tone === 'bad' && <path d="M9 5v5M9 12.5v.5" fill="none" stroke="var(--bad)" strokeWidth="1.6" />}
              </svg>
              <div><strong>{summary.title}</strong><div className="wr-runs-dialog__sub" style={{ marginTop: 4 }}>{summary.detail}</div></div>
            </>
          )}
        </div>
        {check.state === 'done' && (
          <p className="wr-runs-dialog__sub" style={{ margin: 0 }}>
            Checked {check.result.cached ? 'in the last minute' : 'just now'}{check.info && !check.info.anchoring.enabled ? ' · not yet anchored outside WhiteRoom' : ''}.
          </p>
        )}
        <div className="wr-dialog-actions wr-runs-dialog__actions">
          <Button onClick={downloadProof} disabled={check.state !== 'done'}>Download proof</Button>
          <Button variant="primary" onClick={close}>Done</Button>
        </div>
      </div>
    </DialogFrame>
  );
}

/** What a chain check found, in words: "Nothing changed or missing" only when every event checked out. */
export function auditCheckText(r: VerifyAuditResult, info: AuditIntegrity | null): { tone: 'ok' | 'bad' | 'neutral'; title: string; detail: string } {
  const head = info?.headSeq;
  const through = head ? `Verified through event ${fmtCount(info!.verifiedThroughSeq || r.eventsVerified)} of ${fmtCount(head)}.` : `${fmtCount(r.eventsVerified)} events verified.`;
  const before = info && (info.prunedBeforeTracking || info.legacyEvents > 0) ? ' Events before tracking started aren’t covered.' : '';
  const gaps = info && info.gaps.count > 0 ? ` ${info.gaps.count} recorded ${info.gaps.count === 1 ? 'gap' : 'gaps'} where events may be missing.` : '';
  if (r.valid === false) return { tone: 'bad', title: 'A problem was found', detail: r.message };
  // Green only for a whole check whose coverage is known: a partial one, or one whose extent couldn't be read, says less.
  if (r.valid === true && r.complete !== false && info) return { tone: gaps ? 'neutral' : 'ok', title: gaps ? 'Nothing changed' : 'Nothing changed or missing', detail: `${through}${before}${gaps}` };
  if (r.valid === true && r.complete !== false) return { tone: 'neutral', title: 'Nothing changed in the events checked', detail: `${through} How much of the trail that covers couldn’t be read just now.` };
  return { tone: 'neutral', title: 'Checked part of the trail', detail: `${fmtCount(r.eventsVerified)} events checked so far. Open this again to continue.` };
}
