'use client';

import { useEffect, useRef, useState } from 'react';
import { DataTable, Hint, Panel, Tag, FONT_MONO } from '@whiteroom/ui';
import { getHistory, getPastReport, type PastTest } from '@/lib/sandbox/api';
import { pastTestReport, saveReportFile } from '@/lib/sandbox/report';
import { analytics } from '@/lib/analytics';
import { HELP } from '@/lib/metric-definitions';
import { fmtTime } from '@/lib/format';
import { formatInZone } from '@/lib/zone-time';
import { isOpen, pastKind, VERDICT_LABEL, pastResult as practiceResult, pastTasks } from '@/lib/sandbox/practice/model';
import type { PracticeRunRow } from '@/lib/sandbox/practice/types';
import { PracticePastDetail } from './practice/PracticePastDetail';
import s from './guided.module.css';

/** Connection-test results in the same words as practice tests: Passed or Didn't pass. */
const RESULT: Record<PastTest['overall'], { label: string; tone: 'brand' | 'warn' | 'muted' }> = {
  pass: { label: VERDICT_LABEL.passed, tone: 'brand' },
  partial: { label: VERDICT_LABEL.not_passed, tone: 'warn' },
  fail: { label: VERDICT_LABEL.not_passed, tone: 'warn' },
  empty: { label: 'Not checked', tone: 'muted' },
};

/** A test with nothing checked, no tasks and no report: it carries nothing, so Past tests leaves it out. */
export const isEmptyTest = (t: Pick<PastTest, 'overall' | 'totalTasks' | 'destroyedAt' | 'hasReport'>) =>
  pastResult(t) === 'empty' && t.totalTasks === 0 && !t.hasReport;

/** When the engine started recording "empty" (engine PR 207, live 2026-10-12 15:42 UTC). */
export const EMPTY_RECORDED_SINCE = Date.parse('2026-10-12T15:42:00Z');

/**
 * The result to show. Before engine PR 207 a test that ended with nothing
 * checked was recorded as "partial". Its task count only counts calls that
 * came back OK, so an older "partial" with 0 tasks means no call ever worked:
 * nothing checked. Newer records are shown as stored.
 */
export function pastResult(t: Pick<PastTest, 'overall' | 'totalTasks' | 'destroyedAt'>): PastTest['overall'] {
  const legacy = Date.parse(t.destroyedAt) < EMPTY_RECORDED_SINCE;
  return legacy && t.overall === 'partial' && t.totalTasks === 0 ? 'empty' : t.overall;
}

/** "Sep 30, 1:52 pm" in the viewer's time zone. */
function ended(iso: string): string {
  return `${formatInZone(iso, { month: 'short', day: 'numeric' })}, ${fmtTime(iso)}`;
}

/** "Sep 30, 2026, 1:52 pm". */
function endedFull(iso: string): string {
  return formatInZone(iso, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/\s(AM|PM)$/, (m) => m.toLowerCase());
}

/** Fetches an ended test's kept report and saves it, in the live download's format. Throws when it can't. */
async function downloadPastReport(test: PastTest): Promise<void> {
  const kept = await getPastReport(test.sandboxId);
  const report = pastTestReport(kept, test.sandboxId);
  if (!report) throw new Error(kept.error ?? 'No report');
  saveReportFile(report);
  analytics.capture('sandbox_report_exported', { mode: report.mode, from: 'past_tests' });
}

/** A Past tests download: in progress, and how the last attempt went. */
export interface DownloadState { saving: boolean; outcome: 'saved' | 'failed' | null }
export const DOWNLOAD_IDLE: DownloadState = { saving: false, outcome: null };

/**
 * One click on Download report: ignored while a download is in progress,
 * else saving until `save` settles, then saved or failed. Returns null when
 * the click was ignored.
 */
export function startDownload(state: DownloadState, save: () => Promise<void>, set: (s: DownloadState) => void): Promise<void> | null {
  if (state.saving) return null;
  set({ saving: true, outcome: null });
  return save().then(() => set({ saving: false, outcome: 'saved' }), () => set({ saving: false, outcome: 'failed' }));
}

/**
 * Download report and its status line. While saving the button is
 * aria-disabled, not disabled, so it keeps focus; the outcome is announced
 * politely.
 */
export function DownloadReport({ state, onClick }: { state: DownloadState; onClick: () => void }) {
  return <>
    <div className={s.btnRow} style={{ marginTop: 10 }}>
      <button type="button" className={`${s.btn} ${s.btnSecondary}`} onClick={onClick} aria-disabled={state.saving || undefined} style={{ fontSize: 'var(--fs-sm)' }}>{state.saving ? 'Downloading…' : 'Download report'}</button>
    </div>
    <p className={s.small} aria-live="polite" style={{ margin: state.outcome ? '6px 0 0' : 0, color: state.outcome === 'failed' ? 'var(--bad)' : undefined }}>
      {state.outcome === 'saved' ? 'Report downloaded.' : state.outcome === 'failed' ? 'Couldn’t get this report. Try again.' : ''}
    </p>
  </>;
}

