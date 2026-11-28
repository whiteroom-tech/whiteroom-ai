// What the Controls page shows for each rule, in plain words, and the edit
// model behind its Save button (Controls spec Rev 1, D1). Pure: no React, no
// fetching, so every sentence and decision here is tested on its own.

import type {
  BlockStreakParams, CallRateParams, GovernanceMode, GovernanceParams, GovernanceResponse, GovernanceRule, GovernanceRuleType,
  DataDeletionParams, GovernanceScope, KeywordParams, KeywordWhere, LadderEntry, LoopBreakerParams, ModelAllowlistParams, ModelRouteParams, OutsideThenSendParams, RuleActionCounts, SendLimitParams, SendSeenRow, SpendCapParams, ToolListParams, TrimResultsParams,
} from '@/lib/whiteroom/types';
import { convertSpendCap, engineTakes, RULE_CATEGORY, UNKNOWN_RULE, unhandledType } from '@/lib/governance';
import { MODE_LABEL, NOTIFY } from '@/lib/vocab';
import { DAY_MS, fmtCount, ordinal, plural } from '@/lib/format';

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

/** A marker: a made-up code stored as an ordinary keyword (DLP spec 3.4), `wrmk` and 16 hex characters. */
const MARKER = /^wrmk[0-9a-f]{16}$/;
export const isMarker = (k: string) => MARKER.test(k);

