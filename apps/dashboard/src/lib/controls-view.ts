// What the Controls page shows for each rule, in plain words, and the edit
// model behind its Save button (Controls spec Rev 1, D1). Pure: no React, no
// fetching, so every sentence and decision here is tested on its own.

import type {
  CallRateParams, GovernanceMode, GovernanceParams, GovernanceResponse, GovernanceRule, GovernanceRuleType,
  GovernanceScope, KeywordParams, KeywordWhere, LoopBreakerParams, ModelAllowlistParams, RuleActionCounts, SpendCapParams, ToolListParams,
} from '@/lib/whiteroom/types';
import { convertSpendCap } from '@/lib/governance';
import { MODE_LABEL, NOTIFY } from '@/lib/vocab';
import { DAY_MS, fmtCount, ordinal } from '@/lib/format';

// ── Sentences ───────────────────────────────────────────────────────

/** The engine's limits on a Keywords rule's list: 50 keywords of up to 50 characters. */
export const KEYWORD_MAX = 50;
export const KEYWORD_MAX_CHARS = 50;

/** How many keywords a rule has, counting a list the engine hid (keywordCount). */
export function keywordTotal(p: KeywordParams): number {
  return p.keywords.length || (p.keywordCount ?? 0);
}

/** Whether one more keyword fits: a rule holds at most KEYWORD_MAX. */
export function keywordFits(keywords: readonly string[]): boolean {
  return keywords.length < KEYWORD_MAX;
}

/** Where a Keywords rule looks, as it reads in a sentence. */
export const KEYWORD_WHERE: Record<KeywordWhere, string> = { incoming: 'incoming data', replies: 'a model reply', both: 'incoming data or a reply' };

const VERB: Record<GovernanceResponse, string> = { notify: NOTIFY.verb, block: 'block the call', pause: 'pause the agent', stop: 'stop the agent' };

export const money = (p: SpendCapParams) => (p.unit === 'dollars' ? `$${fmtCount(p.dailyCap)}` : `${fmtCount(p.dailyCap)} tokens`);

/**
 * The rule as one sentence, split so the values can be set in mono. Only a
 * rule in Block does what it says; in Record only or Off it "would", so the
 * sentence never claims a call is stopped when it isn't.
 */
export function ruleSentence(rule: Pick<GovernanceRule, 'ruleType' | 'params' | 'response' | 'alsoNotify'> & { mode?: GovernanceRule['mode'] }): { pre: string; val: string; post: string } {
  const response = rule.response ?? 'block';
  const does = response === 'block' && rule.alsoNotify ? `block the call and ${NOTIFY.verb}` : VERB[response];
  const v = rule.mode === undefined || rule.mode === 'enforce' ? does : `it would ${does}`;
  if (rule.ruleType === 'spend_cap') {
    const p = rule.params as SpendCapParams;
    return { pre: 'When an agent spends more than ', val: money(p), post: ` in a ${p.scope}, ${v}.` };
  }
  if (rule.ruleType === 'loop_breaker') {
    const p = rule.params as LoopBreakerParams;
    return { pre: 'When an agent makes the same call ', val: fmtCount(p.threshold), post: ` times in a ${p.scope}, ${v}.` };
  }
  if (rule.ruleType === 'call_rate') {
    return { pre: 'When an agent makes more than ', val: fmtCount((rule.params as CallRateParams).maxCalls), post: ` calls in a minute, ${v}.` };
  }
  if (rule.ruleType === 'keyword') {
    const p = rule.params as KeywordParams;
    // Without the dashboard's secret the engine sends only how many there are.
    if (!p.keywords.length && p.keywordCount) {
      return p.keywordCount === 1
        ? { pre: `When ${KEYWORD_WHERE[p.where]} contains `, val: 'a hidden keyword', post: `, ${v}.` }
        : { pre: `When ${KEYWORD_WHERE[p.where]} contains any of `, val: `${p.keywordCount} hidden keywords`, post: `, ${v}.` };
    }
    return p.keywords.length
      ? { pre: `When ${KEYWORD_WHERE[p.where]} contains ${p.keywords.length > 1 ? 'any of ' : ''}`, val: p.keywords.map((k) => `“${k}”`).join(', '), post: `, ${v}.` }
      : { pre: 'No keywords picked yet.', val: '', post: '' };
  }
  if (rule.ruleType === 'tool_list') {
    const tools = (rule.params as ToolListParams).blockedTools;
    return tools.length ? { pre: 'When an agent is about to run ', val: tools.join(', '), post: `, ${v}.` } : { pre: 'No tools picked yet.', val: '', post: '' };
  }
  const models = (rule.params as ModelAllowlistParams).allowedModels;
  return models.length ? { pre: 'Only allow ', val: models.join(', '), post: `. For any other model, ${v}.` } : { pre: 'No models picked yet.', val: '', post: '' };
}

