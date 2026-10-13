'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { FONT_MONO, Tag } from '@whiteroom/ui';
import { pastKind, pastResult, pastTasks, practiceAgent, RETENTION } from '@/lib/sandbox/practice/model';
import type { PracticeRunRow } from '@/lib/sandbox/practice/types';
import { ROUTES } from '@/lib/routes';
import s from '../guided.module.css';

/** "Sep 30, 2026, 1:52 pm". */
const full = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/\s(AM|PM)$/, (m) => m.toLowerCase());

/** A practice test's Past tests row, opened beneath it like a Sandbox test’s. */
export function PracticePastDetail({ row, onClose }: { row: PracticeRunRow; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, [row.id]);
  const result = pastResult(row);
  return (
    <div ref={ref} tabIndex={-1} className={s.pastDetail} role="region" aria-labelledby="practice-past-detail" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className={s.pastDetailHead}>
        <h3 id="practice-past-detail" className={s.pastDetailTitle}>Practice test ended {full(row.endedAt ?? row.createdAt)}</h3>
        <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={onClose} style={{ minHeight: 30, padding: '4px 10px' }}>Close</button>
      </div>
      <dl className={s.pastDetailList}>
        <dt>Result</dt><dd><Tag tone={result.tone}>{result.label}</Tag>{row.checks && <span className={s.small}> {row.checks.passed} of {row.checks.total} checks passed</span>}</dd>
        <dt>Tasks</dt><dd>{pastTasks(row)} <span className={s.small}>(practice tasks and control checks)</span></dd>
        <dt>Kind</dt><dd>{pastKind(row)} · {row.runs} run{row.runs === 1 ? '' : 's'}</dd>
        <dt>Agent</dt><dd>{practiceAgent(row.sample, row.agentId)}</dd>
        <dt>Test ID</dt><dd style={{ fontFamily: FONT_MONO, overflowWrap: 'anywhere' }}>{row.id}</dd>
      </dl>
      <p className={s.small} style={{ margin: '10px 0 0' }}>
        {RETENTION} <Link href={`${ROUTES.practiceTest}?run=${row.id}`}>Open the result</Link>
      </p>
    </div>
  );
}
