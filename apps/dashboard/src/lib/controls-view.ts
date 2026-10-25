// What the Controls page shows for each rule, in plain words, and the edit
// model behind its Save button (Controls spec Rev 1, D1). Pure: no React, no
// fetching, so every sentence and decision here is tested on its own.

import type {
  CallRateParams, GovernanceMode, GovernanceParams, GovernanceResponse, GovernanceRule, GovernanceRuleType,
  GovernanceScope, LoopBreakerParams, ModelAllowlistParams, RuleActionCounts, SpendCapParams, ToolListParams,
} from '@/lib/whiteroom/types';
import { convertSpendCap, RULE_LABELS } from '@/lib/governance';

// ── Sentences ───────────────────────────────────────────────────────

const VERB: Record<GovernanceResponse, string> = { notify: 'tell me', block: 'block the call', pause: 'pause the agent', stop: 'stop the agent' };

const fmt = (n: number) => n.toLocaleString('en-US');
export const money = (p: SpendCapParams) => (p.unit === 'dollars' ? `$${fmt(p.dailyCap)}` : `${fmt(p.dailyCap)} tokens`);

/** The rule as one sentence, split so the values can be set in mono. */
export function ruleSentence(rule: Pick<GovernanceRule, 'ruleType' | 'params' | 'response' | 'alsoNotify'>): { pre: string; val: string; post: string } {
  const response = rule.response ?? 'block';
  const v = response === 'block' && rule.alsoNotify ? 'block the call and tell me' : VERB[response];
  if (rule.ruleType === 'spend_cap') {
    const p = rule.params as SpendCapParams;
    return { pre: 'When an agent spends more than ', val: money(p), post: ` in a ${p.scope}, ${v}.` };
  }
  if (rule.ruleType === 'loop_breaker') {
    const p = rule.params as LoopBreakerParams;
    return { pre: 'When an agent makes the same call ', val: fmt(p.threshold), post: ` times in a ${p.scope}, ${v}.` };
  }
  if (rule.ruleType === 'call_rate') {
    return { pre: 'When an agent makes more than ', val: fmt((rule.params as CallRateParams).maxCalls), post: ` calls in a minute, ${v}.` };
  }
  if (rule.ruleType === 'tool_list') {
    const tools = (rule.params as ToolListParams).blockedTools;
    return tools.length ? { pre: 'When an agent is about to run ', val: tools.join(', '), post: `, ${v}.` } : { pre: 'No tools picked yet.', val: '', post: '' };
  }
  const models = (rule.params as ModelAllowlistParams).allowedModels;
  return models.length ? { pre: 'Only allow ', val: models.join(', '), post: `. For any other model, ${v}.` } : { pre: 'No models picked yet.', val: '', post: '' };
}

export const sentenceText = (rule: Parameters<typeof ruleSentence>[0]) => { const s = ruleSentence(rule); return s.pre + s.val + s.post; };

/** Who a change covers, said in a confirm dialog. */
export function appliesNow(scope: GovernanceScope): string {
  return `It applies to ${scope === 'all' ? 'every agent in this fleet' : scope.join(', ')}, and takes effect now.`;
}

/** "All agents", or "Only " + the agents (more than two: "3 agents"). */
export function scopeLabel(scope: GovernanceScope): { lead: string; agents: string } {
  if (scope === 'all') return { lead: 'All agents', agents: '' };
  if (scope.length === 0) return { lead: 'No agents selected', agents: '' };
  return { lead: 'Only ', agents: scope.length > 2 ? `${scope.length} agents` : scope.join(', ') };
}

// ── Grouping and the agent filter ───────────────────────────────────

/** The rules that govern an agent: the fleet-wide ones and its own. `null`: every rule. */
export function rulesFor(rules: readonly GovernanceRule[], agent: string | null): GovernanceRule[] {
  return agent === null ? [...rules] : rules.filter((r) => r.appliesTo === 'all' || r.appliesTo.includes(agent));
}

export function byMode(rules: readonly GovernanceRule[], mode: GovernanceMode): GovernanceRule[] {
  return rules.filter((r) => r.mode === mode);
}