export const ruleSentenceText = (rule: Parameters<typeof ruleSentence>[0]) => { const s = ruleSentence(rule); return s.pre + s.val + s.post; };

/** Who a change covers, said in a confirm dialog. */
export function appliesNow(scope: GovernanceScope): string {
  return `It applies to ${scope === 'all' ? 'all agents in this fleet' : scope.join(', ')}, and takes effect now.`;
}

// ── Grouping and the agent filter ───────────────────────────────────

/** The rules that govern an agent: the fleet-wide ones and its own. `null`: every rule. */
export function rulesFor(rules: readonly GovernanceRule[], agent: string | null): GovernanceRule[] {
  return agent === null ? [...rules] : rules.filter((r) => r.appliesTo === 'all' || r.appliesTo.includes(agent));
}

function ruleOrder(a: GovernanceRule, b: GovernanceRule): number {
  const byType = typeRank(a.ruleType) - typeRank(b.ruleType);
  if (byType || a.ruleType !== 'spend_cap') return byType;
  const pa = a.params as SpendCapParams, pb = b.params as SpendCapParams;
  return pa.scope.localeCompare(pb.scope) || pa.unit.localeCompare(pb.unit) || pa.dailyCap - pb.dailyCap;
}

function typeRank(t: GovernanceRuleType): number {
  const i = RULE_TEMPLATES.findIndex((r) => r.type === t);
  return i < 0 ? RULE_TEMPLATES.length : i;
}

// ── Overlap ─────────────────────────────────────────────────────────

const covers = (a: GovernanceScope, b: GovernanceScope) => a === 'all' || (b !== 'all' && b.every((x) => a.includes(x)));

/**
 * Two spend caps that do the same thing (same unit, period, mode, response
 * and alert), where the lower one covers every agent the higher one does:
 * then the higher one never acts. A $190 Alert me and a $200 Block is a
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
const TALLY_WORD: Record<GovernanceResponse, string> = { notify: NOTIFY.done, block: 'blocked', pause: 'paused', stop: 'stopped' };
const times = (n: number) => (n === 1 ? 'once' : `${fmtCount(n)} times`);
/** A rule (or agent) with no actions. */
export const NO_ACTIONS: RuleActionCounts = { blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 };

/** A Keywords or Tool list rule with nothing picked can never act: what it still needs. */
export function emptyPick(rule: Pick<GovernanceRule, 'ruleType' | 'params'>): string | null {
  if (rule.ruleType === 'keyword') return keywordTotal(rule.params as KeywordParams) ? null : 'a keyword';
  if (rule.ruleType === 'tool_list') return (rule.params as ToolListParams).blockedTools.length ? null : 'a tool';
  return null;
}

// ── What the agent gets ─────────────────────────────────────────────

const REASON: Record<GovernanceRuleType, string> = {
  spend_cap: 'budget_exceeded', loop_breaker: 'loop_detected', model_allowlist: 'model_not_allowed', tool_list: 'tool_not_allowed', call_rate: 'rate_exceeded',
  keyword: 'keyword_found',
};

