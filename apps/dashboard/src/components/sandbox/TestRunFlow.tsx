'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { PageHeader } from '@/components/citadel/PageChrome';
import { FONT_DISPLAY, FONT_MONO, CopyButton } from '@whiteroom/ui';
import { analytics } from '@/lib/analytics';
import { PROXY_URL } from '@/lib/whiteroom/client';
import { announceProxyKeyRotation, type PastTest, claimSandboxChoices, clearSandboxToken, createRun, forgetProxyKey, forgetSandboxChoices, PROVIDER_STORAGE, getStatus, destroyRun, loadProxyKey, newProxyKey, proxyKeyAfterStorageEvent, saveProxyKey, type ShownProxyKey, SandboxRequestError, startDemo, withRunMode, type RunStatusResult } from '@/lib/sandbox/api';
import { type CloudProvider, cloudRecipe, cloudStart, type CloudEndpoints, type DirectProvider, headersLiteral, isCloudProvider, isSandboxProvider, KEY_HELP, noCodeSetup, offersNoCode, PROVIDER_UNSUPPORTED, providerSummary, proxyKeyBase, restorableProvider, saveEndpoints, savedEndpoints, type SandboxProvider, withEndpoint, withUnsupported } from '@/lib/sandbox/providers';
import { SETUP_LINES } from '@/lib/setup';
import { callCount, failedCallNotice, failedCallReason, failedCallsCheckDetail, failedCallsOf } from '@/lib/sandbox/failed-calls';
import { CloudEndpointField, CloudGoLive, CloudTroubleshooting, ProviderChoices, ProxyKeyNotice } from './CloudProviderParts';
import { buildTestReport, checkLabel, memoryCheckDetail, reportSource, SANDBOX_CHECKS, saveReportFile } from '@/lib/sandbox/report';
import { ROUTES } from '@/lib/routes';
import s from './guided.module.css';
import { PastTests } from './PastTests';
import { PracticeCard, type PracticeEntry, usePracticeEntry } from './practice/PracticeCard';
import { PRACTICE_SUMMARY } from '@/lib/sandbox/practice/model';
import { safeGet, safeRemove, safeSet } from '@/lib/safe-storage';

type Phase = 'start' | 'setup' | 'workspace';
type WorkspaceTab = 'setup' | 'results' | 'activity';
type Provider = SandboxProvider;
type Language = 'Python' | 'JavaScript';
/** Connect's setup choice: client code in a language, or environment variables only. */
type Setup = Language | 'env';

/** "Nothing happening?" opens on its own after a live test has gone this long with no calls. */
export const IDLE_HELP_AFTER_MS = 60_000;

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'setup', label: 'Connect' },
  { id: 'results', label: 'Checks' },
  { id: 'activity', label: 'Activity' },
];

/**
 * Plain-language names for the events in the Sandbox's Activity tab (the
 * main dashboard names them on its own). Keys are engine event types.
 */
export const EVENT_LABELS: Record<string, string> = {
  // Logged when a call first names the agent, before the call has come back,
  // so it doesn't mean the call worked.
  register: 'Agent recognized',
  fleet_created: 'Test started',
  watch_start: 'Started work',
  task_complete: 'Call completed',
  handover_begin: 'Memory full, saving a summary',
  self_handover: 'Saved a summary and kept going',
  handover: 'Passed work to another agent',
  paired_handover: 'Passed work to another agent',
  handover_out: 'Passed work to another agent',
  handover_in: 'Took over work from another agent',
  handover_deferred: 'Summary waiting for the next call',
  handover_summary_failed: 'Couldn’t write a summary',
  handover_delivery_abandoned: 'Summary not delivered',
  handover_chain_abandoned: 'Stopped passing work on',
  handover_unrecorded: 'Summary not recorded',
  handover_loop_detected: 'Repeating loop spotted',
  handover_limit_lowered: 'Memory limit lowered',
  handover_results_truncated: 'Long results shortened in the summary',
  handover_notes_resealed: 'Summary notes resealed',
  pair: 'Teamed up with another agent',
  alarm: 'Short break ended',
  agent_paused: 'Agent paused',
  agent_resumed: 'Agent resumed',
  deregister: 'Agent disconnected',
  context_offload: 'Stored a large input separately',
  policy_decision: 'Control check',
  policy_created: 'Control added',
  policy_chain_verified: 'Controls checked',
  policy_chain_failed: 'Controls check failed',
  policy_enforcement_verified: 'Control applied',
  policy_enforcement_failed: 'Control not applied',
  demo_activity: 'Demo step',
  unnamed_call_refused: 'Call refused: no agent name',
  quota_exceeded: 'Plan limit reached',
  state_recovered: 'Picked up again after a restart',
  unclean_stop: 'Stopped unexpectedly',
};

/**
 * The demo walkthrough: one step per check, and what each check says once the
 * demo has passed it (`detail`; the first check counts calls like a live test).
 * The engine's demo runs two agents: demo-agent finishes a task, then passes
 * its work with a short summary to demo-agent-b, which finishes the next one.
 * Its script also runs a safety-rule test, which isn't one of these checks, so
 * it isn't shown.
 */
export const DEMO_STORY: { title: string; text: string; detail?: string }[] = [
  { title: 'Your agent connects', text: 'A demo agent sends its calls through WhiteRoom and finishes a task. Nothing about its calls changes.' },
  {
    title: 'It keeps working when its memory fills up',
    text: 'Its memory fills up. WhiteRoom saves a short summary and passes the work to a second demo agent, which keeps going.',
    detail: 'WhiteRoom saved a short summary and passed the work to a second demo agent.',
  },
  {
    title: 'It picks up where it left off',
    text: 'The second demo agent starts from the summary instead of the full history, and finishes the next task.',
    detail: 'The second demo agent picked up from the summary and finished the next task.',
  },
];