/** A new marker, from the browser's random source. */
export function newMarker(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `wrmk${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A marker cut to fit one line: its first 8 characters, an ellipsis, its last 4. */
export const markerShort = (code: string) => `${code.slice(0, 8)}…${code.slice(-4)}`;

const markerCount = (n: number) => (n === 1 ? '1 marker' : `${n} markers`);

/** Keywords for a sentence, quoted by `quote`; markers are counted ("1 marker"), never shown. */
function keywordsText(keywords: readonly string[], quote: (k: string) => string): string {
  const words = keywords.filter((k) => !isMarker(k));
  const markers = keywords.length - words.length;
  return [...words.map(quote), ...(markers ? [markerCount(markers)] : [])].join(', ');
}

/** Where a Keywords rule looks, as it reads in a sentence. */
export const KEYWORD_WHERE: Record<KeywordWhere, string> = { incoming: 'incoming data', replies: 'a model reply', both: 'incoming data or a reply' };

const VERB: Record<GovernanceResponse, string> = { notify: NOTIFY.verb, block: 'block the call', pause: 'pause the agent', stop: 'stop the agent' };

export const money = (p: SpendCapParams) => (p.unit === 'dollars' ? `$${fmtCount(p.dailyCap)}` : `${fmtCount(p.dailyCap)} tokens`);

// ── Where tools can send data (DLP spec 3.2, 5.2) ──────────────────

/** The engine's limit on each tool list a data rule holds (DLP spec 5.2, 5.3). */
const TOOLS_PER_LIST = 50;

/** The engine's limits on a Where tools can send data rule: 50 tools, 100 allowed domains. */
export const SEND_TOOLS_MAX = TOOLS_PER_LIST;
/** What Save says, and the editor under the list, when a rule's tool list is over its limit. */
export const toolsFull = (max: number) => `A rule holds up to ${max} tools. Remove one to save.`;
export const SEND_DOMAINS_MAX = 100;
const SEEN_FULL_AT = 500;

/** How many domains a rule allows, counting a list the engine hid (domainCount). */
export function domainTotal(p: SendLimitParams): number {
  return p.domains.length || (p.domainCount ?? 0);
}

/**
 * The engine sent the domain count, not the list: a caller without the
 * dashboard's secret (anyone but the fleet's owner). The editor is then read
 * only, and the list is never written back.
 */
export function domainsHidden(r: Pick<GovernanceRule, 'ruleType' | 'params'>): boolean {
  return r.ruleType === 'send_limit' && typeof (r.params as SendLimitParams).domainCount === 'number';
}

/** The send_limit sentence's tools: "send_email", "send_email or http_request", or "One of 3 tools". */
function sendTools(tools: readonly string[]): { pre: string; val: string } {
  return tools.length <= 2 ? { pre: '', val: tools.join(' or ') } : { pre: 'One of ', val: `${tools.length} tools` };
}
const OFF_LIST = ' sends to a domain that isn’t on the list';

/** The two reserved Seen values (engine send_seen): never a domain, never added. */
export const SEEN_NONE = '(none)';
export const SEEN_UNREADABLE = '(unreadable)';
export const SEEN_RESERVED_TEXT: Record<string, string> = { [SEEN_NONE]: 'No domain found', [SEEN_UNREADABLE]: 'Couldn’t read the domain' };

/** Whether an allowed entry covers a host: the same, or a subdomain of it (DLP spec 5.1). */
export function domainAllows(entry: string, host: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

/** A Seen row that can go on the list: a real domain, not one the cleaner rewrote (the engine's canAdd). */
export const canAddSeen = (row: SendSeenRow) => row.canAdd !== false && !Object.hasOwn(SEEN_RESERVED_TEXT, row.domain);

/** The Seen rows still to show under a list being edited: those it doesn't allow yet. Reserved rows always stay. */
export function seenNotOnList(rows: readonly SendSeenRow[], domains: readonly string[]): SendSeenRow[] {
  return rows.filter((r) => !canAddSeen(r) || !domains.some((d) => domainAllows(d, r.domain)));
}

/** Listed tools that made calls with no domain the engine could read: Block would stop every call they make. */
export function toolsWithNoDomain(rows: readonly SendSeenRow[], tools: readonly string[]): string[] {
  return [...new Set(rows.filter((r) => r.domain === SEEN_NONE && tools.includes(r.tool)).map((r) => r.tool))];
}

/** The line under Seen when no more rows are added; null while there's room. */
export function seenFullLine(res: { rows: readonly unknown[]; full?: boolean; fleetFull?: boolean }): string | null {
  // The engine's flag decides; the row count only stands in when an engine leaves the flag out.
  if (res.full === true || (res.full === undefined && res.rows.length >= SEEN_FULL_AT)) return `More than ${SEEN_FULL_AT} domains seen. Showing the first ${SEEN_FULL_AT}.`;
  if (res.fleetFull) return 'Your fleet has seen too many domains to list more. New ones aren’t shown.';
  return null;
}

/** A typed domain as the list stores it: trimmed, lower case, without one trailing dot. */
export const domainEntry = (typed: string) => typed.trim().toLowerCase().replace(/\.$/, '');

/** An IP address in any spelling the engine refuses: every label a number, decimal, octal or 0x hex (`10.0.0.1`, `2130706433`, `0x7f.1`). */
const NUMERIC_HOST = /^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*\.?$/;

/**
 * Why a typed entry can't go on the list, in plain words, or null. The same
 * refusals as the engine's save check (DLP spec 5.2): a scheme, port, path,
 * `*`, `@`, `%` or an IP address. A public suffix (`co.uk`) is the engine's to
 * refuse; its words come back through domainRefusal.
 */
export function domainProblem(typed: string, list: readonly string[]): string | null {
  const d = domainEntry(typed);
  if (!d) return null;
  if (list.includes(d)) return 'That domain is already on the list.';
  if (list.length >= SEND_DOMAINS_MAX) return `A rule allows up to ${SEND_DOMAINS_MAX} domains. Remove one to add another.`;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(d) || /^(https?|mailto):/.test(d)) return 'Type just the domain, like acme.com, without https://.';
  if (d.includes('@')) return 'Type the domain, not an address: acme.com, not bob@acme.com.';
  if (d.includes('*')) return 'Leave out the *. acme.com already covers mail.acme.com.';
  if (d.includes('%')) return 'A domain can’t have a % in it.';
  if (NUMERIC_HOST.test(d) || d.includes('[') || (d.match(/:/g) ?? []).length > 1) return 'Use a domain name, not an IP address.';
  if (/:\d*$/.test(d) || /:\d+[/?#]/.test(d)) return 'Leave out the port. Type just the domain, like acme.com.';
  if (/[/?#\\]/.test(d)) return 'Leave out the path. Type just the domain, like acme.com.';
  if (/\s/.test(d) || !/^[a-z0-9_.-]+$/.test(d) && !/[^\x00-\x7f]/.test(d)) return 'That isn’t a domain. Type one like acme.com.';
  return null;
}

/**
 * The engine's refusal of a domain on save, in the editor's plain words; the
 * engine's own words when it's about something else.
 */
export function domainRefusal(reason: string): string {
  // The engine names the entry first: `"co.uk": that ending is shared by many sites…`.
  // Only that form is one of its entry refusals: any other reason is shown in its own words.
  const named = /^"([^"]{1,80})":\s*([\s\S]*)$/.exec(reason);
  const plain = named ? refusalWords(named[2]) : null;
  return plain && named ? `“${named[1]}”: ${plain}` : reason;
}

function refusalWords(reason: string): string | null {
  const r = reason.toLowerCase();
  // The engine's entry refusals (E7 ENTRY_REFUSALS), matched on their own phrasings.
  if (r.startsWith('that isn\'t a domain') || r.startsWith('that isn’t a domain')) return 'That isn’t a domain. Type one like acme.com.';
  if (r.startsWith('that ending is shared by many sites')) return 'That ending is shared by many sites, like co.uk. Type the full domain, like acme.co.uk.';
  if (r.startsWith('enter a domain, not an ip address')) return 'Use a domain name, not an IP address.';
  if (r.startsWith('enter a domain, not an email address')) return 'Type the domain, not an address: acme.com, not bob@acme.com.';
  if (r.startsWith('enter just the domain, without http://')) return 'Type just the domain, like acme.com, without https://.';
  if (r.startsWith('enter the domain without a port')) return 'Leave out the port. Type just the domain, like acme.com.';
  if (r.startsWith('enter the domain without a path')) return 'Leave out the path. Type just the domain, like acme.com.';
  if (r.startsWith('enter the domain without *')) return 'Leave out the *. acme.com already covers mail.acme.com.';
  return null;
}

/** Name parts of a tool that sends data out. Used only to order and pre-pick tools, never to decide a call. */
const SENDS = new Set(['send', 'sends', 'post', 'posts', 'http', 'https', 'email', 'emails', 'upload', 'uploads']);

/** Whether a tool's name has a part like send, post, http, email or upload: `send_email` and `http_request` do, `postgres_query` doesn't. */
export function looksLikeSender(tool: string): boolean {
  return nameParts(tool).some((p) => SENDS.has(p));
}

/** The fleet's tools that look like they send data out, as many as the rule holds. */
export const sendLookingTools = (tools: readonly string[]) => tools.filter(looksLikeSender).slice(0, SEND_TOOLS_MAX);

// ── Outside content, then send data (DLP spec 3.3, 5.3) ────────────

/** The engine's limit on each of an Outside content, then send data rule's two lists. */
export const FLOW_TOOLS_MAX = TOOLS_PER_LIST;

/** The rule as one sentence, the same in the row and under When. */
export const FLOW_WHEN = 'An agent reads outside content, then tries to send data out in the same run';

/** Name parts of a tool that reads outside content. Used only to order and pre-pick tools, never to decide a call. */
const READS = new Set(['fetch', 'fetches', 'inbox', 'browse', 'browses', 'browser', 'scrape', 'scrapes']);

/** Whether a tool's name has a part like fetch, inbox, browse or scrape: `web_fetch` and `read_inbox` do, `fetcher_config` doesn't. */
export function looksLikeReader(tool: string): boolean {
  return nameParts(tool).some((p) => READS.has(p));
}

/** The fleet's tools that look like they read outside content, as many as the rule holds. */
export const readLookingTools = (tools: readonly string[]) => tools.filter(looksLikeReader).slice(0, FLOW_TOOLS_MAX);

// ── Data deletion ───────────────────────────────────────────────────

/** The engine's limit on a Data deletion rule's tools. */
export const COMMAND_TOOLS_MAX = TOOLS_PER_LIST;

/** The docs' list of what the rule catches and what it doesn't. */
export const DELETION_DOCS_URL = 'https://whiteroom.tech/docs.html#data-deletion';

/** Name parts of a tool that runs commands or SQL. Used only to order and pre-pick tools, never to decide a call. */
const RUNS_COMMANDS = new Set(['sql', 'query', 'queries', 'database', 'db', 'bash', 'shell', 'sh', 'exec', 'execute', 'command', 'commands', 'cmd', 'terminal']);

/** Whether a tool's name has a part like sql, query, bash, shell, exec or command: `run_sql` and `bashTool` do, `shellfish_menu` doesn't. */
export function looksLikeCommandRunner(tool: string): boolean {
  return nameParts(tool).some((p) => RUNS_COMMANDS.has(p));
}

/** The fleet's tools that look like they run commands or SQL, as many as the rule holds. */
export const commandLookingTools = (tools: readonly string[]) => tools.filter(looksLikeCommandRunner).slice(0, COMMAND_TOOLS_MAX);

// ── Old tool results ────────────────────────────────────────────────

/**
 * Old tool results edits what goes to the model. It holds the notify response
 * (the engine's fixed value for it) but never alerts or blocks, so wherever a
 * response is put into words or counted, it has its own: trimmed.
 */
export const trims = (r: { ruleType?: string }) => r.ruleType === 'trim_results';

/**
 * Model routing never blocks or alerts either (its response is the engine's
 * fixed notify), and in this version it only watches: wherever a count or an
 * outcome is put into words, it has its own.
 */
export const routes = (r: { ruleType?: string }) => r.ruleType === 'model_route';
/** Old tool results and Model routing change the request that goes out. They hold the notify response and never alert or block. */
const changesRequest = (r: { ruleType?: string }) => trims(r) || routes(r);
/**
 * Rules as the page reads them. A Model routing rule set to Enforce on a fleet where Enforce isn't
 * offered changes no call either, so it reads the same as one that suspended itself: acting as Watch.
 */
export function readRules(rules: GovernanceRule[], routeEnforce: boolean): GovernanceRule[] {
  if (routeEnforce) return rules;
  return rules.map((r) => (routes(r) && r.mode === 'enforce' ? { ...r, params: { ...(r.params as ModelRouteParams), suspended: true as const } } : r));
}

/** A suspended rule's tag, where another rule's says Enforce. */
export const SUSPENDED_TAG = 'Suspended';
/** A Model routing rule that stopped changing calls on its own: it acts as Watch until someone turns it back on. */
export const suspended = (r: Pick<GovernanceRule, 'ruleType' | 'params' | 'mode'>) => routes(r) && r.mode === 'enforce' && (r.params as ModelRouteParams).suspended === true;

/** A Model routing rule's model list, strongest first. One read for every use: a rule that came in with none has an empty list, not a missing one. */
export const ladderOf = (p: ModelRouteParams): LadderEntry[] => p.ladder ?? [];
/** Whether the engine takes a careful list for this rule: it sends one, empty or not, when it does. */
export const takesCareful = (p: ModelRouteParams): boolean => Array.isArray(p.carefulTools);
export const carefulOf = (p: ModelRouteParams): string[] => p.carefulTools ?? [];
/** What the editor holds and Save sends for Model routing: the model list, and the careful list where the engine takes one. */
const routeHeld = (p: ModelRouteParams): ModelRouteParams => ({ ladder: ladderOf(p), ...(takesCareful(p) && { carefulTools: carefulOf(p) }) });
export const CAREFUL_TOOLS_MAX = 50;
export const CAREFUL_TOOL_MAX_CHARS = 128;
/** A careful entry the engine would refuse: a space or a character that doesn't show, or a "*" anywhere but the end of a name. */
export const carefulEntryBad = (entry: string): boolean => /[\s\p{C}]/u.test(entry) || entry === '*' || entry.slice(0, -1).includes('*');
/** Its models as the request names them. */
export const ladderIds = (p: ModelRouteParams): string[] => ladderOf(p).map((e) => (typeof e === 'string' ? e : e.id));
/** A ladder needs two models before there is a cheaper one to compare with. */
const LADDER_MIN = 2;
/** The most models a Model routing rule lists (the engine's limit). */
export const LADDER_MAX = 5;
/** The ladder as it reads in a sentence: "claude-opus-5-5 → claude-sonnet-5-5". */
const ladderText = (p: ModelRouteParams) => ladderIds(p).join(' → ');

/** "the newest 5 turns", "the newest turn". */
const newest = (n: number) => (n === 1 ? 'the newest turn' : `the newest ${fmtCount(n)} turns`);

/**
 * The rule as one sentence, split so the values can be set in mono. Only a
 * rule in Enforce does what it says; in Watch or Off it "would", so the
 * sentence never claims a call is stopped when it isn't.
 */
export function ruleSentence(rule: Pick<GovernanceRule, 'ruleType' | 'params' | 'response' | 'alsoNotify'> & { mode?: GovernanceRule['mode'] }): { pre: string; val: string; post: string } {
  const response = rule.response ?? 'block';
  const does = response === 'block' && rule.alsoNotify ? `block the call and ${NOTIFY.verb}` : VERB[response];
  const v = rule.mode === undefined || rule.mode === 'enforce' ? does : `it would ${does}`;
  switch (rule.ruleType) {
    case 'spend_cap': {
      const p = rule.params as SpendCapParams;
      return { pre: 'When an agent spends more than ', val: money(p), post: ` in a ${p.scope}, ${v}.` };
    }
    case 'loop_breaker': {
      const p = rule.params as LoopBreakerParams;
      return { pre: 'When an agent makes the same call ', val: fmtCount(p.threshold), post: ` times in a ${p.scope}, ${v}.` };
    }
    case 'call_rate':
      return { pre: 'When an agent makes more than ', val: fmtCount((rule.params as CallRateParams).maxCalls), post: ` calls in a minute, ${v}.` };
    case 'keyword': {
      const p = rule.params as KeywordParams;
      // Without the dashboard's secret the engine sends only how many there are.
      if (!p.keywords.length && p.keywordCount) {
        return p.keywordCount === 1
          ? { pre: `When ${KEYWORD_WHERE[p.where]} contains `, val: 'a hidden keyword', post: `, ${v}.` }
          : { pre: `When ${KEYWORD_WHERE[p.where]} contains any of `, val: `${p.keywordCount} hidden keywords`, post: `, ${v}.` };
      }
      return p.keywords.length
        ? { pre: `When ${KEYWORD_WHERE[p.where]} contains ${p.keywords.length > 1 ? 'any of ' : ''}`, val: keywordsText(p.keywords, (k) => `“${k}”`), post: `, ${v}.` }
        : { pre: 'No keywords picked yet.', val: '', post: '' };
    }
    case 'tool_list': {
      const tools = (rule.params as ToolListParams).blockedTools;
      return tools.length ? { pre: 'When an agent is about to run ', val: tools.join(', '), post: `, ${v}.` } : { pre: 'No tools picked yet.', val: '', post: '' };
    }
    case 'model_allowlist': {
      const models = (rule.params as ModelAllowlistParams).allowedModels;
      return models.length ? { pre: 'Only allow ', val: models.join(', '), post: `. For any other model, ${v}.` } : { pre: 'No models picked yet.', val: '', post: '' };
    }
    case 'send_limit': {
      const tools = (rule.params as SendLimitParams).tools;
      if (!tools.length) return { pre: 'No tools picked yet.', val: '', post: '' };
      const t = sendTools(tools);
      return { pre: `When ${t.pre ? t.pre.toLowerCase() : ''}`, val: t.val, post: `${OFF_LIST}, ${v}.` };
    }
    case 'outside_then_send':
      return (rule.params as OutsideThenSendParams).sendTools.length
        ? { pre: `When ${FLOW_WHEN[0].toLowerCase()}${FLOW_WHEN.slice(1)}, ${v}.`, val: '', post: '' }
        : { pre: 'No send tools picked yet.', val: '', post: '' };
    case 'data_deletion':
      return (rule.params as DataDeletionParams).commandTools.length
        ? { pre: `When an agent is asked to run a command that deletes from a database or a cloud account, ${v}.`, val: '', post: '' }
        : { pre: 'No tools picked yet.', val: '', post: '' };
    case 'block_streak':
      return { pre: 'When an agent has ', val: fmtCount((rule.params as BlockStreakParams).threshold), post: ` calls in a row blocked in a run, ${v}.` };
    case 'trim_results': {
      const p = rule.params as TrimResultsParams;
      const removes = `remove tool results older than ${newest(p.keepRecent)}`;
      return { pre: 'When a request is about ', val: `${fmtCount(p.minTokens)} tokens`, post: ` or more, ${rule.mode === undefined || rule.mode === 'enforce' ? removes : `it would ${removes}`}.` };
    }
    case 'model_route': {
      const p = rule.params as ModelRouteParams;
      // A rule that suspended itself changes no call: it reads as it acts.
      const does = rule.mode === 'enforce' && p.suspended !== true ? 'Send calls that can use a cheaper model to it.' : 'Record the calls that could use a cheaper model.';
      return ladderOf(p).length ? { pre: `${does} Models, strongest first: `, val: ladderText(p), post: '.' } : { pre: 'No models picked yet.', val: '', post: '' };
    }
    default:
      return unhandledType(rule.ruleType, { pre: UNKNOWN_RULE, val: '', post: '' });
  }
}

export const ruleSentenceText = (rule: Parameters<typeof ruleSentence>[0]) => { const s = ruleSentence(rule); return s.pre + s.val + s.post; };

/** Who a change covers, said in a confirm dialog. */
export function appliesNow(scope: GovernanceScope): string {
  return `It applies to ${scope === 'all' ? 'all agents in this fleet' : scope.join(', ')}, and takes effect now.`;
}

// ── Grouping and the agent filter ───────────────────────────────────

/** The rules that govern an agent: the fleet-wide ones and its own. `null`: every rule. */
export function rulesFor<R extends Pick<GovernanceRule, 'appliesTo'>>(rules: readonly R[], agent: string | null): R[] {
  return agent === null ? [...rules] : rules.filter((r) => r.appliesTo === 'all' || r.appliesTo.includes(agent));
}

/** Category first (Cost & reliability, then Data protection), then how strongly the rule acts, then its type. */
function ruleOrder(a: GovernanceRule, b: GovernanceRule): number {
  const by = categoryRank(a.ruleType) - categoryRank(b.ruleType) || strengthRank(a) - strengthRank(b) || typeRank(a.ruleType) - typeRank(b.ruleType);
  if (by || a.ruleType !== 'spend_cap') return by;
  const pa = a.params as SpendCapParams, pb = b.params as SpendCapParams;
  return pa.scope.localeCompare(pb.scope) || pa.unit.localeCompare(pb.unit) || pa.dailyCap - pb.dailyCap;
}

/** The order rules of equal strength are listed in on Controls: each category's types together. Its own list, so the Add-a-rule choices can change without moving rows. */
export const RULE_ROW_ORDER: readonly GovernanceRuleType[] = ['spend_cap', 'call_rate', 'model_allowlist', 'loop_breaker', 'block_streak', 'trim_results', 'model_route', 'tool_list', 'keyword', 'send_limit', 'outside_then_send', 'data_deletion'];

/** The categories in the order Controls lists them. A type this build doesn't know goes last. */
export const CATEGORY_ORDER: readonly string[] = ['Cost & reliability', 'Data protection'];

function categoryRank(t: GovernanceRuleType): number {
  const i = CATEGORY_ORDER.indexOf(RULE_CATEGORY[t]);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

/** Strongest first: Stop, Pause, Block, Only alert me, Watch, Off. Trimming changes the call, so it sits with Block. */
function strengthRank(r: Pick<GovernanceRule, 'mode' | 'response' | 'ruleType' | 'params'>): number {
  // A rule that suspended itself changes no call: it sorts with Watch.
  if (r.mode !== 'enforce' || suspended(r)) return r.mode === 'off' ? 5 : 4;
  return changesRequest(r) ? 2 : 3 - RESPONSE_RANK[r.response ?? 'block'];
}

function typeRank(t: GovernanceRuleType): number {
  const i = RULE_ROW_ORDER.indexOf(t);
  return i < 0 ? RULE_ROW_ORDER.length : i;
}

// ── Overlap ─────────────────────────────────────────────────────────

const covers = (a: GovernanceScope, b: GovernanceScope) => a === 'all' || (b !== 'all' && b.every((x) => a.includes(x)));

/**
 * Two spend caps that do the same thing (same unit, period, mode, response
 * and alert), where the lower one covers every agent the higher one does:
 * then the higher one never acts. A $190 Only alert me and a $200 Block is a
 * warning before a stop, not an overlap; nor is a fleet-wide $500 beside a
 * $190 cap for one agent.
 */
export function spendOverlap(rules: readonly GovernanceRule[]): { never: GovernanceRule; first: GovernanceRule } | null {
  // Only caps that block: in Watch neither acts, and an alert before a block is a warning, not an overlap.
  const caps = rules.filter((r) => r.ruleType === 'spend_cap' && r.mode === 'enforce' && (r.response ?? 'block') !== 'notify');
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
/** What an enforced rule did this week: Old tool results counts under trimmed (0 from an engine that doesn't send it), never under its response. */
const enforcedCount = (rule: Pick<GovernanceRule, 'ruleType' | 'response'>, week: RuleActionCounts) => (trims(rule) ? week.trimmed ?? 0 : routes(rule) ? week.routed ?? 0 : week[TALLY[rule.response ?? 'block']] ?? 0);
const times = (n: number) => (n === 1 ? 'once' : `${fmtCount(n)} times`);
/** A rule (or agent) with no actions. */
export const NO_ACTIONS: RuleActionCounts = { blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 };

/** A Keywords or Tool list rule with nothing picked can never act: what it still needs. */
export function emptyPick(rule: Pick<GovernanceRule, 'ruleType' | 'params'>): string | null {
  switch (rule.ruleType) {
    case 'keyword': return keywordTotal(rule.params as KeywordParams) ? null : 'a keyword';
    case 'tool_list': return (rule.params as ToolListParams).blockedTools.length ? null : 'a tool';
    // The engine skips an allowlist with no models (it would refuse every call), so it does nothing yet.
    case 'model_allowlist': return (rule.params as ModelAllowlistParams).allowedModels.length ? null : 'a model';
    // No tools is "Not set up" (DLP spec 5.2). No domains is a real rule: everything those tools send is off the list.
    case 'send_limit': return (rule.params as SendLimitParams).tools.length ? null : 'a tool';
    // No send tools is "Not set up" (DLP spec 5.3). No read tools is a real rule: the provider's web search and fetch always count.
    case 'outside_then_send': return (rule.params as OutsideThenSendParams).sendTools.length ? null : 'a send tool';
    case 'data_deletion': return (rule.params as DataDeletionParams).commandTools.length ? null : 'a tool';
    case 'model_route': { const n = ladderOf(rule.params as ModelRouteParams).length; return n >= LADDER_MIN ? null : n ? 'a second model' : 'two models'; }
    case 'spend_cap': case 'loop_breaker': case 'call_rate': case 'block_streak': case 'trim_results': return null;
    default: return unhandledType(rule.ruleType, null);
  }
}

// ── What the agent gets ─────────────────────────────────────────────

// Repeated blocks, Old tool results and Model routing never block a call themselves, so they have no reason of their own.
const REASON: Record<Exclude<GovernanceRuleType, 'block_streak' | 'trim_results' | 'model_route'>, string> = {
  spend_cap: 'budget_exceeded', loop_breaker: 'loop_detected', model_allowlist: 'model_not_allowed', tool_list: 'tool_not_allowed', call_rate: 'rate_exceeded',
  keyword: 'keyword_found', send_limit: 'destination_not_allowed', outside_then_send: 'outside_then_send', data_deletion: 'data_deletion',
};

/** The engine's 403 for this rule (blockResponseBody); nothing for Only alert me. */
export function agentGets(rule: Pick<GovernanceRule, 'ruleType' | 'params' | 'response'> & { mode?: GovernanceMode }): string {
  const response = rule.response ?? 'block';
  if (rule.ruleType === 'trim_results') return 'Nothing: the call goes through.\nOld tool results in it are replaced with a short note.';
  if (rule.ruleType === 'model_route') return rule.mode === 'enforce' && (rule.params as ModelRouteParams).suspended !== true ? 'The reply, from a cheaper model on your list when the call can use one.\nNothing else changes.' : 'Nothing: the call goes through unchanged.';
  if (rule.ruleType === 'block_streak') {
    // The call that reaches the limit was blocked by another rule: that rule's 403 is what the agent gets.
    const then = response === 'notify' ? 'You get an alert; the agent doesn’t.' : `Then the agent is ${response === 'stop' ? 'stopped' : 'paused'} until someone resumes it.`;
    return `Nothing new: the blocked call fails with the other rule’s reason.\n${then}`;
  }
  if (response === 'notify') return 'Nothing: the call goes through.\nYou get an alert; the agent doesn’t.';
  const held = response === 'pause' || response === 'stop';
  const resets = held ? 'when someone resumes it' : resetsWhen(rule);
  // A data rule's body says only that it blocked: no list, no limit (DLP spec 5.2).
  // A blocked delete names the tool and the kind of delete, never the command. Only Block says what to do next: a held agent has no next step.
  const message = rule.ruleType === 'send_limit' ? '\nmessage: A data rule blocked this call.'
    : rule.ruleType === 'data_deletion' ? `\nmessage: <tool> was asked to <kind of delete>.${held ? '' : ' Choose a step that can be undone, or ask a person.'}` : '';
  return `403 governance_block${message}\nresponse: ${response}\nreason: ${REASON[rule.ruleType]}\nretryable: ${!held && rule.ruleType === 'call_rate'}\nresets: ${resets}`;
}

function resetsWhen(rule: Pick<GovernanceRule, 'ruleType' | 'params'>): string {
  switch (rule.ruleType) {
    case 'call_rate': return 'once the last minute is back under the limit';
    case 'model_allowlist': case 'tool_list': case 'keyword': case 'send_limit': case 'outside_then_send': case 'block_streak': case 'trim_results': case 'data_deletion': case 'model_route': return 'never';
    case 'spend_cap': case 'loop_breaker': return (rule.params as SpendCapParams | LoopBreakerParams).scope === 'day' ? 'next day (00:00 UTC)' : 'next run';
    default: return unhandledType(rule.ruleType, 'never');
  }
}

export const AGENT_NOTE: Record<GovernanceRuleType, string> = {
  spend_cap: 'Stops before the next call. Non-retryable, so SDKs should not retry.',
  loop_breaker: 'Stops after the repeated call. Non-retryable within the same run.',
  model_allowlist: 'Stops before the call. The agent must switch to an allowed model.',
  call_rate: 'Stops the call that goes over the limit. Refused calls count too, so an agent that keeps retrying stays over until it slows down.',
  tool_list: 'Stops the model’s reply before the agent gets it, so the tool never runs. You still pay for that model call.',
  keyword: 'Stops the call before the model sees it, or the reply before the agent does. The agent isn’t told which keyword matched.',
  send_limit: 'Stops the model’s reply before the agent gets it, so the tool never sends. The agent isn’t told the list.',
  // Only alerts (DLP spec 5.3), so this never shows: What the agent sees is "Nothing".
  outside_then_send: 'It never stops a call.',
  block_streak: 'Acts after the blocked call that reaches the limit.',
  // Never stops a call, so this never shows.
  trim_results: 'It never stops a call.',
  model_route: 'It never stops a call.',
  data_deletion: 'Stops the model’s reply before the agent gets it, so the command never runs. You still pay for that model call.',
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
  /** The number the person is typing (spend cap, loop threshold, calls a minute, blocks in a row, turns to keep). */
  number: string;
  /** Old tool results only: its second number, the request size in tokens. */
  number2?: string;
}

const numberOf = (rule: Pick<GovernanceRule, 'ruleType' | 'params'>): string => {
  switch (rule.ruleType) {
    case 'spend_cap': return String((rule.params as SpendCapParams).dailyCap);
    case 'loop_breaker': return String((rule.params as LoopBreakerParams).threshold);
    case 'call_rate': return String((rule.params as CallRateParams).maxCalls);
    case 'block_streak': return String((rule.params as BlockStreakParams).threshold);
    case 'trim_results': return String((rule.params as TrimResultsParams).keepRecent);
    case 'model_allowlist': case 'tool_list': case 'keyword': case 'send_limit': case 'outside_then_send': case 'data_deletion': case 'model_route': return '';
    default: return unhandledType(rule.ruleType, '');
  }
};
const number2Of = (rule: Pick<GovernanceRule, 'ruleType' | 'params'>): string => (rule.ruleType === 'trim_results' ? String((rule.params as TrimResultsParams).minTokens) : '');

export function draftFrom(rule: GovernanceRule): RuleDraft {
  return {
    ruleType: rule.ruleType, mode: rule.mode, response: typeResponse(rule.ruleType, rule.response), alsoNotify: !!rule.alsoNotify,
    appliesTo: rule.appliesTo === 'all' ? 'all' : [...rule.appliesTo],
    // Model routing: the editor holds, and Save sends, the model list and (where the engine takes one) the careful list.
    params: JSON.parse(JSON.stringify(rule.ruleType === 'model_route' ? routeHeld(rule.params as ModelRouteParams) : rule.params)) as GovernanceParams,
    number: numberOf(rule),
    ...(rule.ruleType === 'trim_results' && { number2: number2Of(rule) }),
  };
}

const HAS_NUMBER: Record<GovernanceRuleType, boolean> = { spend_cap: true, loop_breaker: true, call_rate: true, model_allowlist: false, tool_list: false, keyword: false, send_limit: false, outside_then_send: false, block_streak: true, trim_results: true, data_deletion: false, model_route: false };
const hasNumber = (t: GovernanceRuleType) => HAS_NUMBER[t] === true;

/**
 * A typed number: digits and a decimal point, with commas only between
 * thousands ("1,500"), so "1,5" isn't read as 15 and "0x10" or "1e3" aren't
 * numbers at all; NaN otherwise.
 */
export function typedNumber(text: string): number {
  const t = text.trim();
  return /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t) ? Number(t.replace(/,/g, '')) : NaN;
}

const wholeIn = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
/** The engine's ranges for Repeated blocks and Old tool results, for a typed number and for a kept draft's params alike. */
export const streakFits = (n: unknown) => wholeIn(n, 2, 100);
export const trimTurnsFit = (n: unknown) => wholeIn(n, 1, 100);
export const trimTokensFit = (n: unknown) => wholeIn(n, 1_000, 10_000_000);

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
  if (d.ruleType === 'block_streak') {
    return streakFits(n) ? { params: { threshold: n } } : { error: 'Enter a whole number from 2 to 100.' };
  }
  if (d.ruleType === 'trim_results') {
    const tokens = typedNumber(d.number2 ?? '');
    if (!trimTokensFit(tokens)) return { error: 'Enter a whole number of tokens from 1,000 to 10,000,000.' };
    if (!trimTurnsFit(n)) return { error: 'Enter a whole number of turns from 1 to 100.' };
    return { params: { keepRecent: n, minTokens: tokens } };
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
  if ('error' in draftParams(d)) return d.number.trim() !== numberOf(rule) || (d.number2 ?? '').trim() !== number2Of(rule);
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

/** Whether the rule, as drafted, sends an alert when it acts: Only alert me, Pause, Stop, or Block with an alert. Old tool results never does. */
export function sendsAlert(d: Pick<RuleDraft, 'mode' | 'response' | 'alsoNotify'> & { ruleType?: GovernanceRuleType }): boolean {
  return d.mode === 'enforce' && !changesRequest(d) && (d.response !== 'block' || d.alsoNotify);
}

/** A new response; "Also alert me" only applies to Block, so it's cleared otherwise. */
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
  // A list the engine hid (domainCount) is never written back: it would save an empty list over the real one.
  // Model routing is compared on what the editor holds, so a rule isn't "unsaved" the moment it opens.
  const saved = routes(rule) ? routeHeld(rule.params as ModelRouteParams) : rule.params;
  if (!same(p.params, saved) && !domainsHidden(rule)) out.params = p.params;
  return Object.keys(out).length ? out : null;
}

/** Why Save can't go ahead yet, or null. */
export function draftProblem(d: RuleDraft, opts: { /** Whether the engine takes Enforce for Model routing on this fleet. */ routeEnforce?: boolean } = {}): string | null {
  const p = draftParams(d);
  if ('error' in p) return p.error;
  if (d.ruleType === 'send_limit') {
    const s = p.params as SendLimitParams;
    if (s.tools.length > SEND_TOOLS_MAX) return toolsFull(SEND_TOOLS_MAX);
    if (s.domains.length > SEND_DOMAINS_MAX) return `A rule allows up to ${SEND_DOMAINS_MAX} domains. Remove one to save.`;
  }
  if (d.ruleType === 'outside_then_send') {
    const f = p.params as OutsideThenSendParams;
    if (f.readTools.length > FLOW_TOOLS_MAX || f.sendTools.length > FLOW_TOOLS_MAX) return `A rule holds up to ${FLOW_TOOLS_MAX} tools in each list. Remove one to save.`;
    // The engine refuses any other response for this type (DLP spec 5.3).
    if (d.response !== 'notify') return 'This rule can only alert you.';
  }
  if (d.ruleType === 'data_deletion' && (p.params as DataDeletionParams).commandTools.length > COMMAND_TOOLS_MAX) return toolsFull(COMMAND_TOOLS_MAX);
  if (d.ruleType === 'model_route') {
    // The engine refuses each of these: routing is turned on agent by agent, and enforces only where that is turned on.
    // Turning it off needs no agents: a rule with none picked yet can still be switched off.
    if (d.appliesTo === 'all' || (d.appliesTo.length === 0 && d.mode !== 'off')) return 'Pick the agents this rule covers.';
    if (d.mode === 'enforce' && !opts.routeEnforce) return 'This rule runs in Watch for now.';
    // The engine refuses a list of one model, or of more than five, in any mode: these hold for Off too.
    const models = ladderOf(p.params as ModelRouteParams).length;
    if (models === 1) return 'Add a second model, cheaper than the first.';
    if (models > LADDER_MAX) return `A rule holds up to ${LADDER_MAX} models. Remove one to save.`;
    const careful = carefulOf(p.params as ModelRouteParams);
    if (careful.length > CAREFUL_TOOLS_MAX) return toolsFull(CAREFUL_TOOLS_MAX);
    const bad = careful.find(carefulEntryBad);
    if (bad !== undefined) return `"${bad}" can't be saved. A tool name has no spaces, and * only ends one.`;
  }
  if (d.appliesTo !== 'all' && d.appliesTo.length === 0 && !routes(d)) return 'Pick at least one agent, or choose All agents.';
  if (d.mode !== 'enforce') return null;
  switch (d.ruleType) {
    case 'model_allowlist': return (p.params as ModelAllowlistParams).allowedModels.length === 0 ? 'Pick at least one model before you turn on Enforce.' : null;
    case 'tool_list': return (p.params as ToolListParams).blockedTools.length === 0 ? 'Pick at least one tool before you turn on Enforce.' : null;
    case 'keyword': return keywordTotal(p.params as KeywordParams) === 0 ? 'Pick at least one keyword before you turn on Enforce.' : null;
    case 'send_limit': return (p.params as SendLimitParams).tools.length === 0 ? 'Pick at least one tool before you turn on Enforce.' : null;
    case 'outside_then_send': return (p.params as OutsideThenSendParams).sendTools.length === 0 ? 'Pick at least one tool under Sends data out before you turn on Enforce.' : null;
    case 'data_deletion': return (p.params as DataDeletionParams).commandTools.length === 0 ? 'Pick at least one tool before you turn on Enforce.' : null;
    case 'spend_cap': case 'loop_breaker': case 'call_rate': case 'block_streak': case 'trim_results': case 'model_route': return null;
    // Never saved: the editor doesn't open a rule of a type it doesn't know.
    default: return unhandledType(d.ruleType, UNKNOWN_RULE);
  }
}