/** The engine's 403 for this rule (blockResponseBody); nothing for Alert me. */
export function agentGets(rule: Pick<GovernanceRule, 'ruleType' | 'params' | 'response'>): string {
  const response = rule.response ?? 'block';
  if (response === 'notify') return 'Nothing: the call goes through.\nYou get an alert; the agent doesn’t.';
  const held = response === 'pause' || response === 'stop';
  const resets = held ? 'when someone resumes it'
    : rule.ruleType === 'call_rate' ? 'once the last minute is back under the limit'
    : rule.ruleType === 'model_allowlist' || rule.ruleType === 'tool_list' || rule.ruleType === 'keyword' ? 'never'
    : (rule.params as SpendCapParams | LoopBreakerParams).scope === 'day' ? 'next day (00:00 UTC)' : 'next run';
  return `403 governance_block\nresponse: ${response}\nreason: ${REASON[rule.ruleType]}\nretryable: ${!held && rule.ruleType === 'call_rate'}\nresets: ${resets}`;
}

export const AGENT_NOTE: Record<GovernanceRuleType, string> = {
  spend_cap: 'Stops before the next call. Non-retryable, so SDKs should not retry.',
  loop_breaker: 'Stops after the repeated call. Non-retryable within the same run.',
  model_allowlist: 'Stops before the call. The agent must switch to an allowed model.',
  call_rate: 'Stops the call that goes over the limit. Refused calls count too, so an agent that keeps retrying stays over until it slows down.',
  tool_list: 'Stops the model’s reply before the agent gets it, so the tool never runs. The model call itself is already spent.',
  keyword: 'Stops the call before the model sees it, or the reply before the agent does. The agent isn’t told which keyword matched.',
};

// ── The edit model behind Save ──────────────────────────────────────

/**
 * When a Loop breaker acts, from the number being typed: "Acts on the 100th
 * same call." Until that's a whole number, the saved threshold.
 */
export function loopActs(typed: string, saved: number | undefined): string {
  const n = /^\d+$/.test(typed.trim()) && Number(typed) > 0 ? Number(typed) : saved;
  return n && n > 0 ? `Acts on the ${ordinal(n)} same call.` : 'Acts on the call that reaches the limit.';
}

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

/**
 * A typed number: digits and a decimal point, with commas only between
 * thousands ("1,500"), so "1,5" isn't read as 15 and "0x10" or "1e3" aren't
 * numbers at all; NaN otherwise.
 */
export function typedNumber(text: string): number {
  const t = text.trim();
  return /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t) ? Number(t.replace(/,/g, '')) : NaN;
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

/** Whether the rule, as drafted, sends an alert when it acts: Alert me, Pause, Stop, or Block with an alert. */
export function sendsAlert(d: Pick<RuleDraft, 'mode' | 'response' | 'alsoNotify'>): boolean {
  return d.mode === 'enforce' && (d.response !== 'block' || d.alsoNotify);
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
  if (d.mode === 'enforce' && d.ruleType === 'model_allowlist' && (p.params as ModelAllowlistParams).allowedModels.length === 0) return 'Pick at least one model before you turn on Block.';
  if (d.mode === 'enforce' && d.ruleType === 'tool_list' && (p.params as ToolListParams).blockedTools.length === 0) return 'Pick at least one tool before you turn on Block.';
  if (d.mode === 'enforce' && d.ruleType === 'keyword' && keywordTotal(p.params as KeywordParams) === 0) return 'Pick at least one keyword before you turn on Block.';
  return null;
}

// ── Add a rule ──────────────────────────────────────────────────────

/** "Add a rule" choices, by goal, each naming its rule. Also the order rules are listed in on Controls (byMode). */
export const RULE_TEMPLATES: { type: GovernanceRuleType; title: string; desc: string; isNew?: boolean }[] = [
  { type: 'spend_cap', title: 'Cap spending', desc: 'Block calls once an agent spends more than you set in a run or a day.' },
  { type: 'call_rate', title: 'Limit calls per minute', desc: 'Block calls once an agent makes too many in a minute.' },
  { type: 'model_allowlist', title: 'Allow only certain models', desc: 'Block calls to any model you haven’t picked.' },
  { type: 'loop_breaker', title: 'Break loops', desc: 'Catch an agent making the same call over and over.' },
  { type: 'tool_list', title: 'Block tools', desc: 'Keep agents from running tools you name.' },
  { type: 'keyword', title: 'Flag keywords', desc: 'Get an alert, or block the call, when words you pick show up.', isNew: true },
];