/** The Activity tab's name for an event. Unlisted engine types still read as plain words. */
export function eventLabel(type: string): string {
  const known = EVENT_LABELS[type];
  if (known) return known;
  if (/handover|handoff/.test(type)) return /fail|abandon|unrecorded|error/.test(type) ? 'Memory summary problem' : 'Memory summary step';
  if (/policy/.test(type)) return 'Control step';
  if (/watch/.test(type)) return 'Work step';
  return type.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

/** "1:40" for 100 seconds. */
function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type KeyKind = 'anthropic' | 'openai' | 'fleet' | 'account' | 'unknown' | 'empty';

/** What the pasted value is, from its prefix. */
export function detectKey(value: string): KeyKind {
  const v = value.trim();
  if (!v) return 'empty';
  if (v.startsWith('wr_')) return 'fleet';
  if (v.startsWith('sk-wr-')) return 'account';
  if (v.startsWith('sk-ant-')) return 'anthropic';
  if (v.startsWith('sk-')) return 'openai';
  return 'unknown';
}

/** What a new test sends: a cloud test only its endpoint, a pasted key or fleet token as itself, and a live Anthropic or OpenAI test names its provider so status reports it back. */
export function runOptions(mode: 'demo' | 'connected', provider: SandboxProvider, credential: string, target?: { provider: CloudProvider; endpoint: string }) {
  const pasted = credential.trim();
  const kind = detectKey(pasted);
  const live = mode === 'connected' && !target;
  const pastedToken = live && kind === 'fleet' ? pasted : undefined;
  const apiKey = live && (kind === 'anthropic' || kind === 'openai') ? pasted : undefined;
  const named = live && !isCloudProvider(provider) ? provider : undefined;
  const opts = { mode, apiKey, selectedCatalogIds: [] as string[], policyMode: 'observe' as const, ...(named ? { provider: named } : {}) };
  return { opts: target ? { ...opts, provider: target.provider, endpoint: target.endpoint } : opts, pastedToken };
}

/** The Start form's choices before anything is remembered: what a first visit, and an account switch, start from. */
export const FIRST_VISIT: { provider: SandboxProvider; endpoints: CloudEndpoints; lastUsed: SandboxProvider | null } = { provider: 'anthropic', endpoints: {}, lastUsed: null };

/** Another account signed in on this browser (not a first sign-in or a sign-out): its stored choices aren't theirs. */
export const accountSwitched = (previous: string | undefined, next: string | undefined) => !!previous && !!next && previous !== next;

/** The Start form's key field: the agent's API key, what was pasted, and where to find one. */
export function KeyField({ credential, showKey, provider, onChange, onToggleShow }: {
  credential: string; showKey: boolean; provider: DirectProvider; onChange: (value: string) => void; onToggleShow: () => void;
}) {
  const keyKind = detectKey(credential);
  return (
    <div className={s.formGroup}>
      <label className={s.formLabel} htmlFor="sandbox-key">Your agent’s API key</label>
      <div className={s.keyWrap}>
        <input id="sandbox-key" className={s.formInput} type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={credential} onChange={e => onChange(e.target.value)} placeholder="sk-ant-…, sk-…, or wr_…" aria-describedby={keyKind === 'empty' ? 'sandbox-key-hint sandbox-key-token' : 'sandbox-key-hint'} />
        <button type="button" className={s.keyShow} onClick={onToggleShow}>{showKey ? 'Hide' : 'Show'}</button>
      </div>
      <p id="sandbox-key-hint" className={s.small} style={{ marginTop: 6 }} aria-live="polite">
        {keyKind === 'empty' && `Use the same key your agent uses, so we can match its calls to this test. ${KEY_HELP[provider]}`}
        {keyKind === 'anthropic' && <span style={{ color: 'var(--ok)' }}>Anthropic key. Ready to start.</span>}
        {keyKind === 'openai' && <span style={{ color: 'var(--ok)' }}>OpenAI key. Ready to start.</span>}
        {keyKind === 'fleet' && 'WhiteRoom fleet token. Pick Anthropic or OpenAI above for your agent’s provider.'}
        {keyKind === 'account' && <span style={{ color: 'var(--bad)' }}>That’s a WhiteRoom account key. Paste your Anthropic or OpenAI key, or a fleet token (wr_…).</span>}
        {keyKind === 'unknown' && <span style={{ color: 'var(--bad)' }}>That doesn’t look like an Anthropic key (sk-ant-…), an OpenAI key (sk-…), or a fleet token (wr_…). For Azure OpenAI, Foundry or Bedrock, pick it above.</span>}
      </p>
      {keyKind === 'empty' && <p id="sandbox-key-token" className={s.small} style={{ marginTop: 4 }}>Have a WhiteRoom fleet token? Paste it instead.</p>}
    </div>
  );
}

export function connectionRecipe(provider: DirectProvider, fleetId: string, agentId: string, language: Language) {
  const base = PROXY_URL.replace(/\/$/, '') + (provider === 'openai' ? '/v1' : '');
  const headers = { 'x-whiteroom-fleet': fleetId, 'x-whiteroom-agent': agentId };
  if (language === 'Python') return provider === 'openai'
    ? `from openai import OpenAI\n\nclient = OpenAI(\n    base_url=${JSON.stringify(base)},\n    default_headers=${headersLiteral(headers, 4)}\n)\n# Uses OPENAI_API_KEY from your environment.\n# Use this client for your agent's chat.completions calls.`
    : `import anthropic\n\nclient = anthropic.Anthropic(\n    base_url=${JSON.stringify(base)},\n    default_headers=${headersLiteral(headers, 4)}\n)\n# Uses ANTHROPIC_API_KEY from your environment.\n# Use this client for your agent's messages calls.`;
  return provider === 'openai'
    ? `import OpenAI from 'openai';\n\nconst client = new OpenAI({\n  baseURL: ${JSON.stringify(base)},\n  defaultHeaders: ${headersLiteral(headers, 2)}\n});\n// Uses OPENAI_API_KEY from your environment.\n// Use this client for your agent's chat.completions calls.`
    : `import Anthropic from '@anthropic-ai/sdk';\n\nconst client = new Anthropic({\n  baseURL: ${JSON.stringify(base)},\n  defaultHeaders: ${headersLiteral(headers, 2)}\n});\n// Uses ANTHROPIC_API_KEY from your environment.\n// Use this client for your agent's messages calls.`;
}

/** The agent name Connect's code starts with, until the agent's own name is seen. */
export const PLACEHOLDER_AGENT = 'test-agent';

/** The line under Connect's code: what to put in x-whiteroom-agent. None once an agent has called (its own name is in the code). */
export function agentNameNote(run: RunStatusResult | null): string | null {
  return run?.agents?.length ? null : `Put your agent’s own name in place of ${PLACEHOLDER_AGENT}. Any name works.`;
}

/**
 * Anthropic vs OpenAI for the test: what the engine reports for a live test
 * when it names one, else the choice on this page (restored from storage).
 */
export function directProviderOf(run: RunStatusResult | null, picked: SandboxProvider): DirectProvider {
  if (run?.sandboxId && run.mode !== 'demo' && (run.provider === 'anthropic' || run.provider === 'openai')) return run.provider;
  return picked === 'openai' ? 'openai' : 'anthropic';
}

/** Connect's setup choices for this provider: "No code change" only where it can work. */
export function setupChoices(provider: SandboxProvider): Setup[] {
  return offersNoCode(provider) ? ['Python', 'JavaScript', 'env'] : ['Python', 'JavaScript'];
}

/** The setup shown: the one picked, or Python when "No code change" isn't offered for this provider. */
export function shownSetup(picked: Setup, provider: SandboxProvider): Setup {
  return setupChoices(provider).includes(picked) ? picked : 'Python';
}

/**
 * End this test? The report is kept with the result when the engine's status
 * says so (reportsKept; Past tests can download it); otherwise it can only be
 * downloaded while the test is open.
 */
export function endTestText(run: Pick<RunStatusResult, 'reportsKept'> | null): string {
  return run?.reportsKept
    ? 'The result and its report stay in Past tests. Ending doesn’t stop your agent; its calls just stop being part of this test.'
    : 'The result stays in Past tests. The full report, with each check and the activity, can only be downloaded while the test is open. Ending doesn’t stop your agent; its calls just stop being part of this test.';
}

function connectionVerified(status: RunStatusResult | null) {
  return status?.mode !== 'demo' && status?.controls?.some(c => c.controlId === 'core.connect' && isObserved(status, c));
}

function diagStage(run: RunStatusResult | null): number {
  if (!run?.sandboxId) return 0;
  const hasAudit = (run.auditLog?.length ?? 0) > 0;
  const connectEvidence = run.controls?.find(c => c.controlId === 'core.connect')?.result?.liveEvidence;
  if (connectionVerified(run)) return 4;
  if (connectEvidence) return 3;
  if (hasAudit) return 2;
  return 1;
}

/**
 * How far the Connect checklist has got. Failed calls lead only until a call
 * comes back (stage 3); after that, success wins and they're a note. A failed
 * call still reached WhiteRoom, so while failing the checklist stops on
 * "Its first call went through" (diagShown 3).
 */
export function connectProgress(run: RunStatusResult | null, provider: SandboxProvider) {
  const stage = diagStage(run);
  const failed = failedCallsOf(run);
  const failing = failed && stage < 3 ? failed : null;
  const failNotice = failing ? failedCallNotice(failing, provider, run?.endpointHost) : null;
  return { stage, failed, failing, failNotice, diagShown: failing ? 3 : stage };
}

function timerColor(seconds: number | null | undefined): string {
  if (seconds == null) return s.timerGreen;
  if (seconds > 600) return s.timerGreen;
  if (seconds > 120) return s.timerAmber;
  return s.timerRed;
}

function formatTimer(seconds: number | null | undefined): string {
  if (seconds == null) return '30:00';
  if (seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function checkGuidance(controlId: string, status: string | undefined, run: RunStatusResult | null, provider: SandboxProvider): { detail: string; action?: string; failed?: boolean; progress?: { current: number; total: number; label: string } } {
  // The demo walkthrough reveals one check per step.
  const demoStep = SANDBOX_CHECKS.findIndex(c => c.id === controlId) + 1;
  if (status === 'unrevealed') return { detail: `Shown in step ${demoStep} of the walkthrough.` };
  const agent = run?.agents?.[0];
  const calls = run?.agents?.reduce((sum, a) => sum + a.totalTasks, 0) ?? 0;
  if (status === 'observed') {
    // The demo's checks say what its walkthrough showed.
    const demoDetail = run?.mode === 'demo' ? DEMO_STORY[demoStep - 1]?.detail : undefined;
    if (demoDetail) return { detail: demoDetail };
    if (controlId === 'core.connect') {
      const failed = failedCallsOf(run);
      return { detail: `${callCount(calls)} went through WhiteRoom and got a normal reply.${failed ? ` ${callCount(failed.count)} failed.` : ''}` };
    }
    if (controlId === 'core.handoff') {
      return { detail: memoryCheckDetail(run?.auditLog ?? []) };
    }
    return { detail: 'Its next call after the summary worked.' };
  }
  if (run?.mode === 'demo') return { detail: 'The demo fills this in a moment.' };
  if (controlId === 'core.connect') {
    const failed = failedCallsOf(run);
    if (failed) return { detail: failedCallsCheckDetail(failed, provider), action: failedCallNotice(failed, provider, run?.endpointHost).next, failed: true };
    return { detail: 'No calls yet.', action: 'Copy the code from Connect into your agent and run one normal task.' };
  }
  if (controlId === 'core.handoff') {
    if (!agent) return { detail: 'Starts once your agent connects.' };
    const total = agent.watchMinutes || 2;
    const worked = agent.currentWatch?.minutesWorked ?? 0;
    const left = Math.max(0, (total - worked) * 60);
    return {
      detail: left > 0 ? `About ${formatCountdown(left)} until WhiteRoom saves a summary.` : 'Ready to save a summary. It happens on your agent’s next call.',
      action: 'Keep your agent making calls. The summary is saved on its own.',
      progress: { current: Math.min(worked, total), total, label: `${formatCountdown(Math.min(worked, total) * 60)} of ${total}:00` },
    };
  }
  const handoff = run?.controls?.find(c => c.controlId === 'core.handoff');
  // Demos returned above, so only live evidence matters here.
  const handoffDone = !!handoff && isObserved(run, handoff);
  if (!handoffDone) return { detail: 'Happens after the summary is saved.' };
  return { detail: 'Waiting for your agent’s next call.', action: 'Keep your agent running for one more call.' };
}

/** The Activity tab's header: "1 agent · 0 calls · 1 failed · newest first", or null before anything is seen. */
export function activitySummary(run: RunStatusResult | null): string | null {
  const agents = run?.agents?.length ?? 0;
  const failed = failedCallsOf(run);
  if (!agents && !failed) return null;
  const calls = run?.agents?.reduce((sum, a) => sum + a.totalTasks, 0) ?? 0;
  return `${agents} agent${agents === 1 ? '' : 's'} · ${callCount(calls)}${failed ? ` · ${failed.count} failed` : ''} · newest first`;
}

const CHECK_ICON_PASS = <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2.5 6l2.5 2.5 4.5-4.5"/></svg>;
const CHECK_ICON_WAIT = <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3v3.5l2 1.5"/></svg>;
const CHECK_ICON_FAIL = <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 2.5v4M6 9.2v.1"/></svg>;
const TIMER_ICON = <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>;

/** The steps rail (README › Sandbox), mapped onto this flow's real stages. */
export const SANDBOX_STEPS = [
  { title: 'Start a test', sub: 'Paste the key your agent uses, or see the demo' },
  { title: 'Point your agent', sub: 'Use the test URL' },
  { title: 'Run one task', sub: 'Calls show up as they arrive' },
  { title: 'Results', sub: 'Three checks, and a report to keep' },
] as const;

/** Which rail step is current: 0 before a test exists, then by what the test has seen. */
export function sandboxStep(phase: 'start' | 'setup' | 'workspace', opts: { stage: number; allPassed: boolean; expired: boolean; demo: boolean; demoScene?: number }): number {
  if (phase !== 'workspace') return 0;
  // The demo walkthrough moves the rail one step per scene, ending on Results.
  if (opts.demo && opts.demoScene !== undefined && !opts.expired) return Math.min(3, 1 + opts.demoScene);
  if (opts.allPassed || opts.expired || opts.demo) return 3;
  return opts.stage >= 3 ? 2 : 1;
}

/** Start screen: the three checks the results will show, by the same names. */
export function CheckPreview() {
  return (
    <section className={s.preview} aria-labelledby="sandbox-checks-preview">
      <h3 id="sandbox-checks-preview" className={s.previewHeader}>WHAT THE TEST CHECKS</h3>
      <ol className={s.previewList}>
        {SANDBOX_CHECKS.map((c, i) => (
          <li key={c.id} className={s.previewItem}>
            <span className={s.previewNum} aria-hidden="true">{i + 1}</span>
            <span>
              <span className={s.previewName}>{c.label}</span>
              <span className={s.previewText}>{c.meaning}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className={s.previewDetail}>You’ll get three pass/fail checks and a report you can download.</p>
    </section>
  );
}

/** "Test ends in about 30 minutes": what a screen reader hears, changing once a minute. */
export function timerSpoken(seconds: number | null | undefined, expired: boolean): string {
  if (expired || seconds === 0) return 'Test ended';
  const m = Math.max(1, Math.ceil((seconds ?? 1800) / 60));
  return `Test ends in about ${m} minute${m === 1 ? '' : 's'}`;
}

/** The workspace header's countdown, labelled. The visible text ticks each second; the spoken one each minute. */
function TestTimer({ seconds, expired }: { seconds: number | null; expired: boolean }) {
  const ended = expired || seconds === 0;
  return (
    <span className={`${s.timer} ${timerColor(seconds)}`} title="The test ends automatically. Results stay in Past tests.">
      {TIMER_ICON}
      <span aria-hidden="true">{ended ? 'Test ended' : <>Test ends in <span className={s.timerValue}>{formatTimer(seconds)}</span></>}</span>
      <span className={s.srOnly}>{timerSpoken(seconds, expired)}</span>
    </span>
  );
}

/**
 * Connect / Checks / Activity as an ARIA tablist: the selected tab is the
 * only tab stop, arrow keys (and Home/End) move and select.
 */
export function WorkspaceTabs({ value, onChange }: { value: WorkspaceTab; onChange: (t: WorkspaceTab) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (i: number) => {
    const n = WORKSPACE_TABS.length;
    const next = WORKSPACE_TABS[(i + n) % n];
    onChange(next.id);
    refs.current[(i + n) % n]?.focus();
  };
  return (
    <div className={s.tabs} role="tablist" aria-label="Test workspace">
      {WORKSPACE_TABS.map((t, i) => {
        const on = t.id === value;
        return (
          <button key={t.id} ref={el => { refs.current[i] = el; }} type="button" role="tab" id={`sandbox-tab-${t.id}`} aria-selected={on} aria-controls={`sandbox-panel-${t.id}`} tabIndex={on ? 0 : -1}
            className={`${s.tab} ${on ? s.tabActive : ''}`} onClick={() => onChange(t.id)}
            onKeyDown={e => {
              const keys: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: WORKSPACE_TABS.length - 1 };
              if (e.key in keys) { e.preventDefault(); go(keys[e.key]); }
            }}>{t.label}</button>
        );
      })}
    </div>
  );
}

function StepsRail({ current }: { current: number }) {
  return (
    <ol className={s.rail} aria-label="Test steps">
      {SANDBOX_STEPS.map((step, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <li key={step.title} className={`${s.railStep} ${now ? s.railStepCurrent : ''}`} aria-current={now ? 'step' : undefined}>
            <span className={`${s.railNum} ${done ? s.railNumDone : now ? s.railNumCurrent : ''}`}>{done ? CHECK_ICON_PASS : i + 1}</span>
            <span className={`${s.railTitle} ${!done && !now ? s.railTitleTodo : ''}`}>{step.title}</span>
            <span className={s.railSub}>{step.sub}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ── Decisions, kept pure so they can be tested without rendering ──

type Control = NonNullable<RunStatusResult['controls']>[number];

/** A check's evidence on the track the user watches: demo evidence in a demo, live evidence otherwise. */
export function evidenceOf(run: RunStatusResult | null, control: Control) {
  return run?.mode === 'demo' ? control.result?.demoEvidence : control.result?.liveEvidence;
}

/** The check passed, on the track the user watches. */
export function isObserved(run: RunStatusResult | null, control: Control): boolean {
  return evidenceOf(run, control)?.status === 'observed';
}

/** Every check observed on the track the user watches (demo or live). */
export function allChecksPassed(run: RunStatusResult | null): boolean {
  const controls = run?.controls ?? [];
  return controls.length > 0 && controls.every(c => isObserved(run, c));
}

/** How many checks passed. */
export function checksPassedCount(run: RunStatusResult | null): number {
  return (run?.controls ?? []).filter(c => isObserved(run, c)).length;
}

/** What the page tracks about a test between status reads. Its id never leaves the page. */
export interface RunSnapshot {
  id: string;
  demo: boolean;
  provider: SandboxProvider;
  /** A call went through WhiteRoom (Connect stage 3 or later). */
  called: boolean;
  passed: boolean;
  checksPassed: number;
  expired: boolean;
  /** sandbox_test_ended went out for this test. */
  endSent: boolean;
}

export type SandboxEvent = { name: string; props?: Record<string, string | number | undefined> };
/** Why the page saw a test end: the user ended it, it ran out of time, or it was gone on the next read. */
export type EndedBy = 'user' | 'expired' | 'other';

/** A test's state as runTransition reads it; null for no test. */
export function runSnapshot(run: RunStatusResult | null, provider: SandboxProvider): RunSnapshot | null {
  if (!run?.sandboxId) return null;
  return {
    id: run.sandboxId, demo: run.mode === 'demo', provider,
    called: diagStage(run) >= 3, passed: allChecksPassed(run), checksPassed: checksPassedCount(run),
    expired: run.expiresInSeconds === 0, endSent: false,
  };
}

/** sandbox_test_ended: the mode, how many checks had passed and why it ended. Never an id. */
export function testEndedEvent(t: Pick<RunSnapshot, 'demo' | 'checksPassed'>, endedBy: EndedBy): SandboxEvent {
  return { name: 'sandbox_test_ended', props: { mode: t.demo ? 'demo' : 'connected', checks_passed: t.checksPassed, ended_by: endedBy } };
}

/**
 * From one status read to the next: the analytics events to send, whether to
 * open Checks and focus the results heading, and the snapshot to keep.
 *
 * - First call and checks passed: live tests, rising edges within the same
 *   test only, so reopening a finished test sends nothing.
 * - Test ended, once per test: when it expires, or when it goes away
 *   (`next` null or another test) for a known reason (`ending`). A test that
 *   goes away with no reason (another account signed in) sends nothing.
 *
 * Event properties are the mode, the provider's name, a check count and why a
 * test ended: never keys, endpoints, ids or agent names.
 */
export function runTransition(prev: RunSnapshot | null, next: RunSnapshot | null, ending?: Exclude<EndedBy, 'expired'>): { events: SandboxEvent[]; showResults: boolean; keep: RunSnapshot | null } {
  const events: SandboxEvent[] = [];
  if (prev && !prev.endSent && ending && (!next || next.id !== prev.id)) events.push(testEndedEvent(prev, ending));
  if (!prev || !next || prev.id !== next.id) return { events, showResults: false, keep: next };
  const keep = { ...next, endSent: prev.endSent };
  if (!next.demo && next.called && !prev.called) events.push({ name: 'sandbox_first_call', props: { provider: next.provider } });
  if (!next.demo && next.passed && !prev.passed) events.push({ name: 'sandbox_checks_passed', props: { provider: next.provider } });
  if (next.expired && !prev.expired && !prev.endSent) { events.push(testEndedEvent(next, 'expired')); keep.endSent = true; }
  const finished = (x: RunSnapshot) => x.passed || x.expired;
  return { events, showResults: !next.demo && finished(next) && !finished(prev), keep };
}

/** sandbox_test_started: the mode, and the provider picked for a live test. */
export function testStartedEvent(mode: 'demo' | 'connected', provider: SandboxProvider): SandboxEvent {
  return { name: 'sandbox_test_started', props: { mode, provider: mode === 'demo' ? undefined : provider } };
}

/** "Nothing happening?": which test it belongs to, whether it's open, and which test it already opened itself for. */
export interface HelpState { testId: string | null; open: boolean; autoOpenedFor: string | null }
export type HelpAction = { type: 'test'; id: string | null } | { type: 'toggle'; open: boolean } | { type: 'autoOpen'; id: string };

/** A new test starts with the help closed and free to open itself once; the same test keeps its state. */
export function helpReducer(state: HelpState, action: HelpAction): HelpState {
  switch (action.type) {
    case 'test': return action.id === state.testId ? state : { testId: action.id, open: false, autoOpenedFor: null };
    // Opening or closing it by hand counts as the user's choice: no auto-open after that.
    case 'toggle': return state.open === action.open ? state : { ...state, open: action.open, autoOpenedFor: state.testId };
    case 'autoOpen': return action.id === state.testId && state.autoOpenedFor !== action.id ? { ...state, open: true, autoOpenedFor: action.id } : state;
  }
}

/**
 * A live test that has seen nothing at all: no call reached WhiteRoom, failed
 * or not. Every test logs "Test started" when it's created, so the activity
 * log alone can't say whether a call arrived: a named call registers its
 * agent, and an unnamed one is logged as refused.
 */
export function hasNoCalls(run: RunStatusResult | null): boolean {
  return !!run?.sandboxId && run.mode !== 'demo' && run.expiresInSeconds !== 0 && !callArrived(run);
}

/** A checklist step's state: a failure leads; a step can be done early (step 2, once any call arrives). */
export function diagStepState(diagShown: number, d: { at: number; fail?: unknown; done?: boolean }): 'fail' | 'done' | 'active' | 'pending' {
  if (d.fail) return 'fail';
  if (d.done || diagShown > d.at) return 'done';
  return diagShown === d.at ? 'active' : 'pending';
}

/** A call reached WhiteRoom, failed or not: a named call registers its agent, an unnamed one is logged as refused. */
export function callArrived(run: RunStatusResult | null): boolean {
  return !!run?.agents?.length || !!run?.auditLog?.some(e => e.type === 'unnamed_call_refused') || !!failedCallsOf(run);
}

/**
 * The Run your agent checklist's second step. Until a call arrives it waits
 * (a new test already logs "Test started", so the activity log can't say);
 * then it names the agent, or says the call had no agent name.
 */
export function recognizedStep(run: RunStatusResult | null, agentId: string): { label: string; sub: string } {
  if (!callArrived(run)) return { label: 'Waiting for your agent', sub: 'Run one normal task with the code above' };
  if (!run?.agents?.length && !failedCallsOf(run)) return { label: 'Your agent called without a name', sub: 'Add the x-whiteroom-agent header from the code above' };
  // A failed first call registers no agent; the engine still reports the name it sent.
  const seenAs = run?.agents?.[0]?.agentId ?? failedCallsOf(run)?.last.agentId ?? agentId;
  return { label: 'Your agent is recognized', sub: `Seen as ${seenAs}` };
}

/**
 * When "Nothing happening?" should open on its own: milliseconds from now
 * (0 = now), or null for not at all. Idle time runs from when this page first
 * saw the test (the status carries no start time), and it opens once per test.
 */
export function idleHelpDelay(o: { run: RunStatusResult | null; firstSeenAt: number | null; now: number; autoOpenedFor: string | null }): number | null {
  if (!hasNoCalls(o.run) || o.firstSeenAt == null || o.autoOpenedFor === o.run?.sandboxId) return null;
  return Math.max(0, o.firstSeenAt + IDLE_HELP_AFTER_MS - o.now);
}

/** One workspace tab's panel, linked to its tab in WorkspaceTabs. */
export function WorkspacePanel({ tab, active, children }: { tab: WorkspaceTab; active: boolean; children: React.ReactNode }) {
  return (
    <div className={`${s.panel} ${active ? s.panelActive : ''}`} role="tabpanel" id={`sandbox-panel-${tab}`} aria-labelledby={`sandbox-tab-${tab}`} tabIndex={0} hidden={!active}>
      {children}
    </div>
  );
}

export function TestRunFlow({ previewUserId, previewPastTests, previewRun, previewSeenSecondsAgo, previewPractice }: {
  /** /dev/sandbox only: render as this signed-in user without a real session. */
  previewUserId?: string;
  /** /dev/sandbox only: sample Past tests. */
  previewPastTests?: PastTest[];
  /** /dev/sandbox only: show this test in the workspace instead of asking the engine. */
  previewRun?: RunStatusResult;
  /** /dev/sandbox only: how long ago this page "first saw" the sample test, in seconds. */
  previewSeenSecondsAgo?: number;
  /** /dev/sandbox only: sample practice tests. */
  previewPractice?: PracticeEntry;
} = {}) {
  const live = useSession();
  const session = previewUserId ? { user: { id: previewUserId } } : live.data;
  const authStatus = previewUserId ? 'authenticated' : live.status;
  // /dev/sandbox's sample test is shown from the first render.
  const [phase, setPhase] = useState<Phase>(previewRun ? 'workspace' : 'start');
  const [wsTab, setWsTab] = useState<WorkspaceTab>('setup');
  const [run, setRun] = useState<RunStatusResult | null>(() => (previewRun ? withRunMode(previewRun) : null));
  const [provider, setProvider] = useState<Provider>(() => (previewRun && isSandboxProvider(previewRun.provider) ? previewRun.provider : FIRST_VISIT.provider));
  const [pickedSetup, setLanguage] = useState<Setup>('Python');
  // The provider this browser's last test used, tagged on Start your test.
  const [lastUsed, setLastUsed] = useState<SandboxProvider | null>(FIRST_VISIT.lastUsed);
  // "Nothing happening?": opened by the user, or once on its own after a minute with no calls.
  const [help, helpDispatch] = useReducer(helpReducer, { testId: null, open: false, autoOpenedFor: null });
  const [credential, setCredential] = useState('');
  // Kept per provider: Azure and Foundry take an endpoint, Bedrock a region.
  const [endpoints, setEndpoints] = useState<CloudEndpoints>(FIRST_VISIT.endpoints);
  const [endpointError, setEndpointError] = useState('');
  const [unsupported, setUnsupported] = useState<CloudProvider[]>([]);
  // The proxy key issued for one test, so it can't show against another.
  const [shownKey, setShownKey] = useState<ShownProxyKey>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(!previewRun);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [scene, setScene] = useState(0);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const [displaySeconds, setDisplaySeconds] = useState<number | null>(null);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [prodFleetId, setProdFleetId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // The workspace's results heading (the summary line), focused when a live test finishes.
  const summaryHeading = useRef<HTMLHeadingElement>(null);
  const ownerRef = useRef<string | undefined>(undefined);
  const modalRef = useRef<HTMLDivElement>(null);
  const verified = connectionVerified(run);
  const isDemo = run?.mode === 'demo';
  const expired = run?.expiresInSeconds === 0;
  const fleetId = run?.sandboxId ? `sandbox-${run.sandboxId}` : '';
  const agentId = run?.agents?.[0]?.agentId ?? PLACEHOLDER_AGENT;
  const keyKind = detectKey(credential);
  // A cloud test's agent calls through its proxy key: the one this tab keeps
  // for the test, else the one issued in this page (storage may be blocked).
  const proxyKey = run?.sandboxId && shownKey?.sandboxId === run.sandboxId ? shownKey.proxyKey : null;
  const cloud = isCloudProvider(provider) ? provider : null;
  const endpointInput = cloud ? endpoints[cloud] ?? '' : '';
  // Demos and Anthropic/OpenAI tests use the fleet-header recipe, as before.
  const directProvider = directProviderOf(run, provider);
  // A live cloud test, by what the engine reports (an engine that reports no
  // provider at all falls back to the choice made at start).
  const liveCloud = !run || isDemo ? null
    : isCloudProvider(run.provider) ? run.provider
    : run.provider === undefined ? cloud : null;
  // The provider this test's calls go to, for naming it when they fail.
  const testProvider: SandboxProvider = liveCloud ?? directProvider;
  const language = shownSetup(pickedSetup, testProvider);
  // The code shown when "No code change" is picked but code is still needed (the live card).
  const codeLanguage: Language = language === 'env' ? 'Python' : language;
  const recipe = liveCloud
    ? cloudRecipe(liveCloud, proxyKeyBase(PROXY_URL, proxyKey), agentId, codeLanguage)
    : connectionRecipe(directProvider, fleetId, agentId, codeLanguage);
  const noCode = language === 'env' ? noCodeSetup(testProvider, { proxyUrl: PROXY_URL, base: proxyKeyBase(PROXY_URL, proxyKey), fleetId }) : null;
  const { stage, failed, failing, failNotice, diagShown } = connectProgress(run, testProvider);
  const activityHeader = activitySummary(run);
  const allPassed = allChecksPassed(run);
  // Analytics never carry keys, endpoints, fleet or test ids, or agent names. The /dev preview sends none.
  const track = useCallback((e: SandboxEvent) => { if (!previewUserId) analytics.capture(e.name, e.props); }, [previewUserId]);
  const noCalls = hasNoCalls(run);
  // Practice tests: the start screen's card and Past tests rows, and the line on Ready to go live.
  const practice = usePracticeEntry(!!session?.user?.id && !booting && (phase === 'start' || (allPassed && !isDemo)), previewPractice);

  // The provider follows the pasted key; a fleet token doesn't say, so the
  // user picks it.
  useEffect(() => {
    if (keyKind === 'anthropic' || keyKind === 'openai') setProvider(p => (isCloudProvider(p) ? p : keyKind));
  }, [keyKind]);

  // Remember the provider for this test so a reload shows the right code,
  // and the endpoint or region typed for each cloud provider.
  useEffect(() => {
    const saved = safeGet(PROVIDER_STORAGE);
    const restored = restorableProvider(saved, []);
    if (restored) { setProvider(restored); setLastUsed(restored); }
    setEndpoints(savedEndpoints());
  }, []);

  // Load this tab's proxy key for the test; keep one issued in this page if
  // storage is unavailable.
  useEffect(() => {
    const id = run?.sandboxId;
    const stored = loadProxyKey(id);
    setShownKey(prev => (id && stored ? { sandboxId: id, proxyKey: stored } : prev?.sandboxId === id ? prev : null));
  }, [run?.sandboxId]);

  // Another tab replaced this test's proxy key: the one shown here is dead.
  useEffect(() => {
    const id = run?.sandboxId;
    const onStorage = (e: StorageEvent) => {
      if (!id || proxyKeyAfterStorageEvent({ sandboxId: id, proxyKey: '' }, e.key, e.newValue) !== null) return;
      forgetProxyKey();
      // A new null value when a key was shown, so the recovery notice appears.
      setShownKey(prev => proxyKeyAfterStorageEvent(prev, e.key, e.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [run?.sandboxId]);

  // Once every check passes, fill the production snippet with the user's own
  // fleet instead of a placeholder.
  useEffect(() => {
    if (!allPassed || isDemo || prodFleetId) return;
    fetch('/api/fleet/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { fleetId?: string } | null) => { if (d?.fleetId) setProdFleetId(d.fleetId); })
      .catch(() => {});
  }, [allPassed, isDemo, prodFleetId]);

  // Once per page: someone opened the Sandbox.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || authStatus !== 'authenticated') return;
    opened.current = true;
    track({ name: 'sandbox_opened' });
  }, [authStatus, track]);

  // Rising edges seen in this page, per test, so a reload of a finished test
  // doesn't count its first call or its pass again.
  const seen = useRef<RunSnapshot | null>(null);
  // Why the current test is about to go away, set just before setRun(null).
  const ending = useRef<Exclude<EndedBy, 'expired'> | undefined>(undefined);
  useEffect(() => {
    const next = runSnapshot(run, testProvider);
    const { events, showResults, keep } = runTransition(seen.current, next, ending.current);
    seen.current = keep;
    ending.current = undefined;
    events.forEach(track);
    // The test just finished: show its results and move focus to their heading.
    if (showResults) { setWsTab('results'); requestAnimationFrame(() => summaryHeading.current?.focus()); }
  }, [run, testProvider, track]);

  // When this page first saw the current live test (client clock): the status carries no start time.
  const firstSeen = useRef<{ id: string; at: number } | null>(null);
  if (run?.sandboxId && firstSeen.current?.id !== run.sandboxId) {
    firstSeen.current = { id: run.sandboxId, at: Date.now() - (previewSeenSecondsAgo ?? 0) * 1000 };
  }

  // A live test with no calls for a minute: open "Nothing happening?", once per test.
  useEffect(() => {
    const id = run?.sandboxId;
    const delay = idleHelpDelay({ run, firstSeenAt: firstSeen.current?.at ?? null, now: Date.now(), autoOpenedFor: help.autoOpenedFor });
    if (!id || delay == null) return;
    const t = setTimeout(() => helpDispatch({ type: 'autoOpen', id }), delay);
    return () => clearTimeout(t);
  }, [run, noCalls, help.autoOpenedFor]);

  // Each test starts with "Nothing happening?" closed.
  useEffect(() => { helpDispatch({ type: 'test', id: run?.sandboxId ?? null }); }, [run?.sandboxId]);

  // Focus heading on phase change
  useEffect(() => { heading.current?.focus(); }, [phase]);

  // Auto-switch to results tab only when the connection first verifies (rising
  // edge) — re-running on every tab change would snap the user out of Setup.
  const wasVerified = useRef(false);
  useEffect(() => {
    if (verified && !wasVerified.current && wsTab === 'setup') setWsTab('results');
    wasVerified.current = !!verified;
  }, [verified, wsTab]);

  // Boot: check for existing run
  useEffect(() => {
    const owner = session?.user?.id;
    if (ownerRef.current !== owner) {
      // A different account signed in on this browser: the stored sandbox
      // token belongs to the previous one.
      // Also when the page loads for someone other than whose choices are stored (no sign-out ran).
      const switched = accountSwitched(ownerRef.current, owner);
      if (switched) forgetSandboxChoices();
      const forgot = owner ? claimSandboxChoices(owner) : false;
      if (switched || forgot) {
        clearSandboxToken();
        // And what this page already loaded from them: back to a first visit.
        setLastUsed(FIRST_VISIT.lastUsed); setProvider(FIRST_VISIT.provider); setEndpoints(FIRST_VISIT.endpoints);
      }
      ownerRef.current = owner;
      setRun(null); setCredential(''); setPhase('start'); setBooting(true);
    }
    if (!owner) return;
    if (previewRun) {
      if (isSandboxProvider(previewRun.provider)) setProvider(previewRun.provider);
      setRun(withRunMode(previewRun)); setPhase('workspace'); setBooting(false);
      return;
    }
    let disposed = false;
    getStatus().then(st => {
      if (disposed) return;
      if (st.error) throw new Error(st.error);
      if (st.sandboxId) {
        if (isSandboxProvider(st.provider)) setProvider(st.provider);
        setRun(withRunMode(st));
        setPhase('workspace');
        setWsTab(connectionVerified(st) || st.mode === 'demo' || st.expiresInSeconds === 0 ? 'results' : 'setup');
      }
      setLastUpdated(new Date());
    }).catch(() => { if (!disposed) setError('Could not load your test. Check your connection and retry.'); })
      .finally(() => { if (!disposed) setBooting(false); });
    return () => { disposed = true; };
  }, [session?.user?.id, pollTick, previewRun]);

  // Poller for workspace
  useEffect(() => {
    if (!run?.sandboxId || phase !== 'workspace' || expired || previewRun) return;
    let disposed = false;
    let pending = false;
    let failures = 0;
    let retryAfter = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      clearTimeout(timer);
      if (disposed || pending) return;
      pending = true;
      try {
        const st = await getStatus();
        if (disposed) return;
        retryAfter = Math.max(0, Number(st.retryAfter) || 0) * 1000;
        if (st.error) throw new Error('unavailable');
        if (!st.sandboxId) {
          clearSandboxToken();
          setError('This test session is no longer available. You can start another test; previously exported results remain on your device.');
          ending.current = 'other';
          setRun(null); setPhase('start'); return;
        }
        setRun(prev => withRunMode(st, prev?.mode)); setLastUpdated(new Date()); setReconnecting(false); failures = 0;
        if (st.expiresInSeconds === 0) setWsTab('results');
      } catch { if (!disposed) { setReconnecting(true); failures++; } }
      finally {
        pending = false;
        if (!disposed) {
          // Keep checking in a background tab, just less often, so the page
          // is current when the user comes back.
          const interval = document.hidden ? 15000 : verified ? 3000 : 2500;
          const backoff = failures ? Math.min(5000, 1000 * 2 ** failures) : 0;
          timer = setTimeout(poll, Math.max(retryAfter, backoff || interval));
        }
      }
    };
    void poll();
    const refresh = () => { if (!document.hidden) void poll(); };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [run?.sandboxId, phase, expired, pollTick, verified, previewRun]);

  // Local timer countdown — ticks every second between polls
  useEffect(() => {
    if (run?.expiresInSeconds != null) setDisplaySeconds(run.expiresInSeconds);
  }, [run?.expiresInSeconds]);

  useEffect(() => {
    if (displaySeconds == null || displaySeconds <= 0 || phase !== 'workspace') return;
    const t = setInterval(() => setDisplaySeconds(prev => (prev != null && prev > 0) ? prev - 1 : 0), 1000);
    return () => clearInterval(t);
  }, [displaySeconds != null && displaySeconds > 0, phase]);

  // Warn before unload when a live test is running
  useEffect(() => {
    if (phase !== 'workspace' || !run?.sandboxId || isDemo) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase, run?.sandboxId, isDemo]);

  // Modal focus trap
  useEffect(() => {
    if (!confirmEnd) return;
    const el = modalRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>('button');
    focusable[0]?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setConfirmEnd(false); return; }
      if (e.key !== 'Tab' || !focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [confirmEnd]);

  const act = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong. Try again.'); }
    finally { setBusy(false); }
  }, []);

  const begin = (mode: 'demo' | 'connected', target?: { provider: CloudProvider; endpoint: string }) => act(async () => {
    try {
      const { opts, pastedToken } = runOptions(mode, provider, credential, target);
      let created;
      try {
        created = await createRun(opts, pastedToken);
      } catch (e) {
        // An engine without this provider: take the choice away and say so.
        if (target && e instanceof SandboxRequestError && e.code === PROVIDER_UNSUPPORTED) {
          const next = withUnsupported(unsupported, target.provider);
          setUnsupported(next.unsupported);
          setProvider(next.provider);
          // Never come back to a refused provider on reload.
          if (safeGet(PROVIDER_STORAGE) === target.provider) safeRemove(PROVIDER_STORAGE);
          setLastUsed(l => (l === target.provider ? null : l));
        }
        throw e;
      }
      // The proxy key is returned once. It is kept like the sandbox token, for
      // this test only, and never put in the run data or analytics.
      const { proxyKey: issuedProxyKey, ...result } = created;
      if (result.error || !result.sandboxId) throw new Error(result.error ?? 'Could not create your test.');
      // Remembered only once the engine accepted it, so a reload shows the right code.
      if (mode === 'connected') { safeSet(PROVIDER_STORAGE, provider); setLastUsed(provider); }
      if (issuedProxyKey) {
        saveProxyKey(result.sandboxId, issuedProxyKey);
        setShownKey({ sandboxId: result.sandboxId, proxyKey: issuedProxyKey });
      }
      if (result.fleetToken) {
        // Guarded: storage that throws (privacy modes) mustn't fail a run that was created.
        safeSet('wr_sandbox_token', result.fleetToken);
        window.dispatchEvent(new Event('storage'));
      }
      track(testStartedEvent(mode, provider));
      setRun({ ...result, mode, agents: [], ...(target ? { provider: target.provider, endpointHost: new URL(target.endpoint).hostname } : 'provider' in opts && opts.provider ? { provider: opts.provider } : {}) });
      setPhase('workspace'); setWsTab(mode === 'demo' ? 'results' : 'setup');
      if (mode === 'demo') {
        const d = await startDemo(result.sandboxId);
        if (d.error) throw new Error(d.error);
        setScene(0);
      }
    } finally { setCredential(''); setShowKey(false); }
  });

  const startTest = () => {
    if (!cloud) { void begin('connected'); return; }
    const check = cloudStart(cloud, endpointInput);
    if (!check.ok) { setEndpointError(check.error); return; }
    setEndpointError('');
    void begin('connected', { provider: check.provider, endpoint: check.endpoint });
  };

  // Anthropic vs OpenAI follows a pasted sk- key; the choice decides only for a fleet token.
  const pickProvider = (p: SandboxProvider) => {
    setProvider(!isCloudProvider(p) && (keyKind === 'anthropic' || keyKind === 'openai') ? keyKind : p);
    setEndpointError('');
  };

  // After a reload in another browser (or cleared storage), the proxy key is
  // gone; the engine can issue a fresh one for the same test.
  const recoverProxyKey = () => act(async () => {
    if (!run?.sandboxId) return;
    const r = await newProxyKey(run.sandboxId);
    if (!r.proxyKey) throw new Error(r.error ?? 'Could not get a new proxy URL. Retry.');
    saveProxyKey(run.sandboxId, r.proxyKey);
    setShownKey({ sandboxId: run.sandboxId, proxyKey: r.proxyKey });
    announceProxyKeyRotation(run.sandboxId);
  });

  // The report is built from a fresh status read, the same data the checks
  // above show, so the file and the page can't disagree.
  const downloadReport = () => act(async () => {
    if (!run?.sandboxId) return;
    // A failed refresh (test just expired, network blip) falls back to the
    // page's last copy: losing the report is worse than one slightly old.
    const latest = await getStatus().catch(() => ({}) as RunStatusResult);
    const report = buildTestReport(reportSource(latest.error ? {} : latest, run));
    track({ name: 'sandbox_report_exported', props: { mode: run.mode } });
    saveReportFile(report);
  });

  const end = () => act(async () => {
    if (!run?.sandboxId) return;
    const result = await destroyRun(run.sandboxId);
    if (result.error || !result.success) throw new Error(result.error ?? 'Could not end this test. Retry.');
    ending.current = 'user';
    clearSandboxToken();
    setRun(null); setConfirmEnd(false); setPhase('start');
  });

  if (authStatus === 'loading') return <><PageHeader title="Sandbox" /><div className={s.content}>Loading your workspace…</div></>;
  if (!session?.user?.id) return (
    <>
    <PageHeader title="Sandbox" />
    <main className={s.content}>
      <div className={s.eyebrow}>WHITEROOM / TEST RUNS</div>
      <h2 className={s.pageTitle} style={{ fontFamily: FONT_DISPLAY }}>Test your agent</h2>
      <div className={`${s.card} ${s.cardBrand}`} style={{ maxWidth: 460 }}>
        <p className={s.pageSub}>Sandbox uses your WhiteRoom account sign-in, so sign in to create and manage your test environments.</p>
        <div className={s.btnRow} style={{ marginTop: 16 }}>
          <a className={`${s.btn} ${s.btnPrimary}`} href={`/sign-in?callbackUrl=${encodeURIComponent(ROUTES.sandbox)}`} style={{ textDecoration: 'none' }}>Sign in →</a>
        </div>
      </div>
    </main>
    </>
  );

  // ── Diagnostic check icon ──
  const diagCheck = <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2.5 6l2.5 2.5 4.5-4.5"/></svg>;
  const diagAlert = <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 2.5v4M6 9.2v.1"/></svg>;
  const diagSpinner = <svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14 8"><animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="1s" repeatCount="indefinite"/></circle></svg>;

  // ── Render checks list ──
  const renderChecks = (controls: NonNullable<RunStatusResult['controls']>) => controls.map(c => {
    const ev = evidenceOf(run, c);
    // The demo walkthrough reveals one check per step.
    const status = isDemo && SANDBOX_CHECKS.findIndex(x => x.id === c.controlId) > scene ? 'unrevealed' : ev?.status;
    const passed = status === 'observed';
    const guide = checkGuidance(c.controlId, status, run, testProvider);
    return (
      <div className={s.check} key={c.controlId}>
        <div className={`${s.checkIcon} ${passed ? s.checkPass : guide.failed ? s.checkFail : s.checkWait}`} aria-label={passed ? 'Passed' : guide.failed ? 'Calls failed' : 'Waiting'}>{passed ? CHECK_ICON_PASS : guide.failed ? CHECK_ICON_FAIL : CHECK_ICON_WAIT}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={s.checkName}>{checkLabel(c.controlId, c.name)}</div>
          {passed && <div className={`${s.checkDetail} ${s.checkDetailPass}`}>Passed · {guide.detail}</div>}
          {!passed && <div className={s.checkDetail}>{guide.detail}</div>}
          {!passed && guide.action && <div className={s.checkAction}>→ {guide.action}</div>}
          {!passed && guide.progress && (
            <div className={s.progressWrap}>
              <div className={s.progressTrack}><div className={`${s.progressFill} ${s.progressFillWarn}`} style={{ width: `${Math.min(100, (guide.progress.current / guide.progress.total) * 100)}%` }} /></div>
              <span className={s.progressLabel}>{guide.progress.label}</span>
            </div>
          )}
        </div>
      </div>
    );
  });

  // ── Render activity feed ──
  const renderActivity = () => {
    const allEntries = [...(run?.auditLog ?? [])].reverse();
    const limit = activityExpanded ? allEntries.length : 20;
    const entries = allEntries.slice(0, limit);
    const hasMore = allEntries.length > limit;
    if (!entries.length) return <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx3)', textAlign: 'center', padding: '32px 0' }}>{phase === 'workspace' && !isDemo ? 'Nothing yet. Events appear here as soon as your agent makes a call.' : 'Demo events are made up to show the flow.'}</p>;
    return (
      <><ul className={s.activity}>{entries.map(e => {
        const type = e.type;
        let dotClass = s.activityDotRequest;
        if (type.includes('connect') || type.includes('register')) dotClass = s.activityDotConnect;
        else if (type.includes('handover') || type.includes('handoff')) dotClass = s.activityDotHandover;
        else if (type.includes('policy') || type.includes('observe')) dotClass = s.activityDotPolicy;
        return (
          <li className={s.activityItem} key={e.id}>
            <span className={`${s.activityDot} ${dotClass}`} />
            <div>
              <div className={s.activityType}>{eventLabel(e.type)}</div>
              <div className={s.activityMeta}>{e.agentId ?? 'System'} · {new Date(e.timestamp).toLocaleTimeString()}</div>
            </div>
          </li>
        );
      })}</ul>
      {hasMore && <button className={`${s.btn} ${s.btnGhost}`} onClick={() => setActivityExpanded(true)} style={{ width: '100%', marginTop: 8, fontSize: 'var(--fs-sm)' }}>Show all {allEntries.length} events</button>}
      </>
    );
  };

  return <>
    {/* ── Topbar (workspace only) ── */}
    {phase === 'workspace' && run && (
      <PageHeader title="Sandbox" badge={<span className={`${s.badgeMode} ${isDemo ? s.demo : s.live}`}>{isDemo ? 'DEMO' : 'LIVE TEST'}</span>}>
        <TestTimer seconds={displaySeconds} expired={!!expired} />
      </PageHeader>
    )}

    {/* ── Header (start/setup only) ── */}
    {phase !== 'workspace' && (
      <PageHeader title="Sandbox" badge={<span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', whiteSpace: 'nowrap' }}>Test runs never count toward your fleet&rsquo;s numbers.</span>} />
    )}

    <main className={s.content}>
      <div className={s.layout}>
      <StepsRail current={sandboxStep(phase, { stage, allPassed, expired: !!expired, demo: !!isDemo, demoScene: isDemo ? scene : undefined })} />
      <div className={s.body}>
      {error && <div className={s.error}>{error} <button className={s.btn} onClick={() => { setError(''); setPollTick(v => v + 1); }} style={{ marginLeft: 8, minHeight: 28, padding: '4px 12px', fontSize: 'var(--fs-sm)' }}>Retry</button></div>}
      {reconnecting && <div className={s.notice}>Reconnecting. Your last received results are shown. <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => setPollTick(v => v + 1)} style={{ marginLeft: 8, minHeight: 28, padding: '4px 12px', fontSize: 'var(--fs-sm)' }}>Check now</button></div>}

      {booting ? <p>Checking for an existing test…</p> : phase === 'start' ? <>
        {/* ═══ START ═══ */}
        <div className={s.eyebrow}>WHITEROOM / SANDBOX</div>
        <h2 ref={heading} tabIndex={-1} className={s.pageTitle} style={{ fontFamily: FONT_DISPLAY }}>Test your agent</h2>
        <p className={s.pageSub}>Check that your agent works through WhiteRoom before you use it for real. It takes about 3 minutes and doesn’t touch your live fleet.</p>

        <CheckPreview />

        <div className={s.btnRow}>
          <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => setPhase('setup')}>Test my agent →</button>
          <button className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void begin('demo')}>See a demo first</button>
        </div>
        <p className={s.small} style={{ marginTop: 10 }}>You’ll need the API key your agent uses. The demo needs nothing.</p>
        <PracticeCard entry={practice} />
      </> : phase === 'setup' ? <>
        {/* ═══ SETUP ═══ */}
        <div className={s.eyebrow}>WHITEROOM / SANDBOX</div>
        <h2 ref={heading} tabIndex={-1} className={s.pageTitle} style={{ fontFamily: FONT_DISPLAY }}>Start your test</h2>
        <p className={s.pageSub}>{cloud
          ? 'Tell us where your agent’s model runs. Your agent keeps its own key; this test gives it a URL to call through.'
          : 'Paste the API key your agent uses. We only use it to link this test to your agent’s calls; the key itself is never stored.'}</p>
        <div className={`${s.card} ${s.cardBrand}`} style={{ maxWidth: 480 }}>
          <ProviderChoices value={provider} unsupported={unsupported} disabled={busy} followsKey={!cloud && (keyKind === 'anthropic' || keyKind === 'openai')} lastUsed={lastUsed} onPick={pickProvider} />
          {cloud ? (
            <CloudEndpointField provider={cloud} value={endpointInput} error={endpointError}
              onChange={v => {
                const next = withEndpoint(endpoints, cloud, v);
                setEndpoints(next); setEndpointError('');
                saveEndpoints(next);
              }}
              onSubmit={() => { if (!busy) startTest(); }} />
          ) : (
          <KeyField credential={credential} showKey={showKey} provider={directProvider} onChange={setCredential} onToggleShow={() => setShowKey(v => !v)} />
          )}
          <div className={s.btnRow} style={{ marginTop: 8 }}>
            <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy || (cloud ? !endpointInput.trim() : !['anthropic', 'openai', 'fleet'].includes(keyKind))} onClick={startTest}>{busy ? 'Starting…' : 'Start test →'}</button>
            <button className={`${s.btn} ${s.btnGhost}`} onClick={() => { setPhase('start'); setCredential(''); setShowKey(false); setEndpointError(''); }}>Back</button>
          </div>
        </div>
      </> : <>
        {/* ═══ WORKSPACE ═══ */}
        {expired && <div className={s.notice}>This test has ended (tests last 30 minutes). Your results are below. Download them before you start a new test.</div>}

        {/* Summary banner */}
        {run && (() => {
          const controls = run.controls ?? [];
          const passed = checksPassedCount(run);
          const total = controls.length;
          const banner = (tone: string, head: string, rest: string) => (
            <div className={`${s.summary} ${tone}`}><h2 ref={summaryHeading} tabIndex={-1} className={s.summaryHead}>{head}</h2>{rest && ` ${rest}`}</div>
          );
          if (isDemo) return banner('', 'This is a demo.', 'It uses made-up data to show the flow. It doesn’t test your agent.');
          if (allPassed) return banner(s.summaryPass, `All ${total} checks passed.`, 'Your agent works through WhiteRoom.');
          const nextCheck = controls.find(c => !isObserved(run, c));
          const nextLabel = nextCheck ? checkLabel(nextCheck.controlId, nextCheck.name).toLowerCase() : '';
          if (failing) return banner(s.summaryFail, `${callCount(failing.count)} failed.`, `${failedCallReason(failing, testProvider)}. See Connect for what to check.`);
          if (passed === 0) return banner('', 'Waiting for your agent.', 'Add the code from Connect, then run your agent.');
          return banner('', `${passed} of ${total} checks passed.`, nextLabel ? `Next: ${nextLabel}.` : '');
        })()}

        {/* Workspace tabs */}
        <WorkspaceTabs value={wsTab} onChange={setWsTab} />

        {/* ── Setup tab ── */}
        <WorkspacePanel tab="setup" active={wsTab === 'setup'}>
          <h3 className={s.sectionTitle} style={{ fontFamily: FONT_DISPLAY }}>1. Point your agent at this test</h3>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', margin: '0 0 10px' }}>Point your agent at the test URL with this setup. Your API key stays where it is.</p>
          <div className={s.selectRow}>
            {isDemo ? <>
              <button className={`${s.selectPill} ${directProvider === 'anthropic' ? s.selectPillOn : ''}`} onClick={() => setProvider('anthropic')}>Anthropic</button>
              <button className={`${s.selectPill} ${directProvider === 'openai' ? s.selectPillOn : ''}`} onClick={() => setProvider('openai')}>OpenAI</button>
            </> : (
              // The test is tied to the key it started with, so its provider is fixed.
              <span className={s.small} style={{ alignSelf: 'center' }}>{liveCloud ? providerSummary(liveCloud, run?.endpointHost) : provider === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
            )}
            <span style={{ width: 12 }} />
            {setupChoices(testProvider).map(l => (
              <button key={l} type="button" className={`${s.selectPill} ${language === l ? s.selectPillOn : ''}`} aria-pressed={language === l} onClick={() => setLanguage(l)}>{l === 'env' ? 'No code change' : l}</button>
            ))}
          </div>
          {noCode ? <>
            <p className={s.noCodeLead}>{noCode.lead}</p>
            {noCode.code && <>
              <pre className={s.recipe} style={{ fontFamily: FONT_MONO }}>{noCode.code}</pre>
              <CopyButton text={noCode.code} disabled={!!liveCloud && !proxyKey} />
            </>}
            {noCode.note && <p className={s.small} style={{ marginTop: 8 }}>{noCode.note}</p>}
          </> : <>
            <pre className={s.recipe} style={{ fontFamily: FONT_MONO }}>{recipe}</pre>
            <CopyButton text={recipe} disabled={!!liveCloud && !proxyKey} />
            {!isDemo && agentNameNote(run) && <p className={s.small} style={{ marginTop: 8 }}>{agentNameNote(run)}</p>}
          </>}
          {liveCloud && !proxyKey && <ProxyKeyNotice disabled={busy || !!expired} onRecover={() => { void recoverProxyKey(); }} />}

          {!isDemo && <>
            <h3 className={s.sectionTitle} style={{ fontFamily: FONT_DISPLAY, marginTop: 20 }}>2. Run your agent</h3>
            <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Run one normal task. This updates as soon as its calls arrive.</p>
            <div className={s.diag}>
              {[
                { label: 'WhiteRoom is ready', sub: stage >= 1 ? 'Ready for your agent' : 'Checking…', at: 1 },
                // Done as soon as any call arrives (even before one succeeds); in progress while waiting.
                { ...recognizedStep(run, agentId), at: 2, done: callArrived(run) },
                { label: 'Its first call went through', sub: stage >= 3 ? `Passed through WhiteRoom${failed ? ` · ${callCount(failed.count)} failed` : ''}` : 'Waiting — run one normal task', at: 3, fail: failNotice },
                { label: 'It got a normal reply', sub: stage >= 4 ? 'Your provider answered as usual' : 'Checks your provider answered', at: 4 },
              ].map((d, i) => (
                <div className={s.diagStep} key={i}>
                  <span className={`${s.diagDot} ${{ fail: s.diagFail, done: s.diagDone, active: s.diagActive, pending: s.diagPending }[diagStepState(diagShown, d)]}`} aria-label={d.fail ? 'Failed' : undefined}>
                    {{ fail: diagAlert, done: diagCheck, active: diagSpinner, pending: null }[diagStepState(diagShown, d)]}
                  </span>
                  <div>
                    <div className={diagShown >= d.at ? s.diagLabel : s.diagLabelPending}>{d.label}</div>
                    {d.fail ? <>
                      <div className={`${s.diagSub} ${s.diagSubFail}`}>{d.fail.what}</div>
                      <div className={s.checkAction}>→ {d.fail.next}</div>
                    </> : <div className={s.diagSub}>{d.sub}</div>}
                  </div>
                </div>
              ))}
            </div>

            <details open={help.open} onToggle={e => helpDispatch({ type: 'toggle', open: e.currentTarget.open })} style={{ marginTop: 12, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Nothing happening?</summary>
              <ul style={{ paddingLeft: 18, marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--tx3)', lineHeight: 1.7 }}>
                {liveCloud ? <CloudTroubleshooting provider={liveCloud} endpointHost={run?.endpointHost} /> : <>
                <li>Make sure your agent uses the same API key you pasted to start this test.</li>
                <li>Every call needs both headers from the code above: <code>x-whiteroom-fleet</code> and <code>x-whiteroom-agent</code>.</li>
                <li>OpenAI agents must use the <code>/v1</code> URL shown above.</li>
                </>}
                <li>If your provider returns an error or a rate limit, the call doesn’t count. Check your key has credit.</li>
              </ul>
            </details>
          </>}
        </WorkspacePanel>

        {/* ── Results tab ── */}
        <WorkspacePanel tab="results" active={wsTab === 'results'}>
          {isDemo && (
            <div className={s.card} style={{ marginBottom: 16 }}>
              <div className={s.eyebrow}>DEMO WALKTHROUGH</div>
              <h2 style={{ fontFamily: FONT_DISPLAY }}>{DEMO_STORY[scene].title}</h2>
              <p>{DEMO_STORY[scene].text}</p>
              <div className={s.btnRow}>
                <button className={`${s.btn} ${s.btnSecondary}`} disabled={scene === 0} onClick={() => setScene(v => v - 1)} style={{ minHeight: 32, padding: '4px 14px', fontSize: 'var(--fs-sm)' }}>Previous</button>
                <span className={s.small} style={{ alignSelf: 'center' }}>Step {scene + 1} of {DEMO_STORY.length}</span>
                <button className={`${s.btn} ${s.btnSecondary}`} disabled={scene === DEMO_STORY.length - 1} onClick={() => setScene(v => v + 1)} style={{ minHeight: 32, padding: '4px 14px', fontSize: 'var(--fs-sm)' }}>Next</button>
              </div>
            </div>
          )}

          {renderChecks(run?.controls ?? [])}

          {/* Production card when all passed */}
          {allPassed && !isDemo && (
            <div className={s.prod}>
              <div className={s.prodTitle} style={{ fontFamily: FONT_DISPLAY }}>Ready to go live</div>
              {liveCloud ? <CloudGoLive provider={liveCloud} /> : language === 'env' ? <>
              <p>On your live fleet, agents with a system prompt need no code change. Set this and run your agent as before.</p>
              <pre className={s.recipe} style={{ fontFamily: FONT_MONO }}>{SETUP_LINES[directProvider]}</pre>
              </> : <>
              <p>{prodFleetId
                ? <>To run this agent on your live fleet, use this instead. Your fleet (<code>{prodFleetId}</code>) and agent name are already filled in.</>
                : <>To run this agent for real, use this and put in your live fleet ID.</>}</p>
              <pre className={s.recipe} style={{ fontFamily: FONT_MONO }}>{connectionRecipe(directProvider, prodFleetId ?? 'YOUR_FLEET_ID', agentId, codeLanguage)}</pre>
              </>}
              <div className={s.btnRow} style={{ marginTop: 8 }}>
                {!liveCloud && <CopyButton text={language === 'env' ? SETUP_LINES[directProvider] : connectionRecipe(directProvider, prodFleetId ?? 'YOUR_FLEET_ID', agentId, codeLanguage)} />}
                <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => { void downloadReport(); }} disabled={busy} style={{ fontSize: 'var(--fs-sm)' }}>Download report</button>
              </div>
              {practice.rows && <p style={{ marginTop: 10 }}>Want more confidence before going live? <Link className={s.linkBtn} href={ROUTES.practiceTest}>Run a practice test</Link>: {PRACTICE_SUMMARY}.</p>}
            </div>
          )}

          {isDemo && <div className={s.btnRow}>
            <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => act(async () => {
              if (!run?.sandboxId) return;
              const result = await destroyRun(run.sandboxId);
              if (result.error || !result.success) throw new Error(result.error ?? 'Could not end this test. Retry.');
              ending.current = 'user';
              clearSandboxToken();
              setRun(null); setConfirmEnd(false);
              setPhase('setup');
            })} disabled={busy} style={{ fontSize: 'var(--fs-sm)' }}>Now test my agent →</button>
          </div>}

          <p className={s.small} style={{ marginTop: 12 }}>These checks show your agent works through WhiteRoom. They don’t check that its answers are correct. Use them to help decide, not as a certificate.</p>
        </WorkspacePanel>

        {/* ── Activity tab ── */}
        <WorkspacePanel tab="activity" active={wsTab === 'activity'}>
          {activityHeader && <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)', marginBottom: 12 }}>{activityHeader}</p>}
          {renderActivity()}
        </WorkspacePanel>

        {/* Test actions, on every tab. On Checks, a passed live test's card already offers the report. */}
        {run && <div className={s.btnRow}>
          {!(allPassed && !isDemo && wsTab === 'results') && <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => { void downloadReport(); }} disabled={busy} style={{ fontSize: 'var(--fs-sm)' }}>Download report</button>}
          <button className={`${s.btn} ${s.btnGhost}`} onClick={() => setConfirmEnd(true)}>End test</button>
        </div>}

        {/* Footer */}
        {run && <div className={s.footer}>{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()} · ` : ''}Test {run.sandboxId}{liveCloud ? ` · ${providerSummary(liveCloud, run.endpointHost)}` : ''}{expired ? ' · Expired' : ''}</div>}
      </>}

      {!booting && phase === 'start' && <PastTests preview={previewUserId ? (previewPastTests ?? []) : undefined} practice={practice.rows ?? undefined} onDemo={busy ? undefined : () => void begin('demo')} />}
      </div>
      </div>

      {/* ── Confirm-end modal ── */}
      {confirmEnd && (
        <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) setConfirmEnd(false); }}>
          <div className={s.modal} ref={modalRef} role="alertdialog" aria-labelledby="end-title">
            <h2 id="end-title" style={{ fontFamily: FONT_DISPLAY }}>End this test?</h2>
            <p>{endTestText(run)}</p>
            <div className={s.btnRow}>
              <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void end()} style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}>End test</button>
              <button className={`${s.btn} ${s.btnSecondary}`} onClick={() => { void downloadReport(); }} disabled={busy}>Download report</button>
              <button className={`${s.btn} ${s.btnGhost}`} onClick={() => setConfirmEnd(false)}>Keep testing</button>
            </div>
          </div>
        </div>
      )}
    </main>
  </>;
}
