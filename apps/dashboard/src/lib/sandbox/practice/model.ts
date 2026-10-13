// Practice tests in the dashboard (sandbox readiness spec rev 5.6, §5, §6, §8,
// §10): the decisions and copy the screens render, kept pure so they can be
// tested without a browser. Check names, observers and fix lines come from
// the engine's catalog (catalog.json, copied from its contract fixtures);
// nothing here invents a check.

import type { GovernanceRule } from '@/lib/whiteroom/types';
import { failedCallReason } from '@/lib/sandbox/failed-calls';
import { isSandboxProvider, SANDBOX_PROVIDER_LABELS, type SandboxProvider } from '@/lib/sandbox/providers';
import { fmtDay } from '@/lib/format';
import CATALOG from './catalog.json';
import type {
  PracticeCheck, PracticeFailedCalls, PracticeKeyRefusal, PracticeProviderKey, PracticeReport, PracticeRun, PracticeRunRow, PracticeSource, PracticeStart,
  PracticeVerdict, RunCode,
} from './types';

export { CATALOG };
/** The BFF's reason when practice tests aren't on for this engine: a calm page, not an error, and never retried. */
export const PRACTICE_UNAVAILABLE = 'practice_unavailable';
export const DISCLAIMER = 'Practice tasks use made-up records and WhiteRoom’s test tools, not your agent’s real job. Use the result to help decide, not as a certificate.';

// ── The plan: which practice tasks a test plays ──────────────────────────

export type Scenario = 'A' | 'B_base' | 'B_long' | 'C_timeout' | 'C_fail';
const SCENARIOS: readonly Scenario[] = ['A', 'B_base', 'B_long', 'C_timeout', 'C_fail'];
/** The practice task each agent check is judged on (the engine's READINESS_CHECKS `task`). */
const TASK_OF: Record<string, Scenario> = {
  'a.result': 'A', 'b.baseline': 'B_base', 'b.result': 'B_long', 'b.carries_on': 'B_long', 'b.no_redo': 'B_long',
  'c.timeout': 'C_timeout', 'c.keeps_failing': 'C_fail',
};
/** What the running screen calls each practice task. */
export const TASK_NAMES: Record<Scenario | 'controls', string> = {
  A: 'Finishes a job correctly',
  B_base: 'Handles a long task (short version)',
  B_long: 'Handles a long task (long version)',
  C_timeout: 'Handles a failing tool (the tool times out)',
  C_fail: 'Handles a failing tool (the tool keeps failing)',
  controls: 'Checks your controls',
};

/** One run's practice tasks, in the engine's order (planScenarios): all of them, or those a rerun's checks need. */
export function planOf(scope: string[] | null): (Scenario | 'controls')[] {
  const agent = SCENARIOS.filter((s) => !scope || scope.some((id) => TASK_OF[id] === s));
  return !scope || scope.some((id) => id.startsWith('ctl')) ? [...agent, 'controls'] : agent;
}

/** Tasks in a whole test, the control checks counted as one a run (as the engine counts them): Past tests' "18/18". */
export function practiceTaskCount(runs: number, scope: string[] | null): number {
  return runs * planOf(scope).length;
}

// ── The CLI ──────────────────────────────────────────────────────────────

/** The exact CLI release the dashboard names (D12). Bumped with the CLI at publish. */
export const CLI_VERSION = '2.0.0';
/** Until the CLI is on npm (D2), the invite-only beta installs a packed build with its sha256. Flip at publish. */
export const CLI_ON_NPM = false;
export const BETA_TGZ = `whiteroom-ai-cli-${CLI_VERSION}.tgz`;
const CLI = CLI_ON_NPM ? `npx @whiteroom-ai/cli@${CLI_VERSION}` : 'whiteroom';

export type StarterLang = 'js' | 'python';
const STARTER_FILE: Record<StarterLang, string> = { js: 'wr-adapter.mjs', python: 'wr_adapter.py' };
const STARTER_RUN: Record<StarterLang, string> = { js: 'node wr-adapter.mjs', python: 'python3 wr_adapter.py' };

/** The beta's install lines: check the file, then install it. Empty once the CLI is on npm. */
export const BETA_INSTALL = CLI_ON_NPM ? [] : [`shasum -a 256 ${BETA_TGZ}`, `npm install -g ./${BETA_TGZ}`];