// ── Groups: who a rule covers ───────────────────────────────────────

/** Whether a rule can stop a call or an agent now: Block mode with a response other than Alert me, that has something to act on. */
export function isStopping(r: GovernanceRule): boolean {
  return r.mode === 'enforce' && (r.response ?? 'block') !== 'notify' && !emptyPick(r);
}

/** The rules that can stop a call or an agent now (isStopping). */
export function stopping(rules: GovernanceRule[]): GovernanceRule[] {
  return rules.filter(isStopping);
}

// ── Weakening a rule ────────────────────────────────────────────────

const MODE_RANK: Record<GovernanceMode, number> = { off: 0, watch: 1, enforce: 2 };
const RESPONSE_RANK: Record<GovernanceResponse, number> = { notify: 0, block: 1, pause: 2, stop: 3 };

/**
 * What a change makes weaker, in plain lines, so Save can ask first: a lower
 * mode, a milder response, no alert, fewer agents covered, or a looser limit.
 * Empty when nothing weakens (anyone may weaken a rule, decided Q5; the log
 * records it and the change log can undo it).
 */
export function weakenings(prev: GovernanceRule, next: GovernanceRule): string[] {
  const out: string[] = [];
  if (MODE_RANK[next.mode] < MODE_RANK[prev.mode]) out.push(`Mode: ${MODE_LABEL[prev.mode]} → ${MODE_LABEL[next.mode]}`);
  const pr = prev.response ?? 'block', nr = next.response ?? 'block';
  if (next.mode === 'enforce' && prev.mode === 'enforce' && RESPONSE_RANK[nr] < RESPONSE_RANK[pr]) out.push(`Then: ${VERB[pr]} → ${VERB[nr]}`);
  if (prev.alsoNotify && !next.alsoNotify && nr === 'block') out.push('It stops sending you an alert');
  if (prev.appliesTo === 'all' && next.appliesTo !== 'all') out.push(`Covers only ${next.appliesTo.join(', ') || 'no agents'}, not every agent`);
  else if (prev.appliesTo !== 'all' && next.appliesTo !== 'all') {
    const dropped = prev.appliesTo.filter((a) => !(next.appliesTo as string[]).includes(a));
    if (dropped.length) out.push(`No longer covers ${dropped.join(', ')}`);
  }
  out.push(...looser(prev, next));
  return out;
}

function looser(prev: GovernanceRule, next: GovernanceRule): string[] {
  const a = prev.params, b = next.params;
  switch (prev.ruleType) {
    case 'spend_cap': {
      const p = a as SpendCapParams, n = b as SpendCapParams;
      // A different unit or period can't be compared, and may well be looser: ask.
      if (p.unit !== n.unit || p.scope !== n.scope) return [`Limit: ${money(p)} a ${p.scope} → ${money(n)} a ${n.scope}`];
      return n.dailyCap > p.dailyCap ? [`Limit: ${money(p)} → ${money(n)}`] : [];
    }
    case 'loop_breaker': {
      const p = a as LoopBreakerParams, n = b as LoopBreakerParams;
      return n.threshold > p.threshold ? [`Acts after ${fmtCount(n.threshold)} repeats instead of ${fmtCount(p.threshold)}`] : [];
    }
    case 'call_rate': {
      const p = a as CallRateParams, n = b as CallRateParams;
      return n.maxCalls > p.maxCalls ? [`Allows ${fmtCount(n.maxCalls)} calls a minute instead of ${fmtCount(p.maxCalls)}`] : [];
    }
    case 'model_allowlist': {
      const added = (b as ModelAllowlistParams).allowedModels.filter((m) => !(a as ModelAllowlistParams).allowedModels.includes(m));
      return added.length ? [`Also allows ${added.join(', ')}`] : [];
    }
    case 'tool_list': {
      const freed = (a as ToolListParams).blockedTools.filter((t) => !(b as ToolListParams).blockedTools.includes(t));
      return freed.length ? [`No longer blocks ${freed.join(', ')}`] : [];
    }
    case 'keyword': {
      const p = a as KeywordParams, n = b as KeywordParams;
      const out: string[] = [];
      // Matched without regard to case, as the editor's duplicate check does: "Orion" → "orion" isn't a removal.
      const kept = new Set(n.keywords.map((k) => k.toLowerCase()));
      const removed = p.keywords.filter((k) => !kept.has(k.toLowerCase()));
      if (removed.length) out.push(`No longer looks for ${removed.map((k) => `“${k}”`).join(', ')}`);
      if (!p.wholeWord && n.wholeWord) out.push('Matches whole words only, not parts of words');
      const places = (w: KeywordParams['where']) => (w === 'both' ? ['incoming', 'replies'] : [w]);
      for (const gone of places(p.where).filter((x) => !places(n.where).includes(x))) out.push(`No longer looks in ${gone === 'incoming' ? 'incoming data' : 'model replies'}`);
      return out;
    }
    default:
      return [];
  }
}