/** Rule names for a stat card's sub-line, each once: "Spend cap, Loop breaker". */
export function ruleNames(rules: readonly GovernanceRule[]): string {
  const names = [...new Set(rules.map((r) => RULE_LABELS[r.ruleType]))];
  return names.length ? names.join(', ') : '—';
}

// ── Overlap ─────────────────────────────────────────────────────────

const covers = (a: GovernanceScope, b: GovernanceScope) => a === 'all' || (b !== 'all' && b.every((x) => a.includes(x)));

/**
 * Two spend caps that do the same thing (same unit, period, mode, response
 * and alert), where the lower one covers every agent the higher one does:
 * then the higher one never acts. A $190 Just tell me and a $200 Block is a
 * warning before a stop, not an overlap; nor is a fleet-wide $500 beside a
 * $190 cap for one agent.
 */
export function spendOverlap(rules: readonly GovernanceRule[]): { never: GovernanceRule; first: GovernanceRule } | null {
  const caps = rules.filter((r) => r.ruleType === 'spend_cap' && r.mode !== 'off');
  for (let i = 0; i < caps.length; i++) {
    for (let j = i + 1; j < caps.length; j++) {
      const a = caps[i], b = caps[j];
      const pa = a.params as SpendCapParams, pb = b.params as SpendCapParams;
      if (pa.dailyCap === pb.dailyCap) continue;
      const [hi, lo] = pa.dailyCap > pb.dailyCap ? [a, b] : [b, a];
      if (pa.unit === pb.unit && pa.scope === pb.scope && a.mode === b.mode && (a.response ?? 'block') === (b.response ?? 'block')
        && !!a.alsoNotify === !!b.alsoNotify && covers(lo.appliesTo, hi.appliesTo)) {
        return { never: hi, first: lo };
      }
    }
  }
  return null;
}

// ── What each row says ──────────────────────────────────────────────

const TALLY: Record<GovernanceResponse, keyof RuleActionCounts> = { notify: 'toldYou', block: 'blocked', pause: 'paused', stop: 'stopped' };
const TALLY_WORD: Record<GovernanceResponse, string> = { notify: 'told you', block: 'blocked', pause: 'paused', stop: 'stopped' };
const times = (n: number) => (n === 1 ? 'once' : `${fmt(n)} times`);

/**
 * The row's status line. Enforce: what it did in the last 7 days, from the
 * engine's counts per rule type, so only when this is the fleet's one rule
 * of its type (two spend caps would share the count). Watch: what it would
 * have done since its last change. Viewing one agent, the counts are that
 * agent's: an Enforce count shows only for a rule that covers just them.
 */
export function rowStat(rule: GovernanceRule, ctx: {
  /** The engine's rule_actions byRule (keyed by rule type). */
  byRuleType?: Record<string, RuleActionCounts>;
  onlyOfItsType: boolean;
  /** unversioned: the engine's count may include events from before the rule's last change. */
  wouldAct?: { byAgent: Record<string, number>; unversioned?: boolean } | null;
  /** The agent being viewed, if any. */
  agent?: string | null;
}): string {
  const response = rule.response ?? 'block';
  if (rule.mode === 'enforce') {
    const justThem = !ctx.agent || (rule.appliesTo !== 'all' && rule.appliesTo.length === 1 && rule.appliesTo[0] === ctx.agent);
    const c = ctx.onlyOfItsType && justThem ? ctx.byRuleType?.[rule.ruleType] : undefined;
    return c ? `${fmt(c[TALLY[response]])} ${TALLY_WORD[response]} · last 7 days` : '';
  }
  if (rule.mode === 'watch') {
    if (!ctx.wouldAct) return '';
    const n = ctx.agent ? ctx.wouldAct.byAgent[ctx.agent] ?? 0 : Object.values(ctx.wouldAct.byAgent).reduce((a, b) => a + b, 0);
    if (ctx.wouldAct.unversioned) return n ? `Would have acted ${times(n)}, some maybe before its last change` : 'Hasn’t fired yet';
    return n ? `Would have ${TALLY_WORD[response]} ${times(n)}` : 'Hasn’t fired since its last change';
  }
  return '';
}