/**
 * The commands the terminal steps show. The run code is never part of one
 * (§10 CLI): the CLI asks for it.
 */
export function cliCommands(sample: boolean, lang: StarterLang): { starter: string | null; run: string } {
  return {
    starter: sample ? null : `${CLI} practice adapter --lang ${lang} > ${STARTER_FILE[lang]}`,
    run: sample ? `${CLI} practice run` : `${CLI} practice run --adapter "${STARTER_RUN[lang]}"`,
  };
}

/** The variable the CLI reads each provider's key from (the providers' own SDKs read these). */
export const KEY_VARS: Record<SandboxProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  foundry: 'ANTHROPIC_FOUNDRY_API_KEY',
  'bedrock-mantle': 'AWS_BEARER_TOKEN_BEDROCK',
};

/** The variable the CLI reads the fleet's own key from, by the model the agent uses; both when it isn't known. */
export function keyVariable(model: string | null | undefined): string {
  if (!model) return 'ANTHROPIC_API_KEY or OPENAI_API_KEY';
  return /^claude/i.test(model) ? KEY_VARS.anthropic : KEY_VARS.openai;
}

/** The models the sample agent uses unless setup names one (the JS starter's own choice, by key). */
export const SAMPLE_MODELS = { anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini' } as const;

/** The engine's own words when Start refuses a fleet with a host of its own and no Fleet key key to pick (reason `unsupported`). */
export const UNSUPPORTED_FLEET = 'Practice tests don’t support this fleet’s provider yet.';

// ── Provider keys (R7, §17): the Fleet key key a test runs on ───────────

/** Why a key or fleet can't be tested, in the engine's catalog words: Start answers with these reasons too. */
export const KEY_REFUSALS = CATALOG.keyRefusals as Record<PracticeKeyRefusal, string>;
/** A Fleet key key's display prefix, as Start takes it. */
export const PROXY_KEY_PREFIX_RE = /^sk-wr-[0-9a-f]{16}$/;

/** The key a test runs on: a Fleet key provider key (R7), or the fleet's own key. What the key line and cost say. */
export interface PracticeKeyChoice {
  provider: SandboxProvider;
  keyHint: string | null;
}

/** Cloud providers have no default model: setup asks for it, and Start needs it. */
export const CLOUD_MODEL_FIELD: Partial<Record<SandboxProvider, { label: string; hint: string; placeholder: string; missing: string }>> = {
  'azure-openai': { label: 'Azure deployment name', hint: '· the deployment your agent calls', placeholder: 'my-gpt-4o-mini', missing: 'Enter the deployment name to start.' },
  'bedrock-mantle': { label: 'Bedrock model ID', hint: '· like anthropic.claude-haiku-4-5', placeholder: 'anthropic.claude-haiku-4-5', missing: 'Enter the Bedrock model ID to start.' },
  foundry: { label: 'Foundry model', hint: '· your Claude deployment’s name, like claude-haiku-4-5', placeholder: 'claude-haiku-4-5', missing: 'Enter the Foundry model to start.' },
};

/** Fleet key's names for every provider a key can have, the ones practice tests can't use included. */
const KEY_PROVIDER_LABELS: Record<string, string> = {
  ...SANDBOX_PROVIDER_LABELS, azure: 'Azure OpenAI', 'bedrock-sigv4': 'AWS Bedrock', 'foundry-entra': 'Claude on Azure (Foundry)',
};
/** A key's last four, as Fleet key shows them; keys that use WhiteRoom's own access have none. */
const hintOf = (k: Pick<PracticeProviderKey, 'keyHint'>) => (k.keyHint && k.keyHint !== 'none' ? k.keyHint : null);

/** "AWS Bedrock · us-east-1 · key ending a1b2 · added Oct 3", in Fleet key's words. */
export function providerKeyLabel(k: PracticeProviderKey, now = Date.now()): string {
  const hint = hintOf(k);
  const added = k.createdAt ? fmtDay(k.createdAt, now) : '';
  return [KEY_PROVIDER_LABELS[k.provider] ?? k.provider, k.region ?? k.endpointHost, hint && `key ending ${hint}`, added && `added ${added}`].filter(Boolean).join(' · ');
}

export const choiceOf = (k: PracticeProviderKey): PracticeKeyChoice | null =>
  isSandboxProvider(k.provider) ? { provider: k.provider, keyHint: hintOf(k) } : null;

/**
 * What setup can test with, from source-model: the eligible Fleet key keys,
 * and whether the fleet's own key is a choice too (it is when it can start
 * a test; with Fleet key keys too, only when the agent's calls use it). The
 * default is the fleet's own key when its agent calls with it, else the
 * first eligible key.
 */
export function keyOptions(src: PracticeSource): { keys: PracticeProviderKey[]; direct: boolean; initial: string | null } {
  const keys = src.providerKeys.filter((k) => k.eligible && isSandboxProvider(k.provider));
  const agentDirect = src.provider === 'direct-anthropic' || src.provider === 'direct-openai';
  const direct = src.directKey && (keys.length === 0 || agentDirect);
  return { keys, direct, initial: direct && (agentDirect || !keys.length) ? null : keys[0]?.displayPrefix ?? null };
}

/** The key line: which variable to set, to which key (§10 fixed copy; R7 names the Fleet key key). */
export function keyLine(choice: PracticeKeyChoice | null, model: string | null | undefined, fleet: string): { before: string; keyVar: string; after: string } {
  if (!choice) return { before: 'Set ', keyVar: keyVariable(model), after: ` to the key your agent uses with ${fleet}.` };
  const hint = choice.keyHint ? ` (key ending ${choice.keyHint})` : '';
  return { before: 'Run this where ', keyVar: KEY_VARS[choice.provider], after: ` is set to the same ${SANDBOX_PROVIDER_LABELS[choice.provider]} key you added on Fleet key${hint}.` };
}

// ── Cost (§1: the range and the cap before anything runs) ────────────────

/** Model calls a practice task usually takes, from the reference agent's runs (an estimate, not a cap). */
const USUAL_CALLS: Record<Scenario, [number, number]> = { A: [6, 10], B_base: [8, 12], B_long: [15, 25], C_timeout: [4, 7], C_fail: [4, 8] };

/**
 * List prices in dollars per million tokens (input, output) for the models we
 * can price; longest prefix first so dated and point releases match.
 * Anything else gets the call counts without a dollar figure.
 */
const PRICES: [string, number, number][] = [
  ['claude-haiku-4-5', 1, 5],
  ['claude-sonnet-5-5', 2, 10], ['claude-sonnet-5', 2, 10], ['claude-sonnet-4-6', 3, 15], ['claude-sonnet-4-5', 3, 15],
  ['claude-opus-5-5', 4, 20], ['claude-opus-5', 5, 25], ['claude-opus-4-8', 5, 25], ['claude-opus-4-7', 5, 25], ['claude-opus-4-6', 5, 25], ['claude-opus-4-5', 5, 25],
  ['gpt-4o-mini', 0.15, 0.6], ['gpt-4o', 2.5, 10],
];
/** A practice call's size: 6k–10k tokens in (records and tool results), 150–400 out. */
const CALL_TOKENS = { in: [6_000, 10_000], out: [150, 400] } as const;

/** A Bedrock model ID as Anthropic names the model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" → "claude-haiku-4-5-20251001". */
const anthropicName = (model: string) => model.toLowerCase().replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '');