/**
 * Average dollars a day from hourly points, from the first point until now (a fleet two days old
 * averages over two days, not the whole window; idle days since still count), up to `maxDays`. Null without data, never a made-up $0.
 */
export function averageDailySpend(hourly: { error?: string; hourly?: { hour?: string; costMicros?: number }[] } | null | undefined, maxDays: number, now: number = Date.now()): { perDay: number; days: number } | null {
  if (!hourly || hourly.error || !Array.isArray(hourly.hourly) || hourly.hourly.length === 0 || maxDays <= 0) return null;
  const times = hourly.hourly.map((h) => Date.parse(h.hour ?? '')).filter((t) => !Number.isNaN(t));
  // From the first point to now: quiet days since count, so a burst long ago isn't read as a daily rate.
  const spanDays = times.length ? (now - Math.min(...times)) / DAY_MS : maxDays;
  const days = Math.min(maxDays, Math.max(1, Math.ceil(spanDays)));
  return { perDay: hourly.hourly.reduce((n, h) => n + (h.costMicros || 0), 0) / 1e6 / days, days };
}

/** Deep equality that ignores object key order (the engine and the draft may order params differently). */
export function sameValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
    : v ?? null);
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

// ── Mockup parity: rows, status, groups and suggestions ─────────────

/**
 * The rule's condition alone, for a row under its kind ("Spend cap" /
 * "Over $190 a day"), split so the value can be set in mono.
 */
export function ruleCondition(rule: Pick<GovernanceRule, 'ruleType' | 'params'>): { pre: string; val: string; post: string } {
  if (rule.ruleType === 'spend_cap') {
    const p = rule.params as SpendCapParams;
    const per = p.scope === 'day' ? ' a day' : ' in a run';
    return p.unit === 'dollars' ? { pre: 'Over ', val: money(p), post: per } : { pre: 'Over ', val: fmtCount(p.dailyCap), post: ` tokens${per}` };
  }
  if (rule.ruleType === 'loop_breaker') {
    const p = rule.params as LoopBreakerParams;
    return { pre: 'Same call ', val: fmtCount(p.threshold), post: `× in a ${p.scope}` };
  }
  if (rule.ruleType === 'call_rate') return { pre: 'Over ', val: fmtCount((rule.params as CallRateParams).maxCalls), post: ' calls a minute' };
  if (rule.ruleType === 'keyword') {
    const p = rule.params as KeywordParams;
    const where = KEYWORD_WHERE[p.where];
    const lead = `${where[0].toUpperCase()}${where.slice(1)} contains `;
    if (!p.keywords.length && p.keywordCount) return { pre: lead, val: p.keywordCount === 1 ? 'a hidden keyword' : `${p.keywordCount} hidden keywords`, post: '' };
    return p.keywords.length ? { pre: lead, val: p.keywords.map((k) => `"${k}"`).join(', '), post: '' } : { pre: 'No keywords picked yet', val: '', post: '' };
  }
  if (rule.ruleType === 'tool_list') {
    const tools = (rule.params as ToolListParams).blockedTools;
    return tools.length ? { pre: 'Tools: ', val: tools.join(', '), post: '' } : { pre: 'No tools picked yet', val: '', post: '' };
  }
  const models = (rule.params as ModelAllowlistParams).allowedModels;
  return models.length ? { pre: 'Only ', val: models.join(', '), post: '' } : { pre: 'No models picked yet', val: '', post: '' };
}