// ── What the agent gets ─────────────────────────────────────────────

const REASON: Record<GovernanceRuleType, string> = {
  spend_cap: 'budget_exceeded', loop_breaker: 'loop_detected', model_allowlist: 'model_not_allowed', tool_list: 'tool_not_allowed', call_rate: 'rate_exceeded',
};

/** The engine's 403 for this rule (blockResponseBody); nothing for Just tell me. */
export function agentGets(rule: Pick<GovernanceRule, 'ruleType' | 'params' | 'response'>): string {
  const response = rule.response ?? 'block';
  if (response === 'notify') return 'Nothing: the call goes through.\nYou get told; the agent doesn’t.';
  const held = response === 'pause' || response === 'stop';
  const resets = held ? 'when someone resumes it'
    : rule.ruleType === 'call_rate' ? 'once the last minute is back under the limit'
    : rule.ruleType === 'model_allowlist' || rule.ruleType === 'tool_list' ? 'never'
    : (rule.params as SpendCapParams | LoopBreakerParams).scope === 'day' ? 'next day (00:00 UTC)' : 'next run';
  return `403 governance_block\nresponse: ${response}\nreason: ${REASON[rule.ruleType]}\nretryable: ${!held && rule.ruleType === 'call_rate'}\nresets: ${resets}`;
}

export const AGENT_NOTE: Record<GovernanceRuleType, string> = {
  spend_cap: 'Stops before the next call. Non-retryable, so SDKs should not retry.',
  loop_breaker: 'Stops after the repeated call. Non-retryable within the same run.',
  model_allowlist: 'Stops before the call. The agent must switch to an allowed model.',
  call_rate: 'Stops the call that goes over the limit. Refused calls count too, so an agent that keeps retrying stays over until it slows down.',
  tool_list: 'Stops the model’s reply before the agent gets it, so the tool never runs. The model call itself is already spent.',
};

// ── The edit model behind Save ──────────────────────────────────────

/** A rule being edited. Numbers stay text while typed, so "1,0" isn't forced into 10. */
export interface RuleDraft {
  ruleType: GovernanceRuleType;
  mode: GovernanceMode;
  response: GovernanceResponse;
  alsoNotify: boolean;
  appliesTo: GovernanceScope;
  params: GovernanceParams;
  /** The number the person is typing (spend cap, loop threshold, calls a minute). */
  number: string;
}

const numberOf = (rule: Pick<GovernanceRule, 'ruleType' | 'params'>): string => {
  if (rule.ruleType === 'spend_cap') return String((rule.params as SpendCapParams).dailyCap);
  if (rule.ruleType === 'loop_breaker') return String((rule.params as LoopBreakerParams).threshold);
  if (rule.ruleType === 'call_rate') return String((rule.params as CallRateParams).maxCalls);
  return '';
};

export function draftFrom(rule: GovernanceRule): RuleDraft {
  return {
    ruleType: rule.ruleType, mode: rule.mode, response: rule.response ?? 'block', alsoNotify: !!rule.alsoNotify,
    appliesTo: rule.appliesTo === 'all' ? 'all' : [...rule.appliesTo],
    params: JSON.parse(JSON.stringify(rule.params)) as GovernanceParams,
    number: numberOf(rule),
  };
}

const hasNumber = (t: GovernanceRuleType) => t === 'spend_cap' || t === 'loop_breaker' || t === 'call_rate';

