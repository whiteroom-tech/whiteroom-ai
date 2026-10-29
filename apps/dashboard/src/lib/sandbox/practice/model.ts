// Practice tests in the dashboard (sandbox readiness spec rev 5.6, §5, §6, §8,
// §10): the decisions and copy the screens render, kept pure so they can be
// tested without a browser. Check, task, status and provider words come from
// the engine's catalog (packages/cli/contract, the copy the CLI ships too);
// nothing here invents a check.

import CATALOG from '@practice-contract/catalog.json';
import { failedCallReason } from '@/lib/sandbox/failed-calls';
import { counted, fmtDay } from '@/lib/format';
import type {
  PracticeCheck, PracticeControlCheck, PracticeFailedCalls, PracticeKeyRefusal, PracticeProviderKey, PracticeReport, PracticeRun, PracticeRunRow, PracticeSource,
  PracticeStart, PracticeVerdict, RunCode,
} from './types';

export { CATALOG };
/** The BFF's reason when practice tests aren't on for this engine: a calm page, not an error, and never retried. */
export const PRACTICE_UNAVAILABLE = 'practice_unavailable';
export const DISCLAIMER = CATALOG.disclaimer;

/** A provider a practice test's calls can go to (the catalog's `providers`). */
export type PracticeProvider = keyof typeof CATALOG.providers;
export const isPracticeProvider = (v: unknown): v is PracticeProvider => typeof v === 'string' && Object.hasOwn(CATALOG.providers, v);
const label = (p: PracticeProvider) => CATALOG.providers[p].label;

// ── The plan: which practice tasks a test plays ──────────────────────────

export type Scenario = Exclude<keyof typeof CATALOG.taskNames, 'controls'>;
/** What the running screen calls each practice task, in the engine's order. */
export const TASK_NAMES = CATALOG.taskNames;

/** The practice tasks one full run plays, the control checks apart (B's short and long versions are two). */
export const PRACTICE_TASKS = Object.keys(TASK_NAMES).length - 1;

/** "5–10 min", "15–30 min": how long `runs` runs usually take, from the catalog. */
export function usualMinutes(runs: number): string {
  const [lo, hi] = CATALOG.minutesPerRun;
  return `${lo * runs}–${hi * runs} min`;
}

/**
 * What a pre-flight is, the one line every way into it uses: "7 checks, 3 for
 * your agent and 4 for its guardrails · about 5–10 min for one run". The model
 * calls are said once, by setup's cost line, worked out from the plan.
 */
const AGENT_ROWS = CATALOG.rows.filter((r) => r.group === CATALOG.rows[0].group).length;
export const PRACTICE_SUMMARY = `${CATALOG.rows.length} checks, ${AGENT_ROWS} for your agent and ${CATALOG.rows.length - AGENT_ROWS} for its guardrails · about ${usualMinutes(1)} for one run`;

/** Where the CLI's README explains the adapter that connects your own agent. */
export const ADAPTER_HELP_URL = 'https://www.npmjs.com/package/@whiteroom-ai/cli#connecting-your-own-agent';
/** The one line that says what the adapter is, beside its link. */
export const ADAPTER_EXPLAINER = 'A short script that passes each practice task to your agent. We give you a starter.';

/** One run's practice tasks, as the engine plans them: all of them, or those a rerun's checks are judged on. */
export function planOf(scope: string[] | null): (Scenario | 'controls')[] {
  return (Object.keys(TASK_NAMES) as (Scenario | 'controls')[]).filter((s) => !scope
    || (s === 'controls' ? scope.some((id) => id.startsWith('ctl')) : CATALOG.checks.some((c) => c.task === s && scope.includes(c.id))));
}

// ── The CLI ──────────────────────────────────────────────────────────────

/** The exact CLI release the dashboard names (D12). Bumped with the CLI at publish. */
export const CLI_VERSION = '2.0.0';
/** The CLI is on npm (D2): commands run it with npx at CLI_VERSION. False only for a packed beta build. */
export const CLI_ON_NPM = true;
export const BETA_TGZ = `whiteroom-ai-cli-${CLI_VERSION}.tgz`;
const CLI = CLI_ON_NPM ? `npx @whiteroom-ai/cli@${CLI_VERSION}` : 'whiteroom';