export const ruleConditionText = (rule: Pick<GovernanceRule, 'ruleType' | 'params'>) => { const c = ruleCondition(rule); return c.pre + c.val + c.post; };

/** Who a rule covers, in a sentence: "all agents", "lead-agent", "lead-agent, code-reviewer". */
export const whoFor = (scope: GovernanceScope) => (scope === 'all' ? 'all agents' : scope.join(', ') || 'no agents');

/** Whether a rule has nothing to act on yet (a Keywords or Tool list rule with nothing picked). */
export const notSetUp = (r: Pick<GovernanceRule, 'ruleType' | 'params'>) => emptyPick(r) !== null;

/**
 * The page's three cards: rules for all agents, rules for specific agents
 * (each agent's own, under its name; a rule for two agents shows under
 * both), and "Off and not set up". Block first within a group, then the
 * "Add a rule" order.
 */
export function ruleGroups(rules: readonly GovernanceRule[]): {
  all: GovernanceRule[]; byAgent: { agent: string; rules: GovernanceRule[] }[]; off: GovernanceRule[]; unset: GovernanceRule[];
} {
  const sorted = [...rules].sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode] || ruleOrder(a, b));
  const on = sorted.filter((r) => r.mode !== 'off' && !notSetUp(r));
  const owners = [...new Set(on.flatMap((r) => (r.appliesTo === 'all' ? [] : r.appliesTo)))].sort((a, b) => a.localeCompare(b));
  return {
    all: on.filter((r) => r.appliesTo === 'all'),
    byAgent: owners.map((agent) => ({ agent, rules: on.filter((r) => r.appliesTo !== 'all' && r.appliesTo.includes(agent)) })),
    off: sorted.filter((r) => r.mode === 'off' && !notSetUp(r)),
    unset: sorted.filter(notSetUp),
  };
}
const MODE_ORDER: Record<GovernanceMode, number> = { enforce: 0, watch: 1, off: 2 };

/** A group's sub-line, worded like the lead line: "1 Block · 6 Record only". */
export function modeCount(rules: readonly GovernanceRule[]): string {
  const e = rules.filter((r) => r.mode === 'enforce').length, w = rules.filter((r) => r.mode === 'watch').length;
  return `${e} Block · ${w} Record only`;
}

/** The page's lead line, counting only rules that are set up. */
export function leadCounts(rules: readonly GovernanceRule[]): { total: number; enforce: number; watch: number; off: number } {
  const set = rules.filter((r) => !notSetUp(r));
  return { total: set.length, enforce: set.filter((r) => r.mode === 'enforce').length, watch: set.filter((r) => r.mode === 'watch').length, off: set.filter((r) => r.mode === 'off').length };
}

/** When the one rule that blocks acts, for the amber box: "only after 100 repeated calls". */
export function blocksWhen(rule: Pick<GovernanceRule, 'ruleType' | 'params' | 'appliesTo'>): string {
  const only = rule.appliesTo === 'all' ? '' : `, for ${whoFor(rule.appliesTo)}`;
  switch (rule.ruleType) {
    case 'loop_breaker': return `only after ${fmtCount((rule.params as LoopBreakerParams).threshold)} repeated calls${only}`;
    case 'spend_cap': { const p = rule.params as SpendCapParams; return `only over ${money(p)} ${p.scope === 'day' ? 'a day' : 'in a run'}${only}`; }
    case 'call_rate': return `only over ${fmtCount((rule.params as CallRateParams).maxCalls)} calls a minute${only}`;
    case 'model_allowlist': return `only for models not on its list${only}`;
    case 'tool_list': return `only for the tools it names${only}`;
    default: return `only when its keywords show up${only}`;
  }
}