// ── Add a rule ──────────────────────────────────────────────────────

/** "Add a rule" choices, by category in the order the rows use (Cost & reliability, then Data protection), then by goal. */
export const RULE_TEMPLATES: { type: GovernanceRuleType; title: string; desc: string }[] = [
  { type: 'spend_cap', title: 'Cap spending', desc: 'Block calls once an agent spends more than you set in a run or a day.' },
  { type: 'call_rate', title: 'Limit calls per minute', desc: 'Block calls once an agent makes too many in a minute.' },
  { type: 'model_allowlist', title: 'Allow only certain models', desc: 'Block calls to any model you haven’t picked.' },
  { type: 'loop_breaker', title: 'Break loops', desc: 'Catch an agent making the same call over and over.' },
  { type: 'block_streak', title: 'Act on repeated blocks', desc: 'Catch an agent that keeps making calls your rules block.' },
  { type: 'trim_results', title: 'Trim old tool results', desc: 'Keep long conversations short by removing old tool results before they go to the model.' },
  { type: 'model_route', title: 'Find calls that could use a cheaper model', desc: 'List the models your agents may use, strongest first, and see which calls could use a cheaper one.' },
  { type: 'tool_list', title: 'Block tools', desc: 'Keep agents from running tools you name.' },
  { type: 'keyword', title: 'Flag keywords', desc: 'Get an alert, or block the call, when words you pick show up.' },
  { type: 'send_limit', title: 'Limit where tools can send data', desc: 'For example, email only to your own domain.' },
  { type: 'outside_then_send', title: 'Flag sends after outside content', desc: 'Get an alert when an agent reads a web page, email or file, then tries to send data out.' },
  { type: 'data_deletion', title: 'Stop agents deleting data', desc: 'For example, a dropped table or an emptied storage bucket.' },
];