export type StarterLang = 'js' | 'python';
const STARTER_FILE: Record<StarterLang, string> = { js: 'wr-adapter.mjs', python: 'wr_adapter.py' };
const STARTER_RUN: Record<StarterLang, string> = { js: 'node wr-adapter.mjs', python: 'python3 wr_adapter.py' };

/** The beta's install lines: check the file, then install it. Empty once the CLI is on npm. */
export const BETA_INSTALL = CLI_ON_NPM ? [] : [`shasum -a 256 ${BETA_TGZ}`, `npm install -g ./${BETA_TGZ}`];

/**
 * The commands the terminal steps show. The run code is never part of one
 * (§10 CLI): the CLI asks for it. With the run's provider known, `--key-env`
 * names its key's variable, so a computer with several keys set isn't refused.
 */
export function cliCommands(sample: boolean, lang: StarterLang, provider: PracticeProvider | null = null): { starter: string | null; run: string } {
  const keyEnv = provider ? ` --key-env ${CATALOG.providers[provider].keyVar}` : '';
  return {
    starter: sample ? null : `${CLI} practice adapter --lang ${lang} > ${STARTER_FILE[lang]}`,
    run: sample ? `${CLI} practice run${keyEnv}` : `${CLI} practice run --adapter "${STARTER_RUN[lang]}"${keyEnv}`,
  };
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

/** The key a test runs on, when its provider is known: a Fleet key provider key (R7), or the fleet's own key. What the key line, command and cost say. */
export interface PracticeKeyChoice {
  provider: PracticeProvider;
  keyHint: string | null;
  fleetKey: boolean;
}

/** The key a test runs on, from the engine's own fields (any tab): known for a Fleet key key from Start, for the fleet's own key once claimed. */
export function runKeyChoice(run: Pick<PracticeRun, 'provider' | 'keyHint' | 'proxyKeyDisplayPrefix'>): PracticeKeyChoice | null {
  return isPracticeProvider(run.provider) ? { provider: run.provider, keyHint: run.keyHint ?? null, fleetKey: !!run.proxyKeyDisplayPrefix } : null;
}

/** The fleet's own key's provider, as source-model saw the agent's latest call go to it. */
export function directChoice(src: PracticeSource | undefined): PracticeKeyChoice | null {
  const provider = src?.provider === 'direct-anthropic' ? 'anthropic' : src?.provider === 'direct-openai' ? 'openai' : null;
  return provider && { provider, keyHint: null, fleetKey: false };
}

/** Cloud providers have no default model: setup asks for it, and Start needs it. */
export const CLOUD_MODEL_FIELD: Partial<Record<PracticeProvider, { label: string; hint: string; placeholder: string; missing: string }>> = {
  'azure-openai': { label: 'Azure deployment name', hint: '· the deployment your agent calls', placeholder: 'my-gpt-4o-mini', missing: 'Enter the deployment name to start.' },
  'bedrock-mantle': { label: 'Bedrock model ID', hint: '· like anthropic.claude-haiku-4-5', placeholder: 'anthropic.claude-haiku-4-5', missing: 'Enter the Bedrock model ID to start.' },
  foundry: { label: 'Foundry model', hint: '· your Claude deployment’s name, like claude-haiku-4-5', placeholder: 'claude-haiku-4-5', missing: 'Enter the Foundry model to start.' },
};

/** Fleet key's names for every provider a key can have, the ones practice tests can't use included. */
const KEY_PROVIDER_LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(CATALOG.providers).map(([id, p]) => [id, p.label])), azure: 'Azure OpenAI', 'bedrock-sigv4': 'AWS Bedrock', 'foundry-entra': 'Claude on Azure (Foundry)',
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
  isPracticeProvider(k.provider) ? { provider: k.provider, keyHint: hintOf(k), fleetKey: true } : null;

/**
 * What setup can test with, from source-model: the eligible Fleet key keys,
 * and whether the fleet's own key is a choice too (it is when it can start
 * a test; with Fleet key keys too, only when the agent's calls use it). The
 * default is the key the agent's latest call came with: the Fleet key key it
 * used, else the fleet's own key when it calls with that, else the first
 * eligible key.
 */
export function keyOptions(src: PracticeSource): { keys: PracticeProviderKey[]; direct: boolean; initial: string | null } {
  const keys = src.providerKeys.filter((k) => k.eligible && isPracticeProvider(k.provider));
  const used = keys.find((k) => k.displayPrefix === src.usedProxyKeyDisplayPrefix);
  const agentDirect = !src.usedProxyKeyDisplayPrefix && (src.provider === 'direct-anthropic' || src.provider === 'direct-openai');
  const direct = src.directKey && (keys.length === 0 || agentDirect);
  return { keys, direct, initial: used?.displayPrefix ?? (direct && (agentDirect || !keys.length) ? null : keys[0]?.displayPrefix ?? null) };
}