export type RowCount = { text: string; tone: 'plain' | 'hot' | 'warn' };

/**
 * The count at the right of a row: "60 caught · 7 days", "None since edit",
 * "Never triggers ($190 cap first)". Seven-day counts are per rule id
 * (rule_actions byRuleId); "since edit" comes from rule_would_act. Viewing
 * one agent, a Record only rule counts that agent's calls since its last
 * change, and a Block rule shows its count only when it covers just them.
 */
export function rowCount(rule: GovernanceRule, ctx: {
  byRuleId?: Record<string, RuleActionCounts>;
  byRuleType?: Record<string, RuleActionCounts>;
  onlyOfItsType: boolean;
  wouldAct?: { byAgent: Record<string, number>; unversioned?: boolean } | null;
  agent?: string | null;
  /** This spend cap never triggers: the cap that catches it first. */
  neverFirst?: string | null;
}): RowCount {
  if (rule.mode === 'off') return { text: '', tone: 'plain' };
  const nothingPicked = emptyPick(rule);
  if (nothingPicked) return { text: `Does nothing until you add ${nothingPicked}`, tone: 'warn' };
  if (ctx.neverFirst) return { text: `Never triggers (${ctx.neverFirst} cap first)`, tone: 'warn' };
  const week = ctx.byRuleId ? ctx.byRuleId[rule.id] ?? NO_ACTIONS : ctx.onlyOfItsType && ctx.byRuleType ? ctx.byRuleType[rule.ruleType] ?? NO_ACTIONS : undefined;
  const response = rule.response ?? 'block';
  if (rule.mode === 'enforce') {
    const justThem = !ctx.agent || (rule.appliesTo !== 'all' && rule.appliesTo.length === 1 && rule.appliesTo[0] === ctx.agent);
    if (!justThem || !week) return { text: '', tone: 'plain' };
    const n = week[TALLY[response]];
    return n ? { text: `${fmtCount(n)} ${TALLY_WORD[response]} · 7 days`, tone: 'hot' } : { text: 'None caught · 7 days', tone: 'plain' };
  }
  const since = ctx.wouldAct && !ctx.wouldAct.unversioned ? ctx.wouldAct : null;
  const sinceN = since ? (ctx.agent ? since.byAgent[ctx.agent] ?? 0 : Object.values(since.byAgent).reduce((a, b) => a + b, 0)) : null;
  if (ctx.agent || !week) {
    if (sinceN === null) return { text: '', tone: 'plain' };
    return sinceN ? { text: `${fmtCount(sinceN)} caught since edit`, tone: 'hot' } : { text: 'None since edit', tone: 'plain' };
  }
  if (week.wouldAct) return { text: `${fmtCount(week.wouldAct)} caught · 7 days`, tone: 'hot' };
  return { text: sinceN === 0 ? 'None since edit' : 'None caught · 7 days', tone: 'plain' };
}

const WOULD_VERB: Record<GovernanceResponse, (who: string) => string> = {
  block: (who) => `blocked ${who}`, pause: (who) => `paused ${who}`, stop: (who) => `stopped ${who}`, notify: (who) => `alerted you about ${who}`,
};
const DOING: Record<GovernanceResponse, string> = { block: 'Blocking', pause: 'Pausing agents', stop: 'Stopping agents', notify: 'Alerting you' };

/**
 * The editor's status sentence: what the rule is doing now, and what it
 * caught. "Would have blocked code-reviewer 44 times since it was last
 * changed 4 days ago." Never claims a count it doesn't have.
 */
