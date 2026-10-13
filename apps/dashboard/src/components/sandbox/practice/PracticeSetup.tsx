'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FONT_DISPLAY, SegmentedControl } from '@whiteroom/ui';
import { sourceModel } from '@/lib/sandbox/practice/api';
import {
  callEstimate, CATALOG, controlCalls, controlPreview, controlPreviewLine, costLine, DISCLAIMER, keyVariable, SAMPLE_MODELS,
} from '@/lib/sandbox/practice/model';
import type { PracticeStart } from '@/lib/sandbox/practice/types';
import type { GovernanceRule } from '@/lib/whiteroom/types';
import { ROUTES } from '@/lib/routes';
import s from '../guided.module.css';
import p from './practice.module.css';

/** What setup needs to know about the fleet: from Controls (governance_list) and Fleet key. */
export interface SetupData {
  agents: string[];
  rules: GovernanceRule[];
  /** The fleet uses durable Pause and Stop, so they're checked too. */
  durableHolds: boolean;
  /** Fleet key providers whose agents call through a WhiteRoom proxy URL: not in practice tests yet. */
  proxyProviders: string[];
}

/** The 7 agent checks by scenario, then the fleet's controls: what the results will show, by the same names. */
export function PracticeCheckPreview({ controls, durableHolds }: { controls: string[]; durableHolds: boolean }) {
  const scenarios = [...new Set(CATALOG.checks.map((c) => c.scenario))];
  return (
    <section className={s.preview} aria-labelledby="practice-checks-preview">
      <h3 id="practice-checks-preview" className={s.previewHeader}>WHAT THE TEST CHECKS</h3>
      <ol className={s.previewList}>
        {scenarios.map((sc, i) => (
          <li key={sc} className={s.previewItem}>
            <span className={s.previewNum} aria-hidden="true">{i + 1}</span>
            <span>
              <span className={s.previewName}>{sc}</span>
              <span className={s.previewText}>{CATALOG.checks.filter((c) => c.scenario === sc && c.label !== sc).map((c) => c.label).join(' · ')}</span>
            </span>
          </li>
        ))}
        <li className={s.previewItem}>
          <span className={s.previewNum} aria-hidden="true">{scenarios.length + 1}</span>
          <span>
            <span className={s.previewName}>{CATALOG.controls.scenario}</span>
            {controls.length ? <ul className={p.list}>{controls.map((c, i) => <li key={i}>{c}</li>)}</ul>
              : <span className={s.previewText}>No controls set on this fleet yet, so only the agent checks run.</span>}
            {!durableHolds && <span className={s.previewText}>Pause and Stop: not checked on this fleet.</span>}
          </span>
        </li>
      </ol>
    </section>
  );
}

/**
 * Practice test setup (§10, Appendix D): who runs it, how many runs, what it
 * costs and checks. A test is started from the computer the agent runs on,
 * so on a phone the Start button gives way to a note saying so.
 */