/**
 * Why a practice test can't start here (§7: the old "Test my agent" stays for
 * these): an IAM-role fleet; a fleet with its own host, or a cloud agent, with
 * no Fleet key key to test with. The sample agent calls with the fleet's own
 * key, so a cloud agent's fleet can still run it.
 */
export function practiceBlock(src: PracticeSource, o: { sample: boolean; hasKey: boolean }): 'role' | 'host' | 'cloud' | null {
  if (src.blocked === 'bedrock_role') return 'role';
  if (src.provider === 'proxy-url' && !o.hasKey) return 'host';
  if (src.provider === 'cloud' && !o.sample && !o.hasKey) return 'cloud';
  return null;
}

/** /sandbox: fleets the practice test refuses keep the connection test; every other fleet goes to the pre-flight. */
export const keepsConnectionTest = (src: PracticeSource) => practiceBlock(src, { sample: false, hasKey: keyOptions(src).keys.length > 0 }) !== null;

/** The agent setup starts on (§7 step 1): the most recently active, else the first by name. */
export function defaultAgent(agents: readonly string[], lastActiveAt: Record<string, string | null> = {}): string {
  const at = (a: string) => { const t = Date.parse(lastActiveAt[a] ?? ''); return Number.isNaN(t) ? -Infinity : t; };
  return agents.reduce<string | null>((best, a) => (best === null || at(a) > at(best) ? a : best), null) ?? '';
}