/** The Add a rule choices this engine takes (governance_list ruleTypes): an engine without a new type never gets offered it. */
export const offeredTemplates = (ruleTypes: readonly string[] | undefined) => RULE_TEMPLATES.filter((t) => engineTakes(t.type, ruleTypes));

// ── Groups: who a rule covers ───────────────────────────────────────

/**
 * Whether a rule can stop a call or an agent now: Enforce with a response other than Only alert me, that has something to act on.
 * Never Repeated blocks: it acts only after another rule blocked, so on its own every call goes through.
 */
export function isStopping(r: GovernanceRule): boolean {
  return r.ruleType !== 'block_streak' && r.mode === 'enforce' && (r.response ?? 'block') !== 'notify' && !emptyPick(r);
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
  if (next.mode === 'enforce' && prev.mode === 'enforce' && RESPONSE_RANK[nr] < RESPONSE_RANK[pr]) out.push(`When enforced: ${VERB[pr]} → ${VERB[nr]}`);
  // Any lost alert, whatever the response: Pause, Stop and Only alert me alert; Block does when asked to.
  const alerts = (r: GovernanceRule) => r.mode === 'enforce' && !changesRequest(r) && ((r.response ?? 'block') !== 'block' || !!r.alsoNotify);
  if (alerts(prev) && !alerts(next) && MODE_RANK[next.mode] >= MODE_RANK[prev.mode]) out.push('It stops sending you an alert');
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
      const out: string[] = [];
      if (n.threshold > p.threshold) out.push(`Acts after ${fmtCount(n.threshold)} repeats instead of ${fmtCount(p.threshold)}`);
      // Per day and per run count differently: ask, as for a spend cap's period.
      if (n.scope !== p.scope) out.push(`Counts repeats in a ${n.scope} instead of a ${p.scope}`);
      const ignored = n.ignoreTools.filter((t) => !p.ignoreTools.includes(t));
      if (ignored.length) out.push(`No longer counts calls to ${ignored.join(', ')}`);
      return out;
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
      if (removed.length) out.push(`No longer looks for ${keywordsText(removed, (k) => `“${k}”`)}`);
      if (!p.wholeWord && n.wholeWord) out.push('Matches whole words only, not parts of words');
      const places = (w: KeywordParams['where']) => (w === 'both' ? ['incoming', 'replies'] : [w]);
      for (const gone of places(p.where).filter((x) => !places(n.where).includes(x))) out.push(`No longer looks in ${gone === 'incoming' ? 'incoming data' : 'model replies'}`);
      return out;
    }
    case 'send_limit': {
      // Building the list in Watch changes what nobody's calls do: it's asked about only in Enforce (DLP spec 3.2).
      if (prev.mode !== 'enforce' || domainsHidden(prev)) return [];
      const p = a as SendLimitParams, n = b as SendLimitParams;
      const out: string[] = [];
      const added = n.domains.filter((d) => !p.domains.includes(d));
      if (added.length) out.push(`Also allows ${added.join(', ')}`);
      const freed = p.tools.filter((t) => !n.tools.includes(t));
      if (freed.length) out.push(`No longer checks ${freed.join(', ')}`);
      return out;
    }
    case 'outside_then_send': {
      // It only alerts: fewer tools means fewer alerts, which matters only once it sends them (Enforce).
      if (prev.mode !== 'enforce') return [];
      const p = a as OutsideThenSendParams, n = b as OutsideThenSendParams;
      const out: string[] = [];
      const unread = p.readTools.filter((t) => !n.readTools.includes(t));
      if (unread.length) out.push(`No longer counts ${unread.join(', ')} as outside content`);
      const unsent = p.sendTools.filter((t) => !n.sendTools.includes(t));
      if (unsent.length) out.push(`No longer checks ${unsent.join(', ')}`);
      return out;
    }
    case 'data_deletion': {
      const freed = (a as DataDeletionParams).commandTools.filter((t) => !(b as DataDeletionParams).commandTools.includes(t));
      return freed.length ? [`No longer checks ${freed.join(', ')}`] : [];
    }
    case 'block_streak': {
      const p = a as BlockStreakParams, n = b as BlockStreakParams;
      return n.threshold > p.threshold ? [`Acts after ${fmtCount(n.threshold)} blocked calls in a row instead of ${fmtCount(p.threshold)}`] : [];
    }
    // It guards nothing: trimming less is never a weaker rule.
    case 'trim_results': return [];
    // Nor does a shorter list of models.
    case 'model_route': return [];
    default:
      return unhandledType(prev.ruleType, []);
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
  switch (rule.ruleType) {
    case 'spend_cap': {
      const p = rule.params as SpendCapParams;
      const per = p.scope === 'day' ? ' a day' : ' in a run';
      return p.unit === 'dollars' ? { pre: 'Over ', val: money(p), post: per } : { pre: 'Over ', val: fmtCount(p.dailyCap), post: ` tokens${per}` };
    }
    case 'loop_breaker': {
      const p = rule.params as LoopBreakerParams;
      return { pre: 'Same call ', val: fmtCount(p.threshold), post: `× in a ${p.scope}` };
    }
    case 'call_rate': return { pre: 'Over ', val: fmtCount((rule.params as CallRateParams).maxCalls), post: ' calls a minute' };
    case 'keyword': {
      const p = rule.params as KeywordParams;
      const where = KEYWORD_WHERE[p.where];
      const lead = `${where[0].toUpperCase()}${where.slice(1)} contains `;
      if (!p.keywords.length && p.keywordCount) return { pre: lead, val: p.keywordCount === 1 ? 'a hidden keyword' : `${p.keywordCount} hidden keywords`, post: '' };
      return p.keywords.length ? { pre: lead, val: keywordsText(p.keywords, (k) => `"${k}"`), post: '' } : { pre: 'No keywords picked yet', val: '', post: '' };
    }
    case 'tool_list': {
      const tools = (rule.params as ToolListParams).blockedTools;
      return tools.length ? { pre: 'Tools: ', val: tools.join(', '), post: '' } : { pre: 'No tools picked yet', val: '', post: '' };
    }
    case 'model_allowlist': {
      const models = (rule.params as ModelAllowlistParams).allowedModels;
      return models.length ? { pre: 'Only ', val: models.join(', '), post: '' } : { pre: 'No models picked yet', val: '', post: '' };
    }
    case 'send_limit': {
      const tools = (rule.params as SendLimitParams).tools;
      if (!tools.length) return { pre: 'No tools picked yet', val: '', post: '' };
      const t = sendTools(tools);
      return { pre: t.pre, val: t.val, post: OFF_LIST };
    }
    case 'outside_then_send':
      return (rule.params as OutsideThenSendParams).sendTools.length ? { pre: FLOW_WHEN, val: '', post: '' } : { pre: 'No send tools picked yet', val: '', post: '' };
    case 'data_deletion': {
      const n = (rule.params as DataDeletionParams).commandTools.length;
      return n ? { pre: 'A delete command on ', val: fmtCount(n), post: ` ${plural(n, 'tool')}` } : { pre: 'No tools picked yet', val: '', post: '' };
    }
    case 'block_streak': return { pre: 'Blocked ', val: fmtCount((rule.params as BlockStreakParams).threshold), post: '× in a row in a run' };
    case 'trim_results': {
      const p = rule.params as TrimResultsParams;
      return { pre: 'Tool results older than the newest ', val: fmtCount(p.keepRecent), post: ` ${plural(p.keepRecent, 'turn')}, once a request is about ${fmtCount(p.minTokens)} tokens` };
    }
    case 'model_route': {
      const p = rule.params as ModelRouteParams;
      return ladderOf(p).length ? { pre: 'Calls that could use a cheaper model, from ', val: ladderText(p), post: '' } : { pre: 'No models picked yet', val: '', post: '' };
    }
    default:
      return unhandledType(rule.ruleType, { pre: UNKNOWN_RULE, val: '', post: '' });
  }
}