function perCall(model: string | null | undefined): [number, number] | null {
  const p = model ? PRICES.find(([prefix]) => model.toLowerCase().startsWith(prefix)) : undefined;
  if (!p) return null;
  const [, i, o] = p;
  return [(CALL_TOKENS.in[0] * i + CALL_TOKENS.out[0] * o) / 1e6, (CALL_TOKENS.in[1] * i + CALL_TOKENS.out[1] * o) / 1e6];
}

const dollars = (n: number) => `$${n < 0.1 ? n.toFixed(2) : (Math.round(n * 20) / 20).toFixed(2)}`;

export interface CallEstimate {
  /** Usual model calls over the whole test. */
  low: number;
  high: number;
  /** Never more than this many: each task's allowance and the control checks. */
  cap: number;
  /** At list price, when the model has one we know. */
  cost: [number, number] | null;
  /** R7: who bills the calls, when it's a cloud account. Azure's prices aren't shown; Bedrock's are Anthropic's list prices, approximately. */
  billedBy: 'Azure' | 'AWS' | null;
}

/** Who bills a provider's calls, for the cost line. */
const BILLED_BY: Partial<Record<SandboxProvider, 'Azure' | 'AWS'>> = { 'azure-openai': 'Azure', foundry: 'Azure', 'bedrock-mantle': 'AWS' };

