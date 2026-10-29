'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FONT_DISPLAY, SegmentedControl } from '@whiteroom/ui';
import { sourceModel } from '@/lib/sandbox/practice/api';
import {
  ADAPTER_EXPLAINER, ADAPTER_HELP_URL, callEstimate, CATALOG, choiceOf, CLOUD_MODEL_FIELD, controlCalls, costLine, defaultAgent, directChoice, DISCLAIMER, KEY_REFUSALS, keyLine, keyOptions,
  planRows, practiceBlock, PRACTICE_SUMMARY, providerKeyLabel, SAMPLE_AGENT, usualMinutes, SAMPLE_MODELS, UNSUPPORTED_FLEET, WILL_CHECK, ROW_STATUS_LABEL, type PracticeKeyChoice,
} from '@/lib/sandbox/practice/model';
import type { PracticeControlCheck, PracticeSource, PracticeStart } from '@/lib/sandbox/practice/types';
import { ROUTES } from '@/lib/routes';
import { RowGroups, type RowItem } from './PreflightRows';
import s from '../guided.module.css';
import p from './practice.module.css';

/** What setup needs to know about the fleet: its agents and when each was last active, from Controls (governance_list). */
export interface SetupData {
  agents: string[];
  lastActiveAt?: Record<string, string | null>;
}

/** "Set `ANTHROPIC_API_KEY` to the key your agent uses with prod-eu." / R7: "Run this where `AZURE_OPENAI_API_KEY` is set to the same Azure OpenAI key you added on Fleet key (key ending a1b2)." */
function KeyLine({ choice, fleet, sample, className }: { choice: PracticeKeyChoice | null; fleet: string; sample: boolean; className: string }) {
  const l = keyLine(choice, fleet, sample);
  return <p className={className}>{l.before}<code>{l.keyVar}</code>{l.after}</p>;
}

/** Step 2's rows: what each of the seven will do, from the catalog and the engine's planned control checks (null: couldn't be read). */
export function planItems(controls: PracticeControlCheck[] | null): RowItem[] {
  return planRows(controls).map((x) => ({
    row: x.row,
    tone: 'muted',
    label: x.status === 'will_check' ? WILL_CHECK : ROW_STATUS_LABEL[x.status],
    reason: x.reason,
    addInControls: x.addInControls,
    detailsLabel: x.row.members.every((m) => m.startsWith('ctl.')) ? 'Which rules' : 'Which tests',
    details: x.members.length ? <ul className={p.list}>{x.members.map((m, i) => <li key={i}>{m}</li>)}</ul> : undefined,
  }));
}

const NO_KEYS = { keys: [], direct: true, initial: null };
/** What setup assumes when the engine can't say: the fleet's own key, Start's checks still apply. */
const OWN_KEY_ONLY: PracticeSource = { model: null, provider: 'unknown', directKey: true, blocked: null, providerKeys: [], controls: null };
/** Whether `prefix` is a cloud provider's key, which needs a model typed in. */
const cloudKey = (src: PracticeSource | undefined, prefix: string | null) => {
  const k = prefix ? src?.providerKeys.find((x) => x.displayPrefix === prefix) : undefined;
  const c = k && choiceOf(k);
  return !!c && !!CLOUD_MODEL_FIELD[c.provider];
};

/**
 * Practice test setup (§10, Appendix D): who runs it, how many runs, which
 * key (R7: a Fleet key provider key), what it costs and checks. A test is
 * started from the computer the agent runs on, so on a phone the Start
 * button gives way to a note saying so.
 */
