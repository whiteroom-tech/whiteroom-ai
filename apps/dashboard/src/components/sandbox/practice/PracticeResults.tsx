'use client';

import type { RefObject } from 'react';
import Link from 'next/link';
import { FONT_DISPLAY } from '@whiteroom/ui';
import {
  billedLine, CATALOG, DISCLAIMER, endedBecause, fixLine, headline, isPracticeProvider, openChecks, passCaveat, practiceAgent, rerunScope, shortId, STATUS_LABEL,
} from '@/lib/sandbox/practice/model';
import { canDownload } from '@/lib/sandbox/practice/report';
import type { PracticeCheck, PracticeReport, PracticeResult, PracticeRun } from '@/lib/sandbox/practice/types';
import { ROUTES } from '@/lib/routes';
import s from '../guided.module.css';
import p from './practice.module.css';

const OBSERVERS = CATALOG.observers as Record<PracticeCheck['observer'], string>;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const ICON = {
  pass: <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2.5 6l2.5 2.5 4.5-4.5" /></svg>,
  fail: <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 2.5v4M6 9.2v.1" /></svg>,
  wait: <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h6" /></svg>,
};

function CheckRow({ c }: { c: PracticeCheck }) {
  const tone = c.status === 'passed' ? s.checkPass : c.status === 'failed' ? s.checkFail : s.checkWait;
  const control = c.id.startsWith('ctl');
  return (
    <div className={s.check}>
      <div className={`${s.checkIcon} ${tone}`} aria-hidden="true">{c.status === 'passed' ? ICON.pass : c.status === 'failed' ? ICON.fail : ICON.wait}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className={s.checkName}>{c.mode ? `${c.label} · ${c.mode}` : c.label}</div>
        <div className={`${s.checkDetail} ${c.status === 'passed' ? s.checkDetailPass : ''}`}>
          {c.status === 'unsupported' ? c.summary : `${STATUS_LABEL[c.status]}${c.summary ? ` · ${c.summary}` : ''}`}
        </div>
        {(c.status !== 'unsupported' || !control) && <div className={p.how}>How we know: {OBSERVERS[c.observer]}</div>}
      </div>
    </div>
  );
}

/** Checks by scenario, in the catalog's order, then the controls. */
function CheckGroups({ r }: { r: PracticeReport }) {
  const groups = [...new Set(r.checks.map((c) => c.scenario))];
  const controlsRan = r.checks.some((c) => c.id.startsWith('ctl'));
  return <>
    {groups.map((g) => (
      <section key={g} className={p.group} aria-label={g}>
        <h3 className={p.groupTitle}>{g}</h3>
        {r.checks.filter((c) => c.scenario === g).map((c) => <CheckRow key={c.id} c={c} />)}
        {g === CATALOG.controls.scenario && !r.checks.some((c) => c.id === 'ctl.pause_stop') && <p className={s.small}>Pause and Stop: not checked on this fleet.</p>}
      </section>
    ))}
    {!controlsRan && !r.scope && <p className={s.small}>No controls are set on this fleet, so none were checked.</p>}
  </>;
}

export type ResultAction = { kind: 'rerun'; scope: string[] } | { kind: 'three' };

/**
 * A practice test's result (§8): the verdict, what to fix or what stopped it,
 * every check with how we know, what was tested, and the next step. A test
 * that was ended has no result, only why it stopped.
 */