/**
 * What a test usually costs and its hard cap, for `runs` runs of `scope`
 * (null: everything) plus `controlCalls` extra calls for the control checks.
 */
export function callEstimate(o: { runs: number; scope: string[] | null; controlCalls: number; model: string | null | undefined; provider?: SandboxProvider | null }): CallEstimate {
  const plan = planOf(o.scope);
  const tasks = plan.filter((s): s is Scenario => s !== 'controls');
  const controls = plan.includes('controls') ? o.controlCalls : 0;
  const allowances = CATALOG.allowances as Record<Scenario, number>;
  const low = o.runs * (tasks.reduce((n, s) => n + USUAL_CALLS[s][0], 0) + controls);
  const high = o.runs * (tasks.reduce((n, s) => n + USUAL_CALLS[s][1], 0) + controls);
  const perRun = Math.min(CATALOG.runCallCap, tasks.reduce((n, s) => n + allowances[s], 0) + (plan.includes('controls') ? CATALOG.controlCallsMax : 0));
  const billedBy = (o.provider && BILLED_BY[o.provider]) ?? null;
  const price = billedBy === 'Azure' ? null : perCall(billedBy === 'AWS' && o.model ? anthropicName(o.model) : o.model);
  return { low, high, cap: o.runs * perRun, cost: price && [low * price[0], high * price[1]], billedBy };
}

/** "usually 40–65 model calls (≈ $0.25–$0.80 at list price)"; Bedrock "(approx. $0.25–$0.80 at Anthropic’s list prices)". */
export function usualCalls(e: CallEstimate): string {
  const range = e.cost && `${dollars(e.cost[0])}–${dollars(e.cost[1])}`;
  const price = !range ? '' : e.billedBy === 'AWS' ? ` (approx. ${range} at Anthropic’s list prices)` : ` (≈ ${range} at list price)`;
  return `usually ${e.low}–${e.high} model calls${price}`;
}

const billing = (e: CallEstimate) => (e.billedBy ? `, billed by your ${e.billedBy} account` : '');

/** Setup's cost line. On Azure, only the cap: what the calls cost depends on the deployment. */
export function costLine(e: CallEstimate, runs: number): string {
  const cap = runs > 1 ? `${CATALOG.runCallCap} calls a run (${e.cap} in all)` : `${e.cap} calls`;
  if (e.billedBy === 'Azure') return `Never more than ${cap}${billing(e)}. That includes control checks and memory summaries.`;
  return `On your own key: ${usualCalls(e)}. Never more than ${cap}${billing(e)}, including control checks and memory summaries.`;
}

// ── Control checks (§6): what setup says will be checked ─────────────────

export interface ControlPreview {
  /** The result row's ID: ctl.pause_stop, or ctl.<rule type>.<rule ID>. */
  id: string;
  label: string;
  mode: string | null;
  /** Extra model calls this check makes; null when it isn't checked. */
  calls: number | null;
  note: string | null;
}

const RULE_LABELS = CATALOG.controls.labels as Record<string, string>;
const MODE_LABELS = CATALOG.controls.modes as Record<string, string>;
const LIMITS = CATALOG.controls.limits;

/**
 * The control checks a run will make, from the fleet's rules, with the extra
 * calls each takes. The engine has the final say (it may skip a rule another
 * one shadows); this is what setup promises at most.
 */