export const ruleConditionText = (rule: Pick<GovernanceRule, 'ruleType' | 'params'>) => { const c = ruleCondition(rule); return c.pre + c.val + c.post; };

/** Who a rule covers, in a sentence: "all agents", "lead-agent", "lead-agent, code-reviewer". */
export const whoFor = (scope: GovernanceScope) => (scope === 'all' ? 'all agents' : scope.join(', ') || 'no agents');

/** Whether a rule has nothing to act on yet: a Keywords or Tool list rule with nothing picked, or one that covers no agents. */
export const notSetUp = (r: Pick<GovernanceRule, 'ruleType' | 'params' | 'appliesTo'>) => emptyPick(r) !== null || (r.appliesTo !== 'all' && r.appliesTo.length === 0);

/**
 * The page's three cards: rules for all agents, rules for specific agents
 * (each agent's own, under its name; a rule for two agents shows under
 * both), and "Off and not set up". Within a group: by category, strongest
 * first, then the row order.
 */
export function ruleGroups(rules: readonly GovernanceRule[]): {
  all: GovernanceRule[]; byAgent: { agent: string; rules: GovernanceRule[] }[]; off: GovernanceRule[]; unset: GovernanceRule[];
} {
  const sorted = [...rules].sort(ruleOrder);
  const on = sorted.filter((r) => r.mode !== 'off' && !notSetUp(r));
  const owners = [...new Set(on.flatMap((r) => (r.appliesTo === 'all' ? [] : r.appliesTo)))].sort((a, b) => a.localeCompare(b));
  return {
    all: on.filter((r) => r.appliesTo === 'all'),
    byAgent: owners.map((agent) => ({ agent, rules: on.filter((r) => r.appliesTo !== 'all' && r.appliesTo.includes(agent)) })),
    off: sorted.filter((r) => r.mode === 'off' && !notSetUp(r)),
    unset: sorted.filter(notSetUp),
  };
}