/** What history keeps about one test, which is all that's left once it ends. */
export function PastTestDetail({ test, onClose, onDownload = downloadPastReport }: {
  test: PastTest;
  onClose: () => void;
  /** Saves the test's report. Defaults to fetching the kept report and saving its file. */
  onDownload?: (test: PastTest) => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [download, setDownload] = useState<DownloadState>(DOWNLOAD_IDLE);
  useEffect(() => { ref.current?.focus(); }, [test.sandboxId]);
  const result = RESULT[pastResult(test)];
  return (
    <div ref={ref} tabIndex={-1} className={s.pastDetail} role="region" aria-labelledby="past-test-detail" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className={s.pastDetailHead}>
        <h3 id="past-test-detail" className={s.pastDetailTitle}>Test ended {endedFull(test.destroyedAt)}</h3>
        <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={onClose} style={{ minHeight: 30, padding: '4px 10px' }}>Close</button>
      </div>
      <dl className={s.pastDetailList}>
        <dt>Result</dt><dd><Tag tone={result?.tone ?? 'muted'}>{result?.label ?? test.overall}</Tag></dd>
        <dt>Tasks</dt><dd>{test.totalTasks} <span className={s.small}>(calls that came back OK)</span></dd>
        <dt>Kind</dt><dd>{test.isTrial ? 'Demo' : 'Your agent'}</dd>
        <dt>Test ID</dt><dd style={{ fontFamily: FONT_MONO, overflowWrap: 'anywhere' }}>{test.sandboxId}</dd>
      </dl>
      {test.hasReport ? <DownloadReport state={download} onClick={() => { void startDownload(download, () => onDownload(test), setDownload); }} /> : <p className={s.small} style={{ margin: '10px 0 0' }}>Each check’s result and the activity aren’t kept after a test ends. To keep them, download the report before you end a test.</p>}
    </div>
  );
}

/** A Past tests row: a Sandbox test, or a finished practice test (spec rev 5.6 §10). */
type Row = { key: string; at: string; test: PastTest; practice?: undefined } | { key: string; at: string; test?: undefined; practice: PracticeRunRow };

/** Sandbox tests (empty ones left out) and finished practice tests together, newest first. */
export function pastRows(tests: PastTest[], practice: PracticeRunRow[] = []): Row[] {
  const rows: Row[] = [
    ...tests.filter((t) => !isEmptyTest(t)).map((t) => ({ key: t.sandboxId, at: t.destroyedAt, test: t })),
    ...practice.filter((r) => !isOpen(r.lifecycle)).map((r) => ({ key: r.id, at: r.endedAt ?? r.createdAt, practice: r })),
  ];
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * Sandbox › Past tests (README › Screens › 7b): the owner's finished tests,
 * newest first. The engine keeps them across restarts. A row opens what's kept
 * about that test directly beneath it. Quiet if the list can't be loaded; says
 * so when there are none yet. It mounts on the start step, so returning there
 * after a test reloads the list. Practice tests, when given, are rows too.
 */
export function PastTests({ preview, onDemo, previewOpen, practice }: {
  preview?: PastTest[];
  onDemo?: () => void;
  /** /dev/sandbox and tests: the test whose row starts open. */
  previewOpen?: string;
  /** The owner's practice tests; open ones aren't listed. */
  practice?: PracticeRunRow[];
}) {
  const [tests, setTests] = useState<PastTest[] | null>(preview ?? null);
  const [open, setOpen] = useState<string | null>(previewOpen ?? null);
  const table = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (preview) return;
    let live = true;
    getHistory().then((r) => { if (live && Array.isArray(r.sessions)) setTests([...r.sessions].reverse()); }, () => {});
    return () => { live = false; };
  }, [preview]);

  if (!tests) return null;
  const rows = pastRows(tests, practice);
  if (!rows.length) {
    return (
      <div style={{ marginTop: 24 }}>
        <Panel title={<>Past tests<Hint text={HELP.pastTests} /></>}>
          <p className={s.pastEmpty}>
            No tests yet. {onDemo ? <button type="button" className={s.linkBtn} onClick={onDemo}>Run the demo</button> : 'Run the demo'} to see what you’ll get.
          </p>
        </Panel>
      </div>
    );
  }
  const close = () => {
    const i = rows.findIndex((r) => r.key === open);
    setOpen(null);
    // Back to the row that opened it.
    requestAnimationFrame(() => table.current?.querySelectorAll<HTMLElement>('[role="row"][tabindex]')[i]?.focus());
  };
  return (
    <div style={{ marginTop: 24 }}>
      <Panel title={<>Past tests<Hint text={HELP.pastTests} /></>} count={String(rows.length)} bodyPadding={0}>
        <div ref={table}>
          <DataTable<Row>
            caption="Past tests, newest first. Open a row for what’s kept about that test."
            rows={rows}
            rowKey={(r) => r.key}
            rowHeight={40}
            onOpen={(r) => setOpen((cur) => (cur === r.key ? null : r.key))}
            selectedKey={open ?? undefined}
            expandedKey={open ?? undefined}
            renderExpanded={(r) => (r.test ? <PastTestDetail test={r.test} onClose={close} /> : <PracticePastDetail row={r.practice} onClose={close} />)}
            columns={[
              { key: 'when', header: 'Ended', width: '150px', render: (r) => <span style={{ color: 'var(--tx)' }}>{ended(r.at)}</span> },
              { key: 'result', header: 'Result', width: 'minmax(160px, 1fr)', render: (r) => {
                const shown = r.test ? RESULT[pastResult(r.test)] : practiceResult(r.practice);
                return <Tag tone={shown?.tone ?? 'muted'}>{shown?.label ?? r.test?.overall}</Tag>;
              } },
              { key: 'calls', header: 'Tasks', width: '72px', numeric: true, render: (r) => (r.test ? String(r.test.totalTasks) : pastTasks(r.practice)) },
              // Wider only when "Practice (sample)" can appear, so Sandbox-only lists look as before.
              { key: 'kind', header: 'Kind', width: rows.some((r) => r.practice) ? '130px' : '90px', render: (r) => <span style={{ color: 'var(--tx2)' }}>{r.test ? (r.test.isTrial ? 'Demo' : 'Your agent') : pastKind(r.practice)}</span> },
            ]}
          />
        </div>
      </Panel>
    </div>
  );
}