export function controlPreview(rules: GovernanceRule[], durableHolds: boolean, sampleWithoutAgents: boolean): ControlPreview[] {
  const rows: ControlPreview[] = [];
  if (durableHolds) rows.push({ id: 'ctl.pause_stop', label: RULE_LABELS.pause_stop, mode: null, calls: 2, note: null });
  for (const r of rules) {
    const id = `ctl.${r.ruleType}.${r.id}`;
    const label = RULE_LABELS[r.ruleType] ?? r.ruleType;
    const mode = MODE_LABELS[r.mode] ?? null;
    const p = r.params as { maxCalls?: number; threshold?: number; allowedModels?: string[] };
    const skip = (note: string): ControlPreview => ({ id, label, mode, calls: null, note });
    if (r.ruleType === 'spend_cap') rows.push(skip('not checked (it would need real spending)'));
    else if (r.ruleType === 'tool_list') rows.push(skip('not checked yet'));
    else if (r.ruleType === 'model_allowlist' && !p.allowedModels?.length) rows.push(skip('not checked: no models on the list yet'));
    else if ((r.ruleType === 'call_rate' && (p.maxCalls ?? 0) > LIMITS.call_rate) || (r.ruleType === 'loop_breaker' && (p.threshold ?? 0) > LIMITS.loop_breaker)) {
      rows.push(skip('not checked: too many calls to test cheaply'));
    } else if (r.appliesTo !== 'all' && sampleWithoutAgents) rows.push(skip('not checked: the sample agent only checks rules for all agents'));
    else {
      // A scoped rule is checked twice: with an agent it covers and one it doesn't.
      const each = r.ruleType === 'call_rate' ? p.maxCalls ?? 0 : r.ruleType === 'loop_breaker' ? Math.max(0, (p.threshold ?? 1) - 1) : 0;
      rows.push({ id, label, mode, calls: each * (r.appliesTo === 'all' ? 1 : 2), note: null });
    }
  }
  return rows;
}

/** The control checks' extra calls, within the engine's budget for them; only the rows a rerun covers when it names some. */
export function controlCalls(rows: ControlPreview[], scope: string[] | null = null): number {
  const covered = rows.filter((r) => !scope || scope.includes('ctl') || scope.includes(r.id));
  return Math.min(CATALOG.controlCallsMax, covered.reduce((n, r) => n + (r.calls ?? 0), 0));
}

/** "Call rate · Watch · 5 extra calls" / "Spend cap: not checked (it would need real spending)". */
export function controlPreviewLine(r: ControlPreview): string {
  const name = r.mode ? `${r.label} · ${r.mode}` : r.label;
  if (r.calls === null) return `${name}: ${r.note}`;
  return `${name} · ${r.calls ? `${r.calls} extra call${r.calls === 1 ? '' : 's'}` : 'no extra calls'}`;
}

// ── Results (§8) ─────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const STATUS_LABEL: Record<PracticeCheck['status'], string> = {
  passed: 'Passed', failed: 'Failed', not_tested: 'Didn’t run', unsupported: 'Not checked', error: 'Test problem (not your agent)',
};
export const VERDICT_LABEL: Record<PracticeVerdict, string> = { passed: 'Passed', not_passed: 'Didn’t pass', incomplete: 'Didn’t finish' };

const required = (r: PracticeReport) => r.checks.filter((c) => c.required);
/** Required checks that didn't pass. */
export const openChecks = (r: PracticeReport) => required(r).filter((c) => c.status !== 'passed');

/** "Passed · all 9 checks · 3 runs", "Didn't pass · 1 check failed", "Didn't finish · 2 checks couldn't run (not your agent)". */
export function headline(r: PracticeReport): string {
  const runs = plural(r.runs, 'run');
  if (r.verdict === 'passed') {
    const scope = r.scope && [...new Set(required(r).map((c) => c.scenario))].join(', ');
    return `Passed · ${scope ? `${scope} only` : `all ${plural(required(r).length, 'check')}`} · ${runs}`;
  }
  if (r.verdict === 'not_passed') return `Didn’t pass · ${plural(required(r).filter((c) => c.status === 'failed').length, 'check')} failed`;
  const open = openChecks(r);
  const ours = open.length > 0 && open.every((c) => c.testProblem);
  return `Didn’t finish · ${open.length ? `${plural(open.length, 'check')} couldn’t run` : 'no checks could run'}${ours ? ' (not your agent)' : ''}`;
}

/** What a passed result doesn't prove (Appendix D), or null. */
export function passCaveat(r: PracticeReport): string | null {
  if (r.verdict !== 'passed') return null;
  if (r.sample) return 'This was WhiteRoom’s sample agent: it checks your controls and this setup, not your own agent.';
  if (r.runs === 1) return 'One run shows your agent can pass. Run it 3 times to see that it passes every time.';
  return null;
}

/** The provider a test's calls went to: the Fleet key key's (R7), else the fleet's own key's, by the model it used. */
export function providerOf(r: PracticeReport): SandboxProvider {
  if (isSandboxProvider(r.tested.provider)) return r.tested.provider;
  return /^claude/i.test(r.tested.modelsUsed[0] ?? r.tested.modelRequested ?? 'claude') ? 'anthropic' : 'openai';
}