/** An on rule that only alerts: it acts, but never stops a call, so it isn't counted as Enforce. */
export const alertOnly = (r: Pick<GovernanceRule, 'mode' | 'response'> & { ruleType?: GovernanceRuleType }) => r.mode === 'enforce' && r.response === 'notify' && !changesRequest(r);

/** The mode a rule acts in, for the counts: a rule that suspended itself changes no call, so it counts as Watch. */
const actsAs = (r: GovernanceRule): GovernanceMode => (suspended(r) ? 'watch' : r.mode);

/** A group's sub-line, worded like the lead line: "1 Enforce · 6 Watch" (and "· 1 Alert only" when there is one). */
export function modeCount(rules: readonly GovernanceRule[]): string {
  const a = rules.filter(alertOnly).length;
  const e = rules.filter((r) => actsAs(r) === 'enforce').length - a, w = rules.filter((r) => actsAs(r) === 'watch').length;
  return `${e} ${MODE_LABEL.enforce}${a ? ` · ${a} ${NOTIFY.tag}` : ''} · ${w} ${MODE_LABEL.watch}`;
}

/** The page's lead line, counting only rules that are set up. */
export function leadCounts(rules: readonly GovernanceRule[]): { total: number; enforce: number; alert: number; watch: number; off: number } {
  const set = rules.filter((r) => !notSetUp(r));
  const alert = set.filter(alertOnly).length;
  return { total: set.length, enforce: set.filter((r) => actsAs(r) === 'enforce').length - alert, alert, watch: set.filter((r) => actsAs(r) === 'watch').length, off: set.filter((r) => r.mode === 'off').length };
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
    case 'keyword': return `only when its keywords show up${only}`;
    case 'send_limit': return `only for sends to domains not on its list${only}`;
    // Never blocks (canAct is false), so never the one rule that does: kept for the exhaustive switch.
    case 'outside_then_send': return `only for sends after outside content${only}`;
    case 'data_deletion': return `only for delete commands on the tools it names${only}`;
    // Never the one rule that blocks either (canAct is false): it needs another rule to block first.
    case 'block_streak': return `only after ${fmtCount((rule.params as BlockStreakParams).threshold)} blocked calls in a row${only}`;
    // Never blocks (canAct is false): kept for the exhaustive switch.
    case 'trim_results': return `only for old tool results${only}`;
    // Never blocks (canAct is false): kept for the exhaustive switch.
    case 'model_route': return `only for calls that could use a cheaper model${only}`;
    default: return unhandledType(rule.ruleType, `only in some cases${only}`);
  }
}