export function PracticeSetup({ fleet, data, busy, previewModel, onStart }: {
  fleet: string;
  data: SetupData;
  busy: boolean;
  /** /dev/practice: the agent's latest model, instead of asking the engine. */
  previewModel?: string | null;
  onStart: (start: PracticeStart) => void;
}) {
  // Your agent needs an agent the fleet knows: one that has called through WhiteRoom.
  const noAgents = data.agents.length === 0;
  const [sample, setSample] = useState(noAgents);
  const [agent, setAgent] = useState(data.agents[0] ?? '');
  const [runs, setRuns] = useState<1 | 3>(1);
  // The model the agent used most recently (undefined while loading), else what the owner types.
  const [latest, setLatest] = useState<string | null | undefined>(previewModel);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (previewModel !== undefined || !agent) { setLatest(previewModel ?? null); return; }
    let live = true;
    setLatest(undefined);
    sourceModel(fleet, agent).then((m) => { if (live) setLatest(m); }, () => { if (live) setLatest(null); });
    return () => { live = false; };
  }, [fleet, agent, previewModel]);

  const model = sample ? SAMPLE_MODELS.anthropic : latest || typed.trim() || null;
  const controls = controlPreview(data.rules, data.durableHolds, sample && !data.agents.length);
  const est = callEstimate({ runs: sample ? 1 : runs, scope: null, controlCalls: controlCalls(controls), model });
  const keyVar = sample ? keyVariable(null) : keyVariable(model);
  const start = () => onStart({
    fleet, sample, runs: sample ? 1 : runs,
    ...(agent && { agent }),
    ...(!sample && model && { model }),
  });

  return (
    <div className={p.wrap}>
      <div className={s.eyebrow}>WHITEROOM / SANDBOX</div>
      <h2 className={s.pageTitle} tabIndex={-1} style={{ fontFamily: FONT_DISPLAY }}>Set up a practice test</h2>
      <p className={s.pageSub}>Your agent works through 5 practice tasks while WhiteRoom checks the results and your controls. You start it from your computer with one command.</p>

      {data.proxyProviders.length > 0 && (
        <div className={s.notice}>
          Practice tests can’t yet run agents that call through a WhiteRoom proxy URL ({data.proxyProviders.join(', ')}). For those, use the connection test: <Link href={ROUTES.sandbox}>Test my agent →</Link>
        </div>
      )}

      <div className={`${s.card} ${s.cardBrand}`}>
        <fieldset className={s.choiceGroup}>
          <legend className={s.formLabel}>Who runs the practice tasks</legend>
          <div className={s.choices}>
            {([
              [true, 'Sample agent', 'No code, 1 run. Doesn’t test your agent.'],
              [false, 'Your agent', noAgents ? 'Run your agent through WhiteRoom once first, so it shows up here.' : 'Needs a small adapter.'],
            ] as const).map(([v, name, sub]) => (
              <label key={name} className={`${s.choice} ${sample === v ? s.choiceOn : ''} ${!v && noAgents ? s.choiceOff : ''}`}>
                <input type="radio" name="practice-who" checked={sample === v} disabled={!v && noAgents} onChange={() => setSample(v)} className={s.choiceInput} />
                <span className={s.choiceText}><span className={s.choiceName}>{name}</span><span className={s.choiceSub}>{sub}</span></span>
              </label>
            ))}
          </div>
        </fieldset>

        {data.agents.length > 0 && (
          <div className={s.formGroup}>
            <label className={s.formLabel} htmlFor="practice-agent">Agent <span className={s.formLabelHint}>{sample ? '· the sample agent runs with its name and controls' : '· whose controls are checked'}</span></label>
            <select id="practice-agent" className={s.formInput} value={agent} onChange={(e) => setAgent(e.target.value)}>
              {data.agents.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        )}

        {!sample && (
          <div className={s.formGroup}>
            <span className={s.formLabel}>Runs</span>
            <SegmentedControl<'1' | '3'> label="Runs" value={String(runs) as '1' | '3'} onChange={(v) => setRuns(v === '3' ? 3 : 1)}
              options={[{ value: '1', label: '1 run' }, { value: '3', label: '3 runs' }]} />
            <p className={s.small} style={{ marginTop: 6 }}>3 runs show it passes every time, and take three times as long.</p>
          </div>
        )}

        <div className={s.formGroup}>
          {sample ? <p className={s.small}>Model the sample agent uses: {SAMPLE_MODELS.anthropic} with an Anthropic key, {SAMPLE_MODELS.openai} with an OpenAI key.</p>
            : latest ? <p className={s.small}>Model: {latest}, the one {agent} used most recently.</p>
            : latest === null ? <>
              <label className={s.formLabel} htmlFor="practice-model">Model your agent uses <span className={s.formLabelHint}>for the cost estimate</span></label>
              <input id="practice-model" className={s.formInput} value={typed} maxLength={128} spellCheck={false} placeholder="claude-haiku-4-5" onChange={(e) => setTyped(e.target.value)} />
            </> : <p className={s.small}>Looking up the model {agent} uses…</p>}
        </div>

        <p className={s.small}>{costLine(est, sample ? 1 : runs)}</p>
        <p className={s.small}>Set <code>{keyVar}</code> to the key your agent uses with {fleet}.</p>

        <div className={`${s.btnRow} ${p.desktopOnly}`} style={{ marginTop: 12 }}>
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start test'}</button>
          <Link className={`${s.btn} ${s.btnGhost}`} href={ROUTES.sandbox}>Back</Link>
        </div>
        <p className={`${s.notice} ${p.phoneOnly}`}>Start from your computer: open this page on the computer where your agent runs.</p>
      </div>

      <PracticeCheckPreview controls={controls.map(controlPreviewLine)} durableHolds={data.durableHolds} />
      <p className={s.small}>{DISCLAIMER}</p>
    </div>
  );
}