/**
 * A check's fix line. A provider refusal names what the provider said and
 * what to check (§10 fixed copy, from what WhiteRoom saw); others are the
 * catalog's line as the engine filled it in.
 */
export function fixLine(c: PracticeCheck, r: PracticeReport): string | null {
  const f = c.reason === 'provider_refused' ? asFailedCalls(c.failedCalls) : null;
  if (!f) return c.fix;
  const provider = providerOf(r);
  return `Test problem (not your agent): ${failedCallReason(f, provider)}. ${providerNextStep(f.last, KEY_VARS[provider])} Rerun this check to try again.`;
}

/** What to check before a rerun when the provider refused a practice task's calls. */
function providerNextStep(last: { status: number; reason: string }, keyVar: string): string {
  if (last.reason === 'upstream_unreachable' || last.status >= 500) return 'This is usually brief: wait a few minutes.';
  if (last.status === 401 || last.status === 403) return `Check that ${keyVar} is the key your agent uses and that it’s still active.`;
  if (last.status === 404) return 'Check the model your agent asks for is one your key can use.';
  if (last.status === 429) return 'Wait a few minutes, or check your account’s rate limits and credit.';
  return 'Check the model name and settings your agent sends.';
}

function asFailedCalls(f: PracticeFailedCalls | undefined) {
  if (!f?.count || typeof f.last?.status !== 'number') return null;
  return { count: f.count, last: { at: '', agentId: '', status: f.last.status, reason: f.last.reason, message: '' } };
}

/** The checks a rerun covers: the failed ones, or the ones that didn't run. Null when there's nothing to rerun. */
export function rerunScope(r: PracticeReport): string[] | null {
  const open = openChecks(r);
  const ids = (r.verdict === 'not_passed' ? open.filter((c) => c.status === 'failed') : open).map((c) => c.id);
  return r.verdict === 'passed' || !ids.length ? null : ids;
}

/** "Rerun 1 check × 3 runs · usually 15–25 model calls (≈ $0.20–$0.35), never more than 40." (§10 fixed copy) */
export function rerunConfirm(scope: string[] | null, runs: number, e: CallEstimate): string {
  const what = scope ? `Rerun ${plural(scope.length, 'check')}` : 'Run the full test';
  if (e.billedBy === 'Azure') return `${what} × ${plural(runs, 'run')} · never more than ${e.cap} model calls${billing(e)}.`;
  return `${what} × ${plural(runs, 'run')} · ${usualCalls(e)}, never more than ${e.cap}${billing(e)}.`;
}

/** Why a test ended without a result (§4 Lifecycle end reasons). */
export function endedBecause(endReason: string | null): string {
  switch (endReason) {
    case 'ended_by_owner': return 'You ended the test from the dashboard.';
    case 'cancelled_by_cli': return 'The test was stopped from your computer.';
    case 'lost_contact': return 'WhiteRoom lost contact with your computer for 5 minutes. It may have gone to sleep or lost its connection.';
    case 'engine_update': return 'WhiteRoom was updated during the test.';
    case 'code_expired': return 'The run code expired before the test started.';
    default: return 'The test stopped before it finished.';
  }
}

/** The agent name the engine gives a sample test on a fleet with no agents yet. */
export const SAMPLE_AGENT = 'readiness-sample';

/** Who ran the test: "support-bot", or "WhiteRoom’s sample agent, as support-bot". */
export function practiceAgent(sample: boolean, agentId: string): string {
  if (!sample) return agentId;
  return agentId === SAMPLE_AGENT ? 'WhiteRoom’s sample agent' : `WhiteRoom’s sample agent, as ${agentId}`;
}

/** The test Start just made, from its reply alone: shown at once so the run code can't be lost to a failed read. */
export function draftFromStart(st: PracticeStart, made: RunCode & { runId: string }, now = new Date()): PracticeRun {
  return {
    id: made.runId, lifecycle: 'draft', verdict: null, endReason: null, sourceFleetId: st.fleet, agentId: st.agent ?? SAMPLE_AGENT,
    sample: st.sample, runs: st.runs, scope: st.scope ?? null, createdAt: now.toISOString(), startedAt: null, endedAt: null,
    codeExpiresAt: made.codeExpiresAt, codeTriesLeft: null, progress: null,
  };
}

/** A run ID as the engine makes them ("r-" and a UUID). */
export const RUN_ID_RE = /^r-[0-9a-f-]{36}$/;

