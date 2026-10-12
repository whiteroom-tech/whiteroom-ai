'use client';

import { useEffect, useRef, useState } from 'react';
import { DataTable, Hint, Panel, Tag, FONT_MONO } from '@whiteroom/ui';
import { getHistory, type PastTest } from '@/lib/sandbox/api';
import { HELP } from '@/lib/metric-definitions';
import s from './guided.module.css';

const RESULT: Record<PastTest['overall'], { label: string; tone: 'brand' | 'warn' | 'muted' }> = {
  pass: { label: 'All checks passed', tone: 'brand' },
  partial: { label: 'Some checks passed', tone: 'warn' },
  fail: { label: 'Checks didn’t pass', tone: 'muted' },
  empty: { label: 'Not tested', tone: 'muted' },
};

/** When the engine started recording "empty" (engine PR 207, live 2026-10-12 15:42 UTC). */
export const EMPTY_RECORDED_SINCE = Date.parse('2026-10-12T15:42:00Z');

/**
 * The result to show. Before engine PR 207 a test that ended with nothing
 * checked was recorded as "partial". Its task count only counts calls that
 * came back OK, so an older "partial" with 0 tasks means no call ever worked:
 * Not tested. Newer records are shown as stored.
 */
export function pastResult(t: Pick<PastTest, 'overall' | 'totalTasks' | 'destroyedAt'>): PastTest['overall'] {
  const legacy = Date.parse(t.destroyedAt) < EMPTY_RECORDED_SINCE;
  return legacy && t.overall === 'partial' && t.totalTasks === 0 ? 'empty' : t.overall;
}

/** "Sep 30, 1:52 pm" in the viewer's time zone. */
function ended(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toLowerCase()}`;
}

/** "Sep 30, 2026, 1:52 pm". */
function endedFull(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/\s(AM|PM)$/, (m) => m.toLowerCase());
}

/** What history keeps about one test, which is all that's left once it ends. */
export function PastTestDetail({ test, onClose }: { test: PastTest; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
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
      <p className={s.small} style={{ margin: '10px 0 0' }}>Each check’s result and the activity aren’t kept after a test ends. To keep them, download the report before you end a test.</p>
    </div>
  );
}

/**
 * Sandbox › Past tests (README › Screens › 7b): the owner's finished tests,
 * newest first. The engine keeps them across restarts. A row opens what's kept
 * about that test. Quiet if the list can't be loaded; says so when there are
 * none yet. It mounts on the start step, so returning there after a test
 * reloads the list.
 */
export function PastTests({ preview, onDemo }: { preview?: PastTest[]; onDemo?: () => void }) {
  const [tests, setTests] = useState<PastTest[] | null>(preview ?? null);
  const [open, setOpen] = useState<string | null>(null);
  const table = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (preview) return;
    let live = true;
    getHistory().then((r) => { if (live && Array.isArray(r.sessions)) setTests([...r.sessions].reverse()); }, () => {});
    return () => { live = false; };
  }, [preview]);

  if (!tests) return null;
  if (!tests.length) {
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
  const selected = tests.find((t) => t.sandboxId === open) ?? null;
  const close = () => {
    const i = tests.findIndex((t) => t.sandboxId === open);
    setOpen(null);
    // Back to the row that opened it.
    requestAnimationFrame(() => table.current?.querySelectorAll<HTMLElement>('[role="row"][tabindex]')[i]?.focus());
  };
  return (
    <div style={{ marginTop: 24 }}>
      <Panel title={<>Past tests<Hint text={HELP.pastTests} /></>} count={String(tests.length)} bodyPadding={0}>
        <div ref={table}>
          <DataTable<PastTest>
            caption="Past tests, newest first. Open a row for what’s kept about that test."
            rows={tests}
            rowKey={(t) => t.sandboxId}
            rowHeight={40}
            onOpen={(t) => setOpen((cur) => (cur === t.sandboxId ? null : t.sandboxId))}
            selectedKey={open ?? undefined}
            columns={[
              { key: 'when', header: 'Ended', width: '150px', render: (t) => <span style={{ fontFamily: FONT_MONO, color: 'var(--tx2)' }}>{ended(t.destroyedAt)}</span> },
              { key: 'result', header: 'Result', width: 'minmax(160px, 1fr)', render: (t) => { const r = RESULT[pastResult(t)]; return <Tag tone={r?.tone ?? 'muted'}>{r?.label ?? t.overall}</Tag>; } },
              { key: 'calls', header: 'Tasks', width: '72px', numeric: true, render: (t) => String(t.totalTasks) },
              { key: 'kind', header: 'Kind', width: '90px', render: (t) => <span style={{ color: 'var(--tx2)' }}>{t.isTrial ? 'Demo' : 'Your agent'}</span> },
            ]}
          />
        </div>
        {selected && <PastTestDetail test={selected} onClose={close} />}
      </Panel>
    </div>
  );
}