/** `label`: when `text` is a bare "0", what it means ("None since edit"), for the tooltip and screen readers. */
export type RowCount = { text: string; tone: 'plain' | 'hot' | 'warn'; label?: string };

// Nothing caught shows as "0"; "—" would mean unknown on this dashboard.
const NONE_SINCE_EDIT: RowCount = { text: '0', tone: 'plain', label: 'None since edit' };
const NONE_CAUGHT: RowCount = { text: '0', tone: 'plain', label: 'None caught · 7 days' };

/**
 * The count at the right of a row: "60 caught · 7 days", "0" (None since edit),
 * "Never triggers ($190 cap first)". Seven-day counts are per rule id
 * (rule_actions byRuleId); "since edit" comes from rule_would_act. Viewing
 * one agent, a Watch rule counts that agent's calls since its last
 * change, and an Enforce rule shows its count only when it covers just them.
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
  // The rule's own state, not a count: said whichever agent is in view, and before any count has loaded.
  if (suspended(rule)) return { text: 'Suspended · acting as Watch', tone: 'warn' };
  if (rule.mode === 'enforce') {
    const justThem = !ctx.agent || (rule.appliesTo !== 'all' && rule.appliesTo.length === 1 && rule.appliesTo[0] === ctx.agent);
    if (!justThem || !week) return { text: '', tone: 'plain' };
    const n = enforcedCount(rule, week);
    // Nothing was wrong with a call Model routing moved: said plainly, never as caught.
    if (routes(rule)) return { text: n ? `${fmtCount(n)} sent to a cheaper model · 7 days` : 'None yet · 7 days', tone: 'plain' };
    return n ? { text: `${fmtCount(n)} ${trims(rule) ? 'trimmed' : TALLY_WORD[response]} · 7 days`, tone: 'hot' } : NONE_CAUGHT;
  }
  if (routes(rule)) {
    // Not caught: nothing was wrong with these calls. The count is the rule's, so it shows only where that is the view's: the fleet, or the one agent it covers.
    const justThem = !ctx.agent || (rule.appliesTo !== 'all' && rule.appliesTo.length === 1 && rule.appliesTo[0] === ctx.agent);
    if (!justThem || !week) return { text: '', tone: 'plain' };
    return { text: week.wouldRoute ? `${fmtCount(week.wouldRoute)} could use a cheaper model · 7 days` : 'None yet · 7 days', tone: 'plain' };
  }
  const since = ctx.wouldAct && !ctx.wouldAct.unversioned ? ctx.wouldAct : null;
  const sinceN = since ? (ctx.agent ? since.byAgent[ctx.agent] ?? 0 : Object.values(since.byAgent).reduce((a, b) => a + b, 0)) : null;
  if (ctx.agent || !week) {
    if (sinceN === null) return { text: '', tone: 'plain' };
    return sinceN ? { text: `${fmtCount(sinceN)} caught since edit`, tone: 'hot' } : NONE_SINCE_EDIT;
  }
  if (week.wouldAct) return { text: `${fmtCount(week.wouldAct)} caught · 7 days`, tone: 'hot' };
  return sinceN === 0 ? NONE_SINCE_EDIT : NONE_CAUGHT;
}

const WOULD_VERB: Record<GovernanceResponse, (who: string) => string> = {
  block: (who) => `blocked ${who}`, pause: (who) => `paused ${who}`, stop: (who) => `stopped ${who}`, notify: (who) => `alerted you about ${who}`,
};
/** "6 blocked", "1 alert": an enforced rule's count, as the status line says it. */
const DID: Record<GovernanceResponse, (n: number) => string> = {
  block: (n) => `${fmtCount(n)} blocked`, pause: (n) => `${fmtCount(n)} paused`, stop: (n) => `${fmtCount(n)} stopped`, notify: (n) => `${fmtCount(n)} ${n === 1 ? 'alert' : 'alerts'}`,
};

/**
 * The editor's status line: what the rule is doing now, and what it caught,
 * in one short sentence. "Enforcing for all agents · 6 blocked in 7 days",
 * "Would have blocked code-reviewer 44 times since its last change 4 days
 * ago". Never claims a count it doesn't have.
 */
export function ruleStatus(rule: GovernanceRule, ctx: {
  week?: RuleActionCounts;
  wouldAct?: { byAgent: Record<string, number>; unversioned?: boolean; since?: string | null } | null;
  neverFirst?: string | null;
  now?: number;
}): string {
  const who = whoFor(rule.appliesTo);
  const response = rule.response ?? 'block';
  if (rule.mode === 'off') return 'Off · records nothing';
  const nothingPicked = emptyPick(rule);
  if (nothingPicked) return `Does nothing until you add ${nothingPicked}`;
  if (ctx.neverFirst) return `Never triggers · the ${ctx.neverFirst} cap catches it first`;
  if (suspended(rule)) return `Suspended for ${who} · changing no calls, acting as Watch`;
  if (rule.mode === 'enforce' && routes(rule)) {
    const n = ctx.week ? enforcedCount(rule, ctx.week) : null;
    return `Routing for ${who}${n === null ? '' : n ? ` · ${fmtCount(n)} ${plural(n, 'call')} sent to a cheaper model in 7 days` : ' · none yet in 7 days'}`;
  }
  if (rule.mode === 'enforce') {
    const n = ctx.week ? enforcedCount(rule, ctx.week) : null;
    const tail = n === null ? '' : n ? ` · ${trims(rule) ? `${fmtCount(n)} trimmed` : DID[response](n)} in 7 days` : ' · nothing caught in 7 days';
    return `${response === 'notify' && !trims(rule) ? 'Alerting you' : 'Enforcing'} for ${who}${tail}`;
  }
  if (routes(rule)) {
    if (!ctx.week) return `Watching ${who}`;
    const n = ctx.week.wouldRoute ?? 0;
    return `Watching ${who} · ${n ? `${fmtCount(n)} ${plural(n, 'call')}` : 'no calls'} could use a cheaper model in 7 days`;
  }
  const w = ctx.wouldAct;
  if (w && !w.unversioned && w.since) {
    const when = timeAgoShort(w.since, ctx.now);
    const hits = Object.entries(w.byAgent).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (!hits.length) return `Watching ${who} · nothing caught since its last change ${when}`;
    const total = hits.reduce((s, [, n]) => s + n, 0);
    const whom = hits.length === 1 ? `${hits[0][0]} ${times(hits[0][1])}` : hits.length === 2 ? `${hits[0][0]} and ${hits[1][0]} ${times(total)} in all` : `${hits.length} agents ${times(total)} in all`;
    return `Would have ${trims(rule) ? `trimmed requests from ${whom}` : WOULD_VERB[response](whom)} since its last change ${when}`;
  }
  if (ctx.week) {
    return `Watching ${who} · ${ctx.week.wouldAct ? `would have acted ${times(ctx.week.wouldAct)} in 7 days` : 'nothing caught in 7 days'}`;
  }
  return `Watching ${who}`;
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
    // A Keywords list the engine hid can't be compared: two such rules may look alike and differ.
    if (notSetUp(r) || listHidden(r)) continue;
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

/** A Keywords rule whose list the engine sent only as a count (no dashboard secret on the read). */
export function keywordsHidden(r: Pick<GovernanceRule, 'ruleType' | 'params'>): boolean {
  return r.ruleType === 'keyword' && !(r.params as KeywordParams).keywords.length && !!(r.params as KeywordParams).keywordCount;
}

/** What the engine hid from this read, so the rule can't be copied or added back from here: its keywords or its domains; null when nothing. */
export function hiddenList(r: Pick<GovernanceRule, 'ruleType' | 'params'>): 'keywords' | 'domains' | null {
  return keywordsHidden(r) ? 'keywords' : domainsHidden(r) ? 'domains' : null;
}
export const listHidden = (r: Pick<GovernanceRule, 'ruleType' | 'params'>) => hiddenList(r) !== null;

/** A Keywords rule's words for a sentence: "password", or "password", "SSN" + 2 more; markers only count. */
export function keywordsShort(p: KeywordParams): string {
  const words = p.keywords.filter((k) => !isMarker(k));
  if (!words.length && p.keywords.length) return markerCount(p.keywords.length);
  const shown = words.slice(0, 2).map((k) => `"${k}"`).join(', ');
  const more = p.keywords.length - Math.min(2, words.length);
  return more ? `${shown} + ${more} more` : shown;
}

/** Name parts of a tool that deletes or changes data. Used only to order and pre-pick tools, never to decide a call. */
const DELETE_OR_CHANGE = new Set([
  'delete', 'deletes', 'deleted', 'remove', 'removes', 'removed', 'drop', 'drops', 'dropped',
  'purge', 'purges', 'purged', 'update', 'updates', 'updated', 'write', 'writes',
]);

/** Whether a tool's name has a part (split at non-letters and camelCase) like delete, remove, drop, purge, update or write: `bulk-update` does, `dropdown_options` doesn't. */
export function looksLikeDeleteOrChange(tool: string): boolean {
  return nameParts(tool).some((p) => DELETE_OR_CHANGE.has(p));
}

/** A tool name's parts, split at non-letters and camelCase, lower case: `sendEmail` → send, email. */
function nameParts(tool: string): string[] {
  return tool.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/);
}