export function PracticeResults({ run, result, busy, heading, onAction, onDownload }: {
  run: PracticeRun;
  result: PracticeResult | null;
  busy: boolean;
  /** Focused when the result arrives. */
  heading?: RefObject<HTMLHeadingElement | null>;
  onAction: (a: ResultAction) => void;
  onDownload: () => void;
}) {
  const r = result?.report ?? null;
  const ended = run.lifecycle !== 'finished';
  const head = r ? headline(r) : 'Didn’t finish';
  const tone = r?.verdict === 'passed' ? s.summaryPass : r?.verdict === 'not_passed' ? s.summaryFail : '';
  const scope = r ? rerunScope(r) : null;
  const caveat = r ? passCaveat(r) : null;
  const open = r ? openChecks(r).filter((c) => c.status !== 'passed') : [];
  const fixes = r ? open.map((c) => ({ c, fix: fixLine(c, r) })).filter((x) => x.fix) : [];
  const who = practiceAgent(run.sample, run.agentId);
  const model = r?.tested.modelsUsed[0] ?? r?.tested.modelRequested;
  const provider = r?.tested.provider;

  return (
    <div className={p.wrap}>
      <div className={s.eyebrow}>WHITEROOM / SANDBOX / PRACTICE TEST</div>
      <div className={`${s.summary} ${tone}`}>
        <h2 ref={heading} tabIndex={-1} className={s.summaryHead} style={{ fontFamily: FONT_DISPLAY, fontSize: 'var(--fs-card)' }}>{head}</h2>
        <div>{[run.sourceFleetId, who, model, run.endedAt && when(run.endedAt)].filter(Boolean).join(' · ')}</div>
        {caveat && <div style={{ marginTop: 4 }}>{caveat}</div>}
        {!ended && run.endReason && <div style={{ marginTop: 4 }}>{endedBecause(run.endReason)}</div>}
      </div>

      {(ended || !r) && (
        <section className={s.card}>
          <h3 className={s.sectionTitle}>What stopped the test</h3>
          <p>{ended ? endedBecause(run.endReason) : 'This result is no longer kept: results are kept for 30 days.'}</p>
          <Link className={`${s.btn} ${s.btnPrimary}`} href={ROUTES.practiceTest}>Start a new test</Link>
        </section>
      )}

      {r && <>
        {fixes.length > 0 && (
          <section className={s.card}>
            <h3 className={s.sectionTitle}>{r.verdict === 'incomplete' ? 'What stopped the test' : 'What to fix'}</h3>
            {fixes.map(({ c, fix }) => (
              <div key={c.id} style={{ marginBottom: 10 }}>
                <div className={s.checkName}>{c.mode ? `${c.label} · ${c.mode}` : c.label}</div>
                <p className={p.fix}>{fix}</p>
              </div>
            ))}
          </section>
        )}

        <div className={s.btnRow} style={{ marginBottom: 14 }}>
          {scope && <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => onAction({ kind: 'rerun', scope })}>
            {r.verdict === 'not_passed' ? 'Rerun failed checks' : 'Rerun checks that didn’t run'}
          </button>}
          {r.verdict === 'passed' && !r.sample && r.runs === 1 && <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => onAction({ kind: 'three' })}>Run it 3 times</button>}
          {canDownload(r) ? <button type="button" className={`${s.btn} ${s.btnSecondary}`} disabled={busy} onClick={onDownload}>Download report</button>
            : <span className={s.small} style={{ alignSelf: 'center' }}>{r.sample ? 'Reports come from a test of your own agent.' : 'Reports come from a full test.'}</span>}
        </div>

        <section className={s.card} aria-label="Checks">
          <CheckGroups r={r} />
        </section>

        <details className={s.card}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>What was tested</summary>
          <dl className={p.facts}>
            <dt>Fleet</dt><dd>{r.tested.fleet}</dd>
            <dt>Agent</dt><dd>{practiceAgent(r.sample, r.tested.agent)} <span className={s.small}>(sent by the CLI, not verified)</span></dd>
            {provider && <><dt>Provider</dt><dd>{isPracticeProvider(provider) ? CATALOG.providers[provider].label : provider}
              {r.tested.proxyKeyDisplayPrefix && <span className={s.small}> (the key you picked from Fleet key{r.tested.keyHint ? `, ending ${r.tested.keyHint}` : ''})</span>}</dd></>}
            <dt>Adapter (reported by the CLI)</dt><dd>{r.tested.adapter ?? '—'}</dd>
            <dt>Model asked for</dt><dd>{r.tested.modelRequested ?? '—'}</dd>
            <dt>Model used</dt><dd>{r.tested.modelsUsed.join(', ') || '—'}</dd>
            <dt>Runs</dt><dd>{r.runs}{r.scope ? ` · rerun of ${r.scope.length} check${r.scope.length === 1 ? '' : 's'}` : ''}</dd>
            <dt>CLI version</dt><dd>{r.tested.cli ?? '—'}</dd>
            <dt>Test version</dt><dd>{r.testVersion}</dd>
            {r.how.memoryLimitAdjusted && <><dt>Memory</dt><dd>Memory limit adjusted during the test</dd></>}
          </dl>
        </details>
        <p className={s.small}>{billedLine(r)}</p>
      </>}

      <p className={s.small}>{DISCLAIMER}</p>
      <div className={s.footer}>
        {[
          result?.detailsKeptUntil && `Full details kept until ${day(result.detailsKeptUntil)}`,
          result?.summaryKeptUntil && `this result until ${day(result.summaryKeptUntil)}`,
          `Test ${shortId(run.id)}`,
        ].filter(Boolean).join(' · ')}
      </div>
    </div>
  );
}
