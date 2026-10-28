'use client';

import { type RefObject, useState } from 'react';
import { CopyButton, FONT_DISPLAY } from '@whiteroom/ui';
import {
  ADAPTER_EXPLAINER, ADAPTER_HELP_URL, BETA_INSTALL, cliCommands, CLI_ON_NPM, codeCountdown, keyLine, liveRows, lostContact, progressLine, type PracticeKeyChoice, type StarterLang,
} from '@/lib/sandbox/practice/model';
import type { PracticeRun, RunCode } from '@/lib/sandbox/practice/types';
import s from '../guided.module.css';
import p from './practice.module.css';
import { plural } from '@/lib/format';
import { RowGroups, type RowItem } from './PreflightRows';

const LIVE_LABEL = { done: 'Done', now: 'In progress', todo: 'To do', skip: 'Not part of this rerun' } as const;

/** The seven rows while the test runs (§9 Live): progress only; pass or fail comes with the report. */
export function liveItems(run: PracticeRun): RowItem[] {
  return liveRows(run).map(({ row, state }) => ({ row, tone: state === 'done' ? 'pass' : state === 'now' ? 'now' : 'muted', label: LIVE_LABEL[state] }));
}

function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className={p.copyRow}>
      <pre className={p.cmd}>{text}</pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

/**
 * The terminal steps (Appendix D): install (beta), the starter adapter (own
 * agent), the exact command, then the run code it asks for. The run code is
 * never part of a command and is shown only from this page's memory.
 */
function TerminalSteps({ run, code, keyChoice, now, busy, onNewCode }: {
  run: PracticeRun;
  code: RunCode | null;
  keyChoice: PracticeKeyChoice | null;
  now: number;
  busy: boolean;
  onNewCode: () => void;
}) {
  const [lang, setLang] = useState<StarterLang>('js');
  // --key-env only for a provider the engine named, or a Fleet key key: setup's guess for the fleet's own key could be wrong.
  const cmd = cliCommands(run.sample, lang, run.provider || keyChoice?.fleetKey ? keyChoice?.provider : null);
  const left = code ? codeCountdown(code.codeExpiresAt, now) : null;
  const tries = run.codeTriesLeft;
  const key = keyLine(keyChoice, run.sourceFleetId);
  let n = 0;
  return <>
    {!CLI_ON_NPM && (
      <div className={p.step}>
        <p className={p.stepTitle}>{++n}. Install the WhiteRoom CLI (beta)</p>
        <p className={p.meta}>Use the file from your invite. The sha256 the first line prints must match the one in your invite.</p>
        <Command text={BETA_INSTALL.join('\n')} label="Copy the install commands" />
      </div>
    )}
    {cmd.starter && (
      <div className={p.step}>
        <p className={p.stepTitle}>{++n}. Get the starter adapter</p>
        <p className={p.meta}>{ADAPTER_EXPLAINER} <a className={s.linkBtn} href={ADAPTER_HELP_URL} target="_blank" rel="noopener noreferrer">How it works</a></p>
        <div className={s.selectRow} role="group" aria-label="Adapter language">
          {(['js', 'python'] as const).map((l) => (
            <button key={l} type="button" className={`${s.selectPill} ${lang === l ? s.selectPillOn : ''}`} aria-pressed={lang === l} onClick={() => setLang(l)}>{l === 'js' ? 'JavaScript' : 'Python'}</button>
          ))}
        </div>
        <Command text={cmd.starter} label="Copy the starter adapter command" />
        <p className={p.meta}>Replace its marked function with a call to your agent. Skip this if you already have an adapter.</p>
      </div>
    )}
    <div className={p.step}>
      <p className={p.stepTitle}>{++n}. Run the test</p>
      <Command text={cmd.run} label="Copy the test command" />
      <p className={p.meta}>Needs Node 20 or later. {key.before}<code>{key.keyVar}</code>{key.after} Keep the terminal open and your computer awake. If calls are refused by a network limit, run it from another network.</p>
      <p className={p.meta}>If the terminal says <code>Unknown command: practice</code>, an older WhiteRoom CLI ran instead: {CLI_ON_NPM ? 'copy the command again, it names the right version.' : 'install the beta above, then run the command again.'}</p>
    </div>
    <div className={p.step}>
      <p className={p.stepTitle}>{++n}. Paste this run code when it asks</p>
      {code && left ? <>
        <Command text={code.code} label="Copy run code" />
        <p className={p.meta}>
          Expires in {left}{tries !== null && tries < 5 ? <> · <span className={p.warnText}>{tries} {plural(tries, 'try', 'tries')} left with the wrong key</span></> : null} · Works once.
        </p>
      </> : <p className={p.meta}>{code ? 'This run code has expired.' : 'The run code is shown only once, when it’s made. Get a new one to see it here.'}</p>}
      <button type="button" className={`${s.btn} ${s.btnSecondary}`} disabled={busy} onClick={onNewCode} style={{ marginTop: 8, fontSize: 'var(--fs-sm)' }}>Get a new run code</button>
    </div>
  </>;
}

/** Every practice task ran (not a run ended early, like a crashed adapter's, whose result covers the tasks done). */
const allDone = (run: PracticeRun) => !run.endReason && !!run.progress && run.progress.done >= run.progress.total;

/** A practice test between Start and its result: waiting for the CLI, running, lost contact, finishing. */
export function PracticeRunView({ run, code, keyChoice = null, now, busy, heading, onNewCode, onEnd }: {
  run: PracticeRun;
  heading?: RefObject<HTMLHeadingElement | null>;
  code: RunCode | null;
  /** The key the test runs on (its provider and, for a Fleet key key, its last four); null while that isn't known. */
  keyChoice?: PracticeKeyChoice | null;
  now: number;
  busy: boolean;
  onNewCode: () => void;
  onEnd: () => void;
}) {
  const lost = lostContact(run, now);
  const title = run.lifecycle === 'draft' ? 'Run it from your computer' : run.lifecycle === 'finalizing' ? 'Working out the result' : 'Practice test running';
  return (
    <div className={p.wrap}>
      <h2 ref={heading} className={s.pageTitle} tabIndex={-1} style={{ fontFamily: FONT_DISPLAY }}>{title}</h2>
      {run.lifecycle === 'draft' ? <>
        <p className={s.pageSub}>On the computer where your agent runs. This page updates on its own once the test starts.</p>
        <div className={s.card}>
          <TerminalSteps run={run} code={code} keyChoice={keyChoice} now={now} busy={busy} onNewCode={onNewCode} />
          <p className={s.small} role="status">Waiting for the CLI to start the test…</p>
        </div>
      </> : <>
        {lost && <div className={s.error} role="alert">Lost contact with your computer. Check it’s awake and online, with the terminal still open. The test ends on its own after 5 minutes without contact.</div>}
        <div className={s.card}>
          <p style={{ color: 'var(--tx)' }}>{run.lifecycle !== 'finalizing' ? progressLine(run, now) : allDone(run) ? 'Every practice task is done. The result shows here in a moment.' : 'Working out the result from the practice tasks that ran. It shows here in a moment.'}</p>
        </div>
        <section className={s.card} aria-label="Checks">
          <p className={s.small}>Connected: your computer started the test. Each check shows its result when the report is ready.</p>
          <RowGroups items={liveItems(run)} />
        </section>
      </>}
      {run.lifecycle !== 'finalizing' && <div className={s.btnRow}><button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={onEnd}>End test</button></div>}
    </div>
  );
}