/** The fleet's tools that look like they delete or change data, as many as a Tool list holds (the engine's limit is 100). */
export const deleteLookingTools = (tools: readonly string[]) => tools.filter(looksLikeDeleteOrChange).slice(0, 100);

// ── The editor's three questions (Rashad, Oct 27): When · Who · What happens ──

/** The rule's condition as one plain sentence, for When before Change: "Spends more than $190 in a day". */
export function whenSentence(rule: Pick<GovernanceRule, 'ruleType' | 'params'>): { pre: string; val: string; post: string } {
  switch (rule.ruleType) {
    case 'spend_cap': {
      const p = rule.params as SpendCapParams;
      return { pre: 'Spends more than ', val: money(p), post: ` in a ${p.scope}` };
    }
    case 'loop_breaker': {
      const p = rule.params as LoopBreakerParams;
      const ignore = p.ignoreTools.length ? `, not counting ${p.ignoreTools.join(', ')}` : '';
      return { pre: 'Makes the same call ', val: fmtCount(p.threshold), post: ` times in a ${p.scope}${ignore}` };
    }
    case 'call_rate': return { pre: 'Makes more than ', val: fmtCount((rule.params as CallRateParams).maxCalls), post: ' calls in a minute' };
    case 'model_allowlist': {
      const models = (rule.params as ModelAllowlistParams).allowedModels;
      return models.length ? { pre: 'Uses a model other than ', val: models.join(', '), post: '' } : { pre: 'No models picked yet', val: '', post: '' };
    }
    case 'tool_list': {
      const tools = (rule.params as ToolListParams).blockedTools;
      return tools.length ? { pre: 'Is about to run ', val: tools.join(', '), post: '' } : { pre: 'No tools picked yet', val: '', post: '' };
    }
    case 'keyword': return ruleCondition(rule);
    case 'send_limit': return ruleCondition(rule);
    case 'outside_then_send': return ruleCondition(rule);
    case 'data_deletion': {
      const tools = (rule.params as DataDeletionParams).commandTools;
      return tools.length ? { pre: 'Is asked to run a delete command with ', val: tools.join(', '), post: '' } : { pre: 'No tools picked yet', val: '', post: '' };
    }
    case 'block_streak': return { pre: 'Has ', val: fmtCount((rule.params as BlockStreakParams).threshold), post: ' calls in a row blocked in a run' };
    case 'trim_results': {
      const p = rule.params as TrimResultsParams;
      return { pre: 'Sends a request of about ', val: `${fmtCount(p.minTokens)} tokens`, post: ` or more, with tool results older than ${newest(p.keepRecent)}` };
    }
    case 'model_route': {
      const p = rule.params as ModelRouteParams;
      return ladderOf(p).length ? { pre: 'Models, strongest first: ', val: ladderText(p), post: '' } : { pre: 'No models picked yet', val: '', post: '' };
    }
    default: return unhandledType(rule.ruleType, { pre: UNKNOWN_RULE, val: '', post: '' });
  }
}

/** "What happens": Off · Watch · Enforce, in that order. */
export const MODE_CHOICES: readonly GovernanceMode[] = ['off', 'watch', 'enforce'];
/** The modes a rule type can be set to: Model routing is offered Enforce only where the engine takes it for the fleet. */
export const modeChoices = (ruleType: GovernanceRuleType, routeEnforce = false): readonly GovernanceMode[] => (ruleType === 'model_route' && !routeEnforce ? MODE_CHOICES.filter((m) => m !== 'enforce') : MODE_CHOICES);

/**
 * The draft with a new mode. Leaving Enforce puts back the saved rule's
 * action and alert, so trying actions and stepping back changes nothing.
 * Enforce keeps the draft's action when it can be picked now, else takes the
 * first one that can (a day in Watch first holds some back).
 */
export function chooseMode(
  d: RuleDraft, mode: GovernanceMode, saved: Pick<GovernanceRule, 'response' | 'alsoNotify'>,
  actions: readonly GovernanceResponse[] = responseChoices(true, d.ruleType), canPick: (r: GovernanceResponse) => boolean = () => true,
): RuleDraft {
  if (mode !== 'enforce') {
    return d.mode === 'enforce' ? { ...d, mode, response: typeResponse(d.ruleType, saved.response), alsoNotify: !!saved.alsoNotify } : { ...d, mode };
  }
  if (d.mode === 'enforce') return d;
  const pick = [d.response, ...actions].find((r) => actions.includes(r) && canPick(r)) ?? d.response;
  return pick === d.response ? { ...d, mode } : changeResponse({ ...d, mode }, pick);
}

/** The draft with a new "When enforced" action (Enforce mode). */
export function chooseAction(d: RuleDraft, response: GovernanceResponse): RuleDraft {
  return changeResponse({ ...d, mode: 'enforce' }, response);
}

/** What each rule type can do when enforced (the engine's per-type map, DLP spec 5.4): Where tools can send data only alerts or blocks. */
const TYPE_RESPONSES: Record<GovernanceRuleType, readonly GovernanceResponse[]> = {
  spend_cap: ['block', 'pause', 'stop', 'notify'], loop_breaker: ['block', 'pause', 'stop', 'notify'], model_allowlist: ['block', 'pause', 'stop', 'notify'],
  tool_list: ['block', 'pause', 'stop', 'notify'], call_rate: ['block', 'pause', 'stop', 'notify'], keyword: ['block', 'pause', 'stop', 'notify'],
  send_limit: ['notify', 'block'],
  // Only alerts (DLP spec 5.3): the editor shows "When enforced: Only alert me" as fixed text.
  outside_then_send: ['notify'],
  // Never Block: it acts on calls another rule already blocked.
  block_streak: ['pause', 'stop', 'notify'],
  // The engine's fixed value; the rule never alerts, so the editor shows no action at all.
  trim_results: ['notify'],
  // The engine's fixed value here too: the rule never alerts or blocks.
  model_route: ['notify'],
  data_deletion: ['block', 'pause', 'stop', 'notify'],
};

/**
 * A saved response as the draft holds it: the rule's own when its type has it,
 * else the type's first (Outside content, then send data only alerts, so a
 * rule holding anything else is drafted on Only alert me and can be saved).
 */
function typeResponse(ruleType: GovernanceRuleType, saved: GovernanceResponse | undefined): GovernanceResponse {
  const r = saved ?? 'block';
  const own = TYPE_RESPONSES[ruleType];
  return !own || own.includes(r) ? r : own[0];
}

/**
 * The actions this rule type has on this fleet, in its "When enforced" order:
 * Pause and Stop only on Gov v1 fleets, but always the ones the rule uses.
 */
export function responseChoices(govV1: boolean, ruleType: GovernanceRuleType, ...keep: GovernanceResponse[]): GovernanceResponse[] {
  return TYPE_RESPONSES[ruleType].filter((r) => govV1 || r === 'notify' || r === 'block' || keep.includes(r));
}

/** What an enforced rule does, after "Enforce: ". */
const ENFORCE_LINE: Record<GovernanceResponse, string> = {
  block: 'blocks the call. The agent keeps going.',
  pause: 'pauses the agent and alerts you. Its run ends until someone resumes it.',
  stop: 'stops the agent and alerts you. It refuses every call until someone resumes it.',
  notify: 'alerts you. The call goes through.',
};

/** The one plain line under What happens, for the pick. */
export function whatHappensLine(d: Pick<RuleDraft, 'mode' | 'response' | 'alsoNotify'> & { ruleType?: GovernanceRuleType }, routeEnforce = false): string {
  if (d.mode === 'off') return 'Off: does nothing and records nothing.';
  // Where Enforce isn't offered for it, a rule that came in enforced says so, and Save asks for Watch.
  if (routes(d) && d.mode === 'enforce') return routeEnforce ? 'Enforce: a call that can use a cheaper model on the list is sent to it. Any other call goes as the agent wrote it.' : 'Enforce isn’t available for this rule yet. Set it to Watch or Off.';
  if (routes(d)) return 'Watch: changes nothing and records the calls that could use a cheaper model on the list.';
  if (trims(d)) {
    return d.mode === 'watch' ? 'Watch: changes nothing and records what it would have removed.'
      : 'Enforce: edits what the agent sends to the model. It never blocks a call or alerts you.';
  }
  // The calls it counts were blocked by another rule, so "the call goes through" isn't its to say.
  if (d.ruleType === 'block_streak' && d.mode === 'watch') return 'Watch: only records what it would have done.';
  if (d.ruleType === 'block_streak' && d.response === 'notify') return 'Enforce: alerts you. The agent keeps going.';
  if (d.mode === 'watch') return 'Watch: records what it would do; every call goes through.';
  if (d.response === 'block' && d.alsoNotify) return 'Enforce: blocks the call and alerts you. The agent keeps going.';
  return `Enforce: ${ENFORCE_LINE[d.response]}`;
}