export function ruleStatus(rule: GovernanceRule, ctx: {
  week?: RuleActionCounts;
  wouldAct?: { byAgent: Record<string, number>; unversioned?: boolean; since?: string | null } | null;
  neverFirst?: string | null;
  now?: number;
}): string {
  const who = whoFor(rule.appliesTo);
  const response = rule.response ?? 'block';
  if (rule.mode === 'off') return 'Off. Records nothing.';
  const nothingPicked = emptyPick(rule);
  if (nothingPicked) return `Does nothing until you add ${nothingPicked}.`;
  if (ctx.neverFirst) return `This cap never triggers. The ${ctx.neverFirst} cap covers the same agents and catches it first.`;
  if (rule.mode === 'enforce') {
    const n = ctx.week ? ctx.week[TALLY[response]] : null;
    const tail = n === null ? '' : n ? ` ${TALLY_WORD[response][0].toUpperCase()}${TALLY_WORD[response].slice(1)} ${times(n)} in the last 7 days.` : ' Nothing caught in the last 7 days.';
    return `${DOING[response]} for ${who}.${tail}`;
  }
  const w = ctx.wouldAct;
  if (w && !w.unversioned && w.since) {
    const when = timeAgoShort(w.since, ctx.now);
    const hits = Object.entries(w.byAgent).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (!hits.length) return `Record only for ${who}. Nothing caught since it was last changed ${when}.`;
    const total = hits.reduce((s, [, n]) => s + n, 0);
    const whom = hits.length === 1 ? `${hits[0][0]} ${times(hits[0][1])}` : hits.length === 2 ? `${hits[0][0]} and ${hits[1][0]} ${times(total)} in all` : `${hits.length} agents ${times(total)} in all`;
    return `Would have ${WOULD_VERB[response](whom)} since it was last changed ${when}.`;
  }
  if (ctx.week) {
    return ctx.week.wouldAct ? `Record only for ${who}. Would have acted ${times(ctx.week.wouldAct)} in the last 7 days.` : `Record only for ${who}. Nothing caught in the last 7 days.`;
  }
  return `Record only for ${who}.`;
}

function timeAgoShort(ts: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(ts)) / DAY_MS);
  return days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Rules that do exactly the same thing (same kind, settings, agents, mode, response and alert): all but the first are extra. */
export function duplicateRules(rules: readonly GovernanceRule[]): { keep: GovernanceRule; extra: GovernanceRule[] }[] {
  const out: { keep: GovernanceRule; extra: GovernanceRule[] }[] = [];
  const scopeKey = (s: GovernanceScope) => (s === 'all' ? 'all' : [...s].sort());
  for (const r of rules) {
    if (notSetUp(r)) continue;
    const g = out.find(({ keep: k }) => k.ruleType === r.ruleType && k.mode === r.mode && (k.response ?? 'block') === (r.response ?? 'block')
      && !!k.alsoNotify === !!r.alsoNotify && sameValue(scopeKey(k.appliesTo), scopeKey(r.appliesTo)) && sameValue(k.params, r.params));
    if (g) g.extra.push(r); else out.push({ keep: r, extra: [] });
  }
  return out.filter((g) => g.extra.length > 0);
}

/**
 * Keywords rules that cover only some agents, with no rule for all agents
 * looking for the same words in the same place: the words aren't watched
 * for everyone else. Hidden keyword lists are left out (they can't be copied).
 */
export function keywordGaps(rules: readonly GovernanceRule[], agents: readonly string[]): GovernanceRule[] {
  const kw = rules.filter((r) => r.ruleType === 'keyword' && r.mode !== 'off');
  const places = (w: KeywordWhere) => (w === 'both' ? ['incoming', 'replies'] : [w]);
  return kw.filter((r) => {
    if (r.appliesTo === 'all') return false;
    const p = r.params as KeywordParams;
    if (!p.keywords.length) return false;
    if (agents.every((a) => (r.appliesTo as string[]).includes(a))) return false;
    return !kw.some((o) => {
      if (o.appliesTo !== 'all') return false;
      const q = o.params as KeywordParams;
      const have = new Set(q.keywords.map((k) => k.toLowerCase()));
      return p.keywords.every((k) => have.has(k.toLowerCase())) && places(p.where).every((x) => places(q.where).includes(x));
    });
  });
}

/** A Keywords rule's words for a sentence: "password", or "password", "SSN" + 2 more. */
export function keywordsShort(p: KeywordParams): string {
  const shown = p.keywords.slice(0, 2).map((k) => `"${k}"`).join(', ');
  return p.keywords.length > 2 ? `${shown} + ${p.keywords.length - 2} more` : shown;
}