/** The short test ID fix lines name ("contact us with test ID r-7f3a"). */
export const shortId = (id: string) => id.slice(0, 6);

// ── Past tests (§10) ─────────────────────────────────────────────────────

export const isOpen = (l: PracticeRun['lifecycle']) => l === 'draft' || l === 'active' || l === 'finalizing';

/** The Result column: the verdict, or "Rerun · passed (1 check)" for a rerun. */
export function pastResult(row: PracticeRunRow): { label: string; tone: 'brand' | 'warn' | 'muted' } {
  const verdict: PracticeVerdict = row.lifecycle === 'finished' && row.verdict ? row.verdict : 'incomplete';
  const tone = verdict === 'passed' ? 'brand' : verdict === 'not_passed' ? 'warn' : 'muted';
  if (!row.rerun) return { label: VERDICT_LABEL[verdict], tone };
  const n = row.checks ? ` (${plural(row.checks.total, 'check')})` : '';
  const words: Record<PracticeVerdict, string> = { passed: `passed${n}`, not_passed: `didn’t pass${n}`, incomplete: 'didn’t finish' };
  return { label: `Rerun · ${words[verdict]}`, tone };
}

/**
 * The Tasks column: tasks finished of those planned, control checks
 * included ("18/18", "4/6"), as the engine lists them. An older engine
 * doesn't list them: then "18/18" when every task ran and was judged
 * (Passed or Didn't pass), else "—".
 */
export function pastTasks(row: PracticeRunRow): string {
  const t = row.tasks;
  if (t && Number.isFinite(t.finished) && Number.isFinite(t.total) && t.total > 0) return `${Math.min(t.finished, t.total)}/${t.total}`;
  const n = practiceTaskCount(row.runs, row.scope);
  return row.lifecycle === 'finished' && (row.verdict === 'passed' || row.verdict === 'not_passed') ? `${n}/${n}` : '—';
}

export const pastKind = (row: Pick<PracticeRunRow, 'sample'>) => (row.sample ? 'Practice (sample)' : 'Practice');

export const RETENTION = 'WhiteRoom keeps each practice test’s full details for 7 days and its result for 30 days.';

// ── Progress (§4 Practice tasks 6, §10 Polling) ──────────────────────────

/** No heartbeat for this long reads as Lost contact; the engine ends the test after 5 minutes. */
export const LOST_CONTACT_MS = 90_000;

export function lostContact(run: PracticeRun, now: number): boolean {
  return run.lifecycle === 'active' && !!run.progress && now - Date.parse(run.progress.lastContactAt) > LOST_CONTACT_MS;
}

/** "Practice tasks: 4 of 18 done (run 1 of 3) · 12 min so far, usually 20–35 min a run". */
export function progressLine(run: PracticeRun, now: number): string {
  const since = run.startedAt ? Math.max(0, Math.round((now - Date.parse(run.startedAt)) / 60_000)) : 0;
  const usual = run.runs > 1 ? `usually 60–105 min in total` : 'usually 20–35 min in total';
  const p = run.progress;
  if (!p) return `Running · ${since} min so far, ${usual}`;
  const perRun = Math.max(1, Math.round(p.total / run.runs));
  const which = run.runs > 1 ? ` (run ${Math.min(run.runs, Math.floor(p.done / perRun) + 1)} of ${run.runs})` : '';
  return `Practice tasks: ${p.done} of ${p.total} done${which} · ${since} min so far, ${usual}`;
}

/** Each practice task of the test and where it stands, for the running list. */
export function taskList(run: PracticeRun): { name: string; state: 'done' | 'now' | 'todo' }[] {
  const plan = planOf(run.scope);
  const done = run.progress?.done ?? 0;
  return Array.from({ length: run.runs }, (_, k) => plan.map((s) => ({ s, k }))).flat().map(({ s, k }, i) => ({
    name: `${TASK_NAMES[s]}${run.runs > 1 ? ` · run ${k + 1}` : ''}`,
    state: i < done ? 'done' : i === done && run.progress ? 'now' : 'todo',
  }));
}

/** "29:47", counting down to the run code's expiry; null once it has expired. */
export function codeCountdown(expiresAt: string | null, now: number): string | null {
  const s = expiresAt ? Math.floor((Date.parse(expiresAt) - now) / 1000) : 0;
  if (!(s > 0)) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