export function PracticeSetup({ fleet, data, busy, preview, refresh = 0, ownAgent = false, onStart }: {
  fleet: string;
  data: SetupData;
  busy: boolean;
  /** /dev/practice: what source-model would say, instead of asking the engine. */
  preview?: PracticeSource;
  /** Changes when the keys should be read again (Start said the picked one is gone). */
  refresh?: number;
  /** /dev/practice: start on the own-agent test. */
  ownAgent?: boolean;
  onStart: (start: PracticeStart, key: PracticeKeyChoice | null) => void;
}) {
  // Your agent needs an agent the fleet knows: one that has called through WhiteRoom.
  const noAgents = data.agents.length === 0;
  // The guardrails test first: no code, and any key pays for it.
  const [sample, setSample] = useState(!(ownAgent && !noAgents));
  // Step 1: the most recently active agent (§7), else the first by name.
  const recent = defaultAgent(data.agents, data.lastActiveAt);
  const [agent, setAgent] = useState(recent);
  const [runs, setRuns] = useState<1 | 3>(1);
  // What source-model says: the agent's latest model, where its calls go, the keys to pick from (undefined while loading).
  const [src, setSrc] = useState<PracticeSource | undefined>(preview);
  // The Fleet key key picked (its display prefix), or null for the fleet's own key.
  const [picked, setPicked] = useState<string | null>(() => (preview ? keyOptions(preview).initial : null));
  // A model the owner chose with Change (or typed, when the agent's isn't known, or a cloud provider needs one).
  const [changing, setChanging] = useState(false);
  const [typed, setTyped] = useState(() => (cloudKey(preview, picked) ? preview?.model ?? '' : ''));

  useEffect(() => {
    if (preview) { setSrc(preview); return; }
    let live = true;
    setSrc(undefined);
    // The agent the test will run as: the sample agent's own name on a fleet with none yet.
    sourceModel(fleet, agent || SAMPLE_AGENT).then(
      (m) => { if (live) setSrc(m); },
      () => { if (live) setSrc(OWN_KEY_ONLY); },
    );
    return () => { live = false; };
  }, [fleet, agent, preview, refresh]);

  const options = src ? keyOptions(src) : NO_KEYS;
  /** Picks a key; a cloud key's model field starts as the model the agent used most recently. */
  const pickKey = (prefix: string | null, from = src) => {
    setPicked(prefix);
    setChanging(false);
    setTyped(cloudKey(from, prefix) ? from?.model ?? '' : '');
  };
  // A new answer picks its default key again.
  useEffect(() => { if (src) pickKey(keyOptions(src).initial, src); }, [src]);

  const latest = src === undefined ? undefined : src.model;
  // A guardrails test takes any Anthropic or OpenAI key, so it never picks a Fleet key key.
  const key = sample ? null : options.keys.find((k) => k.displayPrefix === picked) ?? null;
  const choice = key ? choiceOf(key) : null;
  const cloudField = choice ? CLOUD_MODEL_FIELD[choice.provider] : undefined;
  const chosen = typed.trim() || null;
  // Sent with Start, so the sample agent or the starter uses it: the sample keeps its own unless one is chosen; a cloud key always needs one.
  const model = cloudField ? chosen : sample ? (changing ? chosen : null) : changing || !latest ? chosen : latest;
  const ineligible = src?.providerKeys.filter((k) => !k.eligible) ?? [];
  // Why Start can't run here at all: an IAM-role fleet; a fleet with its own host, or a cloud agent, with no Fleet key key to pick.
  // (The sample agent calls with the fleet's own key, so a cloud agent's fleet can still run it.)
  const blocked = src ? practiceBlock(src, { sample, hasKey: !!key }) : null;
  // Unknown controls: list none, and estimate with the most control calls a test can make rather than none.
  const controls = src === undefined ? [] : src.controls?.checks ?? null;
  // The key the test runs on: the picked Fleet key key, else the fleet's own key's provider as its latest call showed.
  const keyChoice = sample ? null : choice ?? directChoice(src);
  const est = callEstimate({
    runs: sample ? 1 : runs, scope: null, controlCalls: src?.controls ? controlCalls(src.controls.checks) : src ? CATALOG.controlCallsMax : 0, provider: choice?.provider ?? null,
    model: model ?? (sample && !cloudField ? SAMPLE_MODELS.anthropic : null),
  });
  const pick = (v: boolean) => { setSample(v); if (!cloudField) { setChanging(false); setTyped(''); } };
  const change = () => { setTyped(sample ? '' : latest ?? ''); setChanging(true); };
  const start = () => onStart({
    fleet, sample, runs: sample ? 1 : runs,
    ...(agent && { agent }),
    ...(model && { model }),
    ...(key && { proxyKeyDisplayPrefix: key.displayPrefix }),
  }, keyChoice);
  const modelInput = (label: string, hint: string, placeholder: string = SAMPLE_MODELS.anthropic, required = false) => <>
    <label className={s.formLabel} htmlFor="practice-model">{label} <span className={s.formLabelHint}>{hint}</span></label>
    <input id="practice-model" className={s.formInput} value={typed} maxLength={128} spellCheck={false} placeholder={placeholder} required={required} aria-required={required || undefined} onChange={(e) => setTyped(e.target.value)} />
  </>;
  const changeLink = <> · <button type="button" className={s.linkBtn} onClick={change}>Change</button></>;
  const keyChoices = options.keys.length + (options.direct ? 1 : 0);

  return (
    <div className={p.wrap}>
      <h2 className={s.pageTitle} tabIndex={-1} style={{ fontFamily: FONT_DISPLAY }}>Pre-flight check</h2>
      <p className={s.pageSub}>{PRACTICE_SUMMARY}. You start it from your computer with one command. <Link href={ROUTES.practiceDemo}>See a sample report</Link></p>

      {blocked && (
        <div className={s.notice} role="status">
          {blocked === 'role' ? <>{KEY_REFUSALS.bedrock_role} Use the connection test instead: <Link href={ROUTES.connectionTest}>Test my agent →</Link></>
            : blocked === 'cloud' ? <>To test an agent that uses Azure OpenAI, Claude on Azure (Foundry) or AWS Bedrock, add its key on <Link href={ROUTES.fleetKey}>Fleet key</Link>, then come back and pick it here.</>
            : <>{UNSUPPORTED_FLEET} Use the connection test instead: <Link href={ROUTES.connectionTest}>Test my agent →</Link></>}
        </div>
      )}

      <div className={`${s.card} ${s.cardBrand}`}>
        <h3 className={s.sectionTitle}>1. Pick agent</h3>
        <div className={s.formGroup}>
          <SegmentedControl<'guardrails' | 'agent'> label="What to test" value={sample ? 'guardrails' : 'agent'} onChange={(v) => pick(v === 'guardrails')}
            options={[{ value: 'guardrails', label: 'Test my guardrails · no code' }, { value: 'agent', label: 'Test my own agent', disabled: noAgents }]} />
        </div>
        {data.agents.length > 0 && (
          <div className={s.formGroup}>
            <label className={s.formLabel} htmlFor="practice-agent">Agent {sample ? <span className={s.formLabelHint}>· the sample agent runs with its name and guardrails</span>
              : agent === recent && data.lastActiveAt?.[agent] ? <span className={s.formLabelHint}>· active most recently</span> : null}</label>
            <select id="practice-agent" className={s.formInput} value={agent} onChange={(e) => setAgent(e.target.value)}>
              {data.agents.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        )}
        {sample ? (
          <p className={s.small}>
            WhiteRoom’s sample agent runs the tasks with your rules: no code, 1 run, about {usualMinutes(1)}. It checks your guardrails, not your own agent.
            {noAgents && ' Testing your own agent opens once it has called through WhiteRoom.'}
          </p>
        ) : (
          <p className={s.small}>
            Your agent needs a small adapter. {ADAPTER_EXPLAINER} <a className={s.linkBtn} href={ADAPTER_HELP_URL} target="_blank" rel="noopener noreferrer">How it works</a>
          </p>
        )}

        {!sample && options.keys.length > 0 && (
          <div className={s.formGroup}>
            {keyChoices > 1 ? <>
              <label className={s.formLabel} htmlFor="practice-key">Key to test with <span className={s.formLabelHint}>· from Fleet key</span></label>
              <select id="practice-key" className={s.formInput} value={picked ?? ''} onChange={(e) => pickKey(e.target.value || null)}>
                {options.keys.map((k) => <option key={k.displayPrefix} value={k.displayPrefix}>{providerKeyLabel(k)}</option>)}
                {options.direct && <option value="">The key your agent sends with each call (not on Fleet key)</option>}
              </select>
            </> : key && <p className={s.small}>Key: {providerKeyLabel(key)}, from Fleet key</p>}
          </div>
        )}
        {!sample && ineligible.length > 0 && (options.keys.length > 0 || blocked) && (
          <div className={s.formGroup}>
            <span className={s.small}>Fleet key keys a practice test can’t use:</span>
            <ul className={p.list}>{ineligible.map((k) => <li key={k.displayPrefix}>{providerKeyLabel(k)}: {KEY_REFUSALS[k.reason ?? 'unsupported_provider']}</li>)}</ul>
          </div>
        )}

        {!sample && (
          <div className={s.formGroup}>
            <span className={s.formLabel}>Runs</span>
            <SegmentedControl<'1' | '3'> label="Runs" value={String(runs) as '1' | '3'} onChange={(v) => setRuns(v === '3' ? 3 : 1)}
              options={[{ value: '1', label: '1 run' }, { value: '3', label: '3 runs' }]} />
            <p className={s.small} style={{ marginTop: 6 }}>3 runs show it passes every time, and take about {usualMinutes(3)}.</p>
          </div>
        )}

        <div className={s.formGroup}>
          {cloudField ? modelInput(cloudField.label, cloudField.hint, cloudField.placeholder, true)
            : sample ? (changing ? modelInput('Model the sample agent uses', '· leave it empty for its own')
            : <p className={s.small}>Model the sample agent uses: {SAMPLE_MODELS.anthropic} with an Anthropic key, {SAMPLE_MODELS.openai} with an OpenAI key{changeLink}</p>)
            : changing ? modelInput('Model your agent uses', '· for the cost estimate; the starter adapters use it too')
            : latest ? <p className={s.small}>Model: {latest}, the one {agent} used most recently{changeLink}</p>
            : latest === null ? modelInput('Model your agent uses', '· for the cost estimate')
            : <p className={s.small}>Looking up the model {agent} uses…</p>}
        </div>

      </div>

      <section className={s.card} aria-labelledby="practice-plan-title">
        <h3 id="practice-plan-title" className={s.sectionTitle}>2. What we’ll test</h3>
        <RowGroups items={planItems(controls)} />
        <p className={s.small} style={{ marginTop: 12 }}>{costLine(est, sample ? 1 : runs)}</p>
        {!blocked && <KeyLine choice={keyChoice} fleet={fleet} sample={sample} className={s.small} />}
        <div className={`${s.btnRow} ${p.desktopOnly}`} style={{ marginTop: 12 }}>
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy || !!blocked || (!!cloudField && !model)} onClick={start}>{busy ? 'Starting…' : 'Start test'}</button>
        </div>
        {cloudField && !model && !blocked && <p className={`${s.small} ${p.desktopOnly}`}>{cloudField.missing}</p>}
        <p className={`${s.notice} ${p.phoneOnly}`}>Start from your computer: open this page on the computer where your agent runs.</p>
      </section>
      <p className={s.small}>{DISCLAIMER}</p>
    </div>
  );
}