/** The key line: which variable to set, to which key (§10 fixed copy; R7 names the Fleet key key). Both direct variables while the provider isn't known. */
export function keyLine(choice: PracticeKeyChoice | null, fleet: string): { before: string; keyVar: string; after: string } {
  const own = ` to the key your agent uses with ${fleet}.`;
  if (!choice) return { before: 'Set ', keyVar: `${CATALOG.providers.anthropic.keyVar} or ${CATALOG.providers.openai.keyVar}`, after: own };
  const keyVar = CATALOG.providers[choice.provider].keyVar;
  if (!choice.fleetKey) return { before: 'Set ', keyVar, after: own };
  const hint = choice.keyHint ? ` (key ending ${choice.keyHint})` : '';
  return { before: 'Run this where ', keyVar, after: ` is set to the same ${label(choice.provider)} key you added on Fleet key${hint}.` };
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
const BILLED_BY: Partial<Record<PracticeProvider, 'Azure' | 'AWS'>> = { 'azure-openai': 'Azure', foundry: 'Azure', 'bedrock-mantle': 'AWS' };

/**
 * What a test usually costs and its hard cap, for `runs` runs of `scope`
 * (null: everything) plus `controlCalls` extra calls for the control checks.
 */
export function callEstimate(o: { runs: number; scope: string[] | null; controlCalls: number; model: string | null | undefined; provider?: PracticeProvider | null }): CallEstimate {
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
  if (e.billedBy === 'Azure') return `Never more than ${cap}${billing(e)}. That includes control checks.`;
  return `On the key you test with: ${usualCalls(e)}. Never more than ${cap}${billing(e)}, including control checks.`;
}

/** The results' billing line, for the key the test used and its runs: "… never more than 120 a run (360 in all)." */
export function billedLine(r: Pick<PracticeReport, 'runs' | 'tested'>): string {
  const key = r.tested.proxyKeyDisplayPrefix ? ` (from Fleet key${r.tested.keyHint ? `, ending ${r.tested.keyHint}` : ''})` : '';
  const cap = r.runs > 1 ? `${CATALOG.runCallCap} a run (${CATALOG.runCallCap * r.runs} in all)` : `${CATALOG.runCallCap}`;
  return `Model calls were billed to the key you tested with${key}, never more than ${cap}.`;
}

// ── The seven rows (pre-flight D1): the checks in two groups ─────────────

/** One of the seven pre-flight rows, from the engine's catalog: its members are check-id prefixes. */
export type PreflightRow = (typeof CATALOG.rows)[number];
export const ROWS: readonly PreflightRow[] = CATALOG.rows;
/** "The agent", "The guardrails", in the catalog's order. */
export const ROW_GROUPS = [...new Set(ROWS.map((r) => r.group))];
export type RowStatus = keyof typeof CATALOG.rowStatusLabels;
export const ROW_STATUS_LABEL: Record<RowStatus, string> = CATALOG.rowStatusLabels;

/** A member prefix ending in "." takes every check under it ("a."); else the id itself or its rules ("ctl.spend_cap" → "ctl.spend_cap.gr_1"). */
const isMember = (id: string, prefix: string) => (prefix.endsWith('.') ? id.startsWith(prefix) : id === prefix || id.startsWith(`${prefix}.`));
export const membersOf = <T extends { id: string }>(row: PreflightRow, checks: readonly T[]): T[] => checks.filter((c) => row.members.some((m) => isMember(c.id, m)));
/** The row a check belongs to. */
export const rowOf = (checkId: string) => ROWS.find((r) => r.members.some((m) => isMember(checkId, m)));
const isGuardrail = (row: PreflightRow) => row.members.every((m) => m.startsWith('ctl.'));
const PAUSE_STOP = 'pause_stop';

/** The rule behind a control check, as the engine says (structured, never read from the label): off, not covering the agent, or set up. */
type Setup = Pick<PracticeControlCheck, 'setup' | 'notCoveredAgent'>;
const setUp = (c: Setup) => (c.setup ?? 'ok') === 'ok' && !c.notCoveredAgent;
/** Why none of a row's rules apply: "Not set up for support-bot." or "Off in Controls." */
function notSetUpReason(members: readonly Setup[]): string {
  const agent = members.find((c) => c.notCoveredAgent)?.notCoveredAgent;
  return agent ? `Not set up for ${agent}.` : 'Off in Controls.';
}
/** "Enforce: blocked", "Watch: would have blocked" (D3), or both when the row's rules differ. */
function modeReason(modes: readonly (string | null | undefined)[]): string {
  const said = [];
  if (modes.includes(CATALOG.controls.modes.enforce)) said.push('Enforce: blocked');
  if (modes.includes(CATALOG.controls.modes.watch)) said.push('Watch: would have blocked');
  return said.join('. ');
}
/** An engine note without its own "Not checked: ", since the row already says so. */
const plainNote = (note: string) => {
  const t = note.startsWith('Not checked: ') ? note.slice('Not checked: '.length) : note;
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const SKIP_LIST: Record<string, string> = { model_allowlist: 'models', tool_list: 'tools', keyword: 'keywords' };
/**
 * Why a rule wasn't checked, from the engine's short note, said plainly with
 * what to do: the limits are the catalog's. Notes it doesn't know stay as they are.
 */
export function plainSkip(note: string, checkId: string): string {
  const t = plainNote(note);
  const type = checkId.split('.')[1] ?? '';
  const { limits, agentsMax } = CATALOG.controls;
  if (/^Checks use at most \d+ agents/i.test(t)) return `One test uses up to ${agentsMax} test agents, and earlier rules used them all.`;
  if (/^Too many calls to test cheaply/i.test(t)) {
    const limit = (limits as Record<string, number>)[type];
    return limit ? `It acts after more than ${limit} calls, too many to test cheaply. Rules that act within ${limit} are tested.` : 'Testing it would take too many calls.';
  }
  if (/^No (models|tools|keywords) are on the list yet/i.test(t)) return `Its list is empty, so it doesn’t block anything yet. Add ${SKIP_LIST[type] ?? 'items'} in Controls.`;
  if (/^The sample agent only checks rules for all agents/i.test(t)) return 'WhiteRoom’s sample agent only tests rules for all agents. Test your own agent to check this one.';
  return t;
}

/** A rule's line in a result: "Not checked · <why>" for a skipped one, else its status and what happened. */
export function memberLine(c: PracticeCheck): string {
  if (c.status === 'unsupported') return c.summary.startsWith('Not checked: ') ? `${STATUS_LABEL.unsupported} · ${plainSkip(c.summary, c.id)}` : c.summary;
  return `${STATUS_LABEL[c.status]}${c.summary ? ` · ${c.summary}` : ''}`;
}

/** A row as a result shows it: one of four statuses, one plain reason, and the checks it was judged on. */
export interface RowResult {
  row: PreflightRow;
  status: RowStatus;
  reason: string;
  /** Not set up: the way to add the rule is Controls. */
  addInControls: boolean;
  members: PracticeCheck[];
  /** Not checked, but some of its rules passed: shown as "Partly checked". */
  partial: boolean;
  /** What its members are: a guardrail's are rules, the agent's and Pause/Stop's are tests (a row is a check). */
  noun: 'rule' | 'test';
}

/**
 * The seven rows of a report (D1, §3b), from structured fields only: a row is
 * Didn't pass if any of its checks failed; Passed when every check of a rule
 * set up for the agent passed (Watch passes when it would have acted, D3);
 * Not set up when it has no rule, or its rules are Off or don't cover the
 * agent (D2: never a failure); else Not checked, with the first open check's
 * reason.
 */
export function groupRows(r: Pick<PracticeReport, 'checks' | 'scope'>): RowResult[] {
  return ROWS.map((row) => {
    const members = membersOf(row, r.checks);
    const noun = isGuardrail(row) && row.id !== PAUSE_STOP ? 'rule' : 'test';
    const out = (status: RowStatus, reason: string, addInControls = false, partial = false): RowResult => ({ row, status, reason, addInControls, members, partial, noun });
    if (!members.length) {
      if (r.scope) return out('not_checked', 'Not part of this rerun.');
      if (row.id === PAUSE_STOP) return out('not_checked', 'Pause and Stop aren’t on for this fleet.');
      return isGuardrail(row) ? out('not_set_up', 'No rule yet.', true) : out('not_checked', 'Didn’t run.');
    }
    const failed = members.find((c) => c.status === 'failed');
    if (failed) return out('failed', isGuardrail(row) ? failed.summary : `${failed.label}: ${failed.summary}`);
    const live = members.filter(setUp);
    if (!live.length) return out('not_set_up', notSetUpReason(members), true);
    if (live.every((c) => c.status === 'passed')) {
      if (!isGuardrail(row)) return out('passed', live[0].summary);
      if (row.id === PAUSE_STOP) return out('passed', 'Paused and stopped. Only a person could resume it.');
      const tested = row.id === 'spend_cap' ? ' Tested with a tiny limit.' : row.id === 'keyword' && live.some((c) => c.id.startsWith('ctl.keyword')) ? ' Keywords tested with a test word.' : '';
      const mode = modeReason(live.map((c) => c.mode));
      return out('passed', `${mode ? `${mode}.` : 'Your rules worked.'}${tested}`);
    }
    // Some rules passed and some weren't checked: say how many, each rule says why below.
    // Only when the rest couldn't be checked: a test problem keeps its own reason and "(not your agent)".
    const passed = live.filter((c) => c.status === 'passed').length;
    if (noun === 'rule' && passed && live.every((c) => c.status === 'passed' || c.status === 'unsupported')) return out('not_checked', `${passed} of ${counted(live.length, 'rule')} passed · ${live.length - passed} not checked`, false, true);
    const open = live.find((c) => c.status !== 'passed')!;
    const why = open.status === 'unsupported' ? plainSkip(open.summary, open.id) : open.summary || STATUS_LABEL[open.status];
    return out('not_checked', `${why}${open.testProblem ? ' (not your agent)' : ''}`);
  });
}

/** What setup says a row will do, before anything runs (§7 step 2): checked, or Not set up / Not checked with why. */
export interface RowPlan {
  row: PreflightRow;
  status: 'will_check' | 'not_set_up' | 'not_checked';
  reason: string;
  addInControls: boolean;
  /** The checks or rules the row covers, by name. */
  members: string[];
}
export const WILL_CHECK = 'Will be checked';

/**
 * The seven rows as setup previews them: the agent rows from the catalog's
 * checks, the guardrails from the engine's planned control checks (null: they
 * couldn't be read). Empty keyword rules aren't planned by the engine.
 */
export function planRows(controls: PracticeControlCheck[] | null): RowPlan[] {
  return ROWS.map((row) => {
    const out = (status: RowPlan['status'], reason: string, members: string[], addInControls = false): RowPlan => ({ row, status, reason, addInControls, members });
    if (!isGuardrail(row)) {
      const checks = membersOf(row, CATALOG.checks);
      return out('will_check', counted(checks.length, 'check'), checks.map((c) => c.label));
    }
    if (!controls) return out('not_checked', 'Couldn’t read this fleet’s controls just now.', []);
    const members = membersOf(row, controls);
    const names = members.map((c) => (c.mode ? `${c.label} · ${c.mode}` : c.label));
    if (!members.length) return row.id === PAUSE_STOP ? out('not_checked', 'Pause and Stop aren’t on for this fleet.', []) : out('not_set_up', 'No rule yet.', [], true);
    const live = members.filter(setUp);
    if (!live.length) return out('not_set_up', notSetUpReason(members), names, true);
    const checked = live.filter((c) => c.checked);
    if (!checked.length) return out('not_checked', plainNote(live.find((c) => c.note)?.note ?? 'Not checked.'), names);
    const modes = [...new Set(checked.map((c) => c.mode).filter(Boolean))].join(' and ');
    const calls = checked.reduce((n, c) => n + (c.calls ?? 0), 0);
    // Only the rules a test can check are promised: "3 of 7 rules" when the rest can't be.
    const rules = checked.length < live.length ? `${checked.length} of ${counted(live.length, 'rule')}` : members.length > 1 && counted(members.length, 'rule');
    return out('will_check', [rules, modes, calls ? counted(calls, 'extra call') : 'no extra calls'].filter(Boolean).join(' · '), names);
  });
}

/** The pre-flight's five steps (§7 Phase 2). */
export const PREFLIGHT_STEPS = [
  { title: 'Pick agent', sub: 'The one active most recently' },
  { title: 'What we’ll test', sub: `${ROWS.length} checks in ${ROW_GROUPS.length} groups` },
  { title: 'Run', sub: 'One command on your computer' },
  { title: 'Live', sub: 'The checks fill in' },
  { title: 'Report', sub: 'Every result, to download' },
] as const;

/** Which step a screen is on: setup covers 1 and 2, a test waiting for the CLI is 3, a running one 4, a result 5. */
export function preflightStep(view: 'setup' | 'run' | 'results', run: Pick<PracticeRun, 'lifecycle'> | null): number {
  if (view === 'setup') return 0;
  if (view === 'results') return 4;
  return run?.lifecycle === 'draft' ? 2 : 3;
}

/** The control checks' extra calls on the agent's key, only the rows a rerun covers when it names some. */
export function controlCalls(checks: PracticeControlCheck[], scope: string[] | null = null): number {
  return checks.filter((c) => !scope || scope.includes('ctl') || scope.includes(c.id)).reduce((n, c) => n + (c.calls ?? 0), 0);
}

// ── Results (§8) ─────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<PracticeCheck['status'], string> = CATALOG.statusLabels;
export const VERDICT_LABEL: Record<PracticeVerdict, string> = CATALOG.verdictLabels;

const required = (r: PracticeReport) => r.checks.filter((c) => c.required);
/** Required checks that didn't pass. */
export const openChecks = (r: PracticeReport) => required(r).filter((c) => c.status !== 'passed');

/** The rows these failed checks belong to, by name and in row order: "Spend cap, Fails gracefully"; empty when none is a row's. */
export function failedRowNames(failed: readonly string[]): string {
  return ROWS.filter((row) => failed.some((id) => rowOf(id) === row)).map((row) => row.name).join(', ');
}

/**
 * The rows a passed test didn't fully check (partly or not at all), of those
 * set up: a pass only claims the rows that passed (a rule not set up isn't a gap).
 */
export function notFullyChecked(r: PracticeReport): { names: string[]; of: number } {
  const rows = groupRows(r).filter((x) => x.status !== 'not_set_up');
  return { names: rows.filter((x) => x.status === 'not_checked').map((x) => x.row.name), of: rows.length };
}

/** "Passed · all 7 checks · 3 runs", "Passed · 4 of 7 fully checked · 1 run", "Didn't pass · Spend cap", "Didn't finish · 2 checks couldn't run (not your agent)". */
export function headline(r: PracticeReport): string {
  const runs = counted(r.runs, 'run');
  if (r.verdict === 'passed') {
    const scope = r.scope && [...new Set(required(r).map((c) => c.scenario))].join(', ');
    if (scope) return `${VERDICT_LABEL.passed} · ${scope} only · ${runs}`;
    const gaps = notFullyChecked(r);
    return `${VERDICT_LABEL.passed} · ${gaps.names.length ? `${gaps.of - gaps.names.length} of ${gaps.of} fully checked` : `all ${counted(gaps.of, 'check')}`} · ${runs}`;
  }
  if (r.verdict === 'not_passed') return `${VERDICT_LABEL.not_passed} · ${failedRowNames(r.checks.filter((c) => c.status === 'failed').map((c) => c.id)) || `${counted(required(r).filter((c) => c.status === 'failed').length, 'check')} failed`}`;
  const open = openChecks(r);
  const ours = open.length > 0 && open.every((c) => c.testProblem);
  return `${VERDICT_LABEL.incomplete} · ${open.length ? `${counted(open.length, 'check')} couldn't run` : 'no checks could run'}${ours ? ' (not your agent)' : ''}`;
}

/** What a passed result doesn't prove (Appendix D), or null. */
export function passCaveat(r: PracticeReport): string | null {
  if (r.verdict !== 'passed') return null;
  const gaps = r.scope ? [] : notFullyChecked(r).names;
  const notAll = gaps.length ? `Not fully checked: ${gaps.join(', ')}. Each one below says why. ` : '';
  if (r.sample) return `${notAll}This was WhiteRoom’s sample agent: it checks your rules and this setup, not your own agent.`;
  if (r.runs === 1) return `${notAll}One run shows your agent can pass. Run it 3 times to see that it passes every time.`;
  return notAll.trim() || null;
}

/**
 * A check's fix line. A provider refusal names what the provider said and
 * what to check (§10 fixed copy, from what WhiteRoom saw and where the calls
 * went); others are the catalog's line as the engine filled it in.
 */
export function fixLine(c: PracticeCheck, r: PracticeReport): string | null {
  const f = c.reason === 'provider_refused' ? asFailedCalls(c.failedCalls) : null;
  const provider = r.tested.provider;
  if (!f || !isPracticeProvider(provider)) return c.fix;
  return `Test problem (not your agent): ${failedCallReason(f, provider)}. ${providerNextStep(f.last, CATALOG.providers[provider].keyVar)} Rerun this check to try again.`;
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

/**
 * The Fleet key key a rerun uses: the one the test used, if it's still on
 * Fleet key and usable; else the only usable key of the same provider. `pick`
 * when there are several to choose from, `gone` when none is left; null for
 * a test on the fleet's own key.
 */
export function rerunKey(tested: Pick<PracticeReport['tested'], 'provider' | 'proxyKeyDisplayPrefix'>, keys: PracticeProviderKey[]): PracticeProviderKey | 'pick' | 'gone' | null {
  if (!tested.proxyKeyDisplayPrefix) return null;
  const usable = keys.filter((k) => k.eligible && k.provider === tested.provider);
  return usable.find((k) => k.displayPrefix === tested.proxyKeyDisplayPrefix) ?? (usable.length === 1 ? usable[0] : usable.length ? 'pick' : 'gone');
}

/** "Rerun 1 check × 3 runs · usually 15–25 model calls (≈ $0.20–$0.35), never more than 40." (§10 fixed copy) */
export function rerunConfirm(scope: string[] | null, runs: number, e: CallEstimate): string {
  const what = scope ? `Rerun ${counted(scope.length, 'check')}` : 'Run the full test';
  if (e.billedBy === 'Azure') return `${what} × ${counted(runs, 'run')} · never more than ${e.cap} model calls${billing(e)}.`;
  return `${what} × ${counted(runs, 'run')} · ${usualCalls(e)}, never more than ${e.cap}${billing(e)}.`;
}

/** Why a test ended early, with no result or a partial one (§4 Lifecycle end reasons). */
export function endedBecause(endReason: string | null): string {
  switch (endReason) {
    case 'ended_by_owner': return 'You ended the test from the dashboard.';
    case 'cancelled_by_cli': return 'The test was stopped from your computer.';
    case 'lost_contact': return 'WhiteRoom lost contact with your computer for 5 minutes. It may have gone to sleep or lost its connection.';
    case 'engine_update': return 'WhiteRoom was updated during the test.';
    case 'code_expired': return 'The run code expired before the test started.';
    case 'call_cap': return 'Stopped at this test’s model-call limit after WhiteRoom had to rerun a task (not your agent).';
    case 'no_model_calls': return 'Stopped: your agent didn’t make any model calls through WhiteRoom in 2 practice tasks in a row. Check your adapter sends its calls to the base URL the CLI gives it.';
    case 'adapter_crashed': return 'Your adapter stopped with an error, so the test ended early. The practice tasks it finished are in the results.';
    case 'engine_error': return 'WhiteRoom couldn’t finish working out the result (not your agent). Start a new test.';
    case 'stalled': return 'The test stopped moving: your computer stayed in touch but didn’t ask for the next practice task for 5 minutes.';
    case 'too_many_restarts': return 'Practice tasks had to start again too many times, so the test stopped.';
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
    codeExpiresAt: made.codeExpiresAt, codeTriesLeft: null, progress: null, provider: null, proxyKeyDisplayPrefix: st.proxyKeyDisplayPrefix ?? null, keyHint: null,
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
  // The failing rows, by name (engine `failed`: the required checks that failed).
  const names = verdict === 'not_passed' && row.failed?.length ? failedRowNames(row.failed) : '';
  if (!row.rerun) return { label: names ? `${VERDICT_LABEL[verdict]} · ${names}` : VERDICT_LABEL[verdict], tone };
  const n = row.checks ? ` (${counted(row.checks.total, 'check')})` : '';
  const words: Record<PracticeVerdict, string> = { passed: `passed${n}`, not_passed: names ? `didn’t pass · ${names}` : `didn’t pass${n}`, incomplete: 'didn’t finish' };
  return { label: `Rerun · ${words[verdict]}`, tone };
}

/** The Tasks column: tasks finished of those planned, control checks included ("18/18", "4/6"), as the engine lists them. */
export function pastTasks(row: PracticeRunRow): string {
  const { finished, total } = row.tasks;
  return total > 0 ? `${Math.min(finished, total)}/${total}` : '—';
}

export const pastKind = (row: Pick<PracticeRunRow, 'sample'>) => (row.sample ? 'Practice (sample)' : 'Practice');

export const RETENTION = 'WhiteRoom keeps each practice test’s full details for 7 days and its result for 30 days.';

// ── Progress (§4 Practice tasks 6, §10 Polling) ──────────────────────────

/** No heartbeat for this long reads as Lost contact; the engine ends the test after 5 minutes. */
export const LOST_CONTACT_MS = 90_000;

export function lostContact(run: PracticeRun, now: number): boolean {
  return run.lifecycle === 'active' && !!run.progress && now - Date.parse(run.progress.lastContactAt) > LOST_CONTACT_MS;
}

/** "Practice tasks: 4 of 18 done (run 1 of 3) · 12 min so far, usually 15–30 min in total". */
export function progressLine(run: PracticeRun, now: number): string {
  const since = run.startedAt ? Math.max(0, Math.round((now - Date.parse(run.startedAt)) / 60_000)) : 0;
  const usual = `usually ${usualMinutes(run.runs)} in total`;
  const p = run.progress;
  if (!p) return `Running · ${since} min so far, ${usual}`;
  const perRun = Math.max(1, Math.round(p.total / run.runs));
  const which = run.runs > 1 ? ` (run ${Math.min(run.runs, Math.floor(p.done / perRun) + 1)} of ${run.runs})` : '';
  return `Practice tasks: ${p.done} of ${p.total} done${which} · ${since} min so far, ${usual}`;
}

/** The practice tasks a row's checks are judged on: its agent checks' tasks, or the control step. */
function rowTasks(row: PreflightRow): (Scenario | 'controls')[] {
  if (isGuardrail(row)) return ['controls'];
  return [...new Set(membersOf(row, CATALOG.checks).map((c) => c.task as Scenario))];
}

/**
 * The seven rows while a test runs (§7 step 4, §9): each row's progress from
 * the tasks done so far (`skip`: not part of this rerun). Pass or fail comes
 * with the report, not before.
 */
export function liveRows(run: Pick<PracticeRun, 'runs' | 'scope' | 'progress'>): { row: PreflightRow; state: 'done' | 'now' | 'todo' | 'skip' }[] {
  const plan = planOf(run.scope);
  const order = Array.from({ length: run.runs }, () => plan).flat();
  const done = run.progress?.done ?? 0;
  return ROWS.map((row) => {
    const tasks = rowTasks(row);
    const at = order.flatMap((s, i) => (tasks.includes(s) ? [i] : []));
    if (!at.length) return { row, state: 'skip' as const };
    const state = at.every((i) => i < done) ? 'done' as const : run.progress && at.some((i) => i <= done) ? 'now' as const : 'todo' as const;
    return { row, state };
  });
}

/** "29:47", counting down to the run code's expiry; null once it has expired. */
export function codeCountdown(expiresAt: string | null, now: number): string | null {
  const s = expiresAt ? Math.floor((Date.parse(expiresAt) - now) / 1000) : 0;
  if (!(s > 0)) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
