'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { CATALOG, memberLine, ROW_GROUPS, type PreflightRow } from '@/lib/sandbox/practice/model';
import type { PracticeCheck } from '@/lib/sandbox/practice/types';
import { ROUTES } from '@/lib/routes';
import s from '../guided.module.css';
import p from './practice.module.css';

const OBSERVERS = CATALOG.observers as Record<PracticeCheck['observer'], string>;

const ICON = {
  pass: <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2.5 6l2.5 2.5 4.5-4.5" /></svg>,
  fail: <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 2.5v4M6 9.2v.1" /></svg>,
  wait: <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h6" /></svg>,
  now: <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4.5 3l3 3-3 3" /></svg>,
};

/** How a row's mark looks: good, bad, in progress, or neither (not set up, not checked, still to come). */
export type RowTone = 'pass' | 'fail' | 'now' | 'muted';

/** One of the seven rows as a screen shows it: setup's plan, the live list or the result. */
export interface RowItem {
  row: PreflightRow;
  tone: RowTone;
  /** "Passed", "Not set up", "Will be checked"… */
  label: string;
  reason?: string;
  addInControls?: boolean;
  /** What's under the row's <details>: its checks or rules. */
  details?: ReactNode;
  /** The <details> summary: "3 checks", "7 rules". */
  detailsLabel?: string;
  /** Show the details without a click. */
  open?: boolean;
}

function Row({ item }: { item: RowItem }) {
  const tone = item.tone === 'pass' ? s.checkPass : item.tone === 'fail' ? s.checkFail : item.tone === 'now' ? s.checkWait : p.checkMuted;
  const icon = item.tone === 'pass' ? ICON.pass : item.tone === 'fail' ? ICON.fail : item.tone === 'now' ? ICON.now : ICON.wait;
  return (
    <li className={s.check}>
      <div className={`${s.checkIcon} ${tone}`} aria-hidden="true">{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className={s.checkName}>{item.row.name}</div>
        <div className={`${s.checkDetail} ${item.tone === 'pass' ? s.checkDetailPass : ''}`}>
          <strong>{item.label}</strong>{item.reason ? ` · ${item.reason}` : ''}
          {item.addInControls && <> · <Link className={s.linkBtn} href={ROUTES.controls}>Add in Controls</Link></>}
        </div>
        {item.details && (
          <details className={p.members} open={item.open}>
            <summary>{item.detailsLabel ?? 'Details'}</summary>
            {item.details}
          </details>
        )}
      </div>
    </li>
  );
}

/** The seven rows in their two groups ("The agent", "The guardrails"), in the catalog's order. */
export function RowGroups({ items }: { items: RowItem[] }) {
  return <>
    {ROW_GROUPS.map((g) => (
      <section key={g} className={p.group} aria-label={g}>
        <h3 className={p.groupTitle}>{g}</h3>
        <ul className={p.rows}>{items.filter((i) => i.row.group === g).map((i) => <Row key={i.row.id} item={i} />)}</ul>
      </section>
    ))}
  </>;
}

/** One check a row was judged on: its result, what happened and how we know. */
export function MemberCheck({ c }: { c: PracticeCheck }) {
  const control = c.id.startsWith('ctl');
  return (
    <div className={p.member}>
      <div className={p.memberName}>{c.mode ? `${c.label} · ${c.mode}` : c.label}</div>
      <div className={p.memberText}>{memberLine(c)}</div>
      {(c.status !== 'unsupported' || !control) && <div className={p.how}>How we know: {OBSERVERS[c.observer]}</div>}
    </div>
  );
}