/** A typed number: digits, commas and a decimal point only (not "0x10" or "1e3"); NaN otherwise. */
export function typedNumber(text: string): number {
  const t = text.replace(/,/g, '').trim();
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** The draft's params with the typed number in place, or an error to show. */
export function draftParams(d: RuleDraft): { params: GovernanceParams } | { error: string } {
  if (!hasNumber(d.ruleType)) return { params: d.params };
  const n = typedNumber(d.number);
  if (d.ruleType === 'spend_cap') {
    if (!(n > 0) || !Number.isFinite(n)) return { error: 'Enter a number above 0.' };
    // Dollars may have cents; tokens are whole.
    if ((d.params as SpendCapParams).unit === 'tokens' && !Number.isInteger(n)) return { error: 'Enter a whole number of tokens.' };
    return { params: { ...(d.params as SpendCapParams), dailyCap: n } };
  }
  if (!Number.isInteger(n) || n < 1 || n > 10_000) return { error: 'Enter a whole number from 1 to 10,000.' };
  return { params: d.ruleType === 'loop_breaker' ? { ...(d.params as LoopBreakerParams), threshold: n } : { maxCalls: n } };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the draft differs from the saved rule: what enables Save and arms
 * the Discard guard. Compares values, so "1,500" over 1500 isn't a change; a
 * number that doesn't read yet counts as one when its text differs.
 */
export function isDirty(d: RuleDraft, rule: GovernanceRule): boolean {
  if ('error' in draftParams(d)) return d.number.trim() !== numberOf(rule);
  return draftChanges(d, rule) !== null;
}

/** A spend cap's unit changed: the typed limit converts at the blended rate, so $190 doesn't become 190 tokens. */
export function changeUnit(d: RuleDraft, unit: 'tokens' | 'dollars'): RuleDraft {
  const p = d.params as SpendCapParams;
  if (p.unit === unit) return d;
  const n = typedNumber(d.number);
  const number = n > 0 && Number.isFinite(n) ? String(convertSpendCap(n, unit)) : d.number;
  return { ...d, number, params: { ...p, unit } };
}

/** A new response; "Also send me an alert" only applies to Block, so it's cleared otherwise. */
export function changeResponse(d: RuleDraft, response: GovernanceResponse): RuleDraft {
  return { ...d, response, alsoNotify: response === 'block' ? d.alsoNotify : false };
}

/** What Save sends, from a valid draft: only what changed. Null when nothing did. */
export function draftChanges(d: RuleDraft, rule: GovernanceRule): {
  mode?: GovernanceMode; response?: GovernanceResponse; alsoNotify?: boolean; appliesTo?: GovernanceScope; params?: GovernanceParams;
} | null {
  const p = draftParams(d);
  if ('error' in p) return null;
  const out: { mode?: GovernanceMode; response?: GovernanceResponse; alsoNotify?: boolean; appliesTo?: GovernanceScope; params?: GovernanceParams } = {};
  if (d.mode !== rule.mode) out.mode = d.mode;
  if (d.response !== (rule.response ?? 'block')) out.response = d.response;
  if (d.alsoNotify !== !!rule.alsoNotify) out.alsoNotify = d.alsoNotify;
  if (!same(d.appliesTo, rule.appliesTo)) out.appliesTo = d.appliesTo;
  if (!same(p.params, rule.params)) out.params = p.params;
  return Object.keys(out).length ? out : null;
}

/** Why Save can't go ahead yet, or null. */
export function draftProblem(d: RuleDraft): string | null {
  const p = draftParams(d);
  if ('error' in p) return p.error;
  if (d.appliesTo !== 'all' && d.appliesTo.length === 0) return 'Pick at least one agent, or choose All agents.';
  if (d.mode === 'enforce' && d.ruleType === 'model_allowlist' && (p.params as ModelAllowlistParams).allowedModels.length === 0) return 'Pick at least one model before you enforce this rule.';
  if (d.mode === 'enforce' && d.ruleType === 'tool_list' && (p.params as ToolListParams).blockedTools.length === 0) return 'Pick at least one tool before you enforce this rule.';
  return null;
}

// ── Add a rule ──────────────────────────────────────────────────────

/** "Add a rule" choices, by goal, each naming its rule. */
export const RULE_TEMPLATES: { type: GovernanceRuleType; title: string; desc: string }[] = [
  { type: 'spend_cap', title: 'Cap spending', desc: 'Block calls once an agent spends more than you set in a run or a day.' },
  { type: 'loop_breaker', title: 'Break loops', desc: 'Catch an agent making the same call over and over.' },
  { type: 'call_rate', title: 'Limit calls per minute', desc: 'Slow down an agent that makes too many calls at once.' },
  { type: 'model_allowlist', title: 'Allow only certain models', desc: 'Block calls to any model you haven’t picked.' },
  { type: 'tool_list', title: 'Block tools', desc: 'Keep agents from running tools you name.' },
];
