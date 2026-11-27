'use client';

// The selected rule as three questions (Rashad, Oct 27): When (a sentence,
// with Change to edit it), Who, and What happens (Off · Watch · Enforce, and
// when enforced, one action; Oct 28). Nothing reaches the engine until Save.

import { HistoryLine } from './HistoryLine';
import { RuleCategory } from './RuleCategory';
import type { Undo } from '@/lib/rule-history';
import { MODE_LABEL, modeTagText } from '@/lib/vocab';
import { useEffect, useState } from 'react';
import type { GovernanceMode, GovernanceResponse } from '@/lib/whiteroom/types';
import Link from 'next/link';
import { Banner, Button, FONT_MONO, Hint, SegmentedControl } from '@whiteroom/ui';
import type {
  DataDeletionParams, GovernanceHistoryEntry, GovernanceRule, KeywordParams, KeywordWhere, LoopBreakerParams, ModelAllowlistParams, ModelRouteParams, OutsideThenSendParams, SendLimitParams, SendSeenRow, SpendCapParams, ToolListParams,
} from '@/lib/whiteroom/types';
import { RESPONSE_LABEL, RULE_LABELS } from '@/lib/governance';
import { actionAvailableFrom, canAct, keywordBlockCheck, stopCheck } from '@/lib/controls-guard';
import { fmtTime } from '@/lib/format';
import { addDays, dayKey, formatInZone } from '@/lib/zone-time';
import type { ControlActor } from '@/lib/control-actors';
import { ROUTES } from '@/lib/routes';
import { UNNAMED_CALLS_ENFORCE } from '@/lib/setup';
import {
  canAddSeen, COMMAND_TOOLS_MAX, DELETION_DOCS_URL, domainEntry, domainProblem, domainsHidden, domainTotal, FLOW_TOOLS_MAX, FLOW_WHEN, looksLikeCommandRunner, looksLikeReader, looksLikeSender, SEEN_RESERVED_TEXT, seenFullLine, seenNotOnList, SEND_DOMAINS_MAX, SEND_TOOLS_MAX, toolsFull, toolsWithNoDomain, trims,
} from '@/lib/controls-view';
import { AGENT_NOTE, isMarker, KEYWORD_MAX, KEYWORD_MAX_CHARS, KEYWORD_WHERE, keywordFits, looksLikeDeleteOrChange, newMarker, agentGets, loopActs, changeUnit, chooseAction, chooseMode, draftParams, emptyPick, ladderIds, modeChoices, responseChoices, routes, sendsAlert, whatHappensLine, whenSentence, type RuleDraft } from '@/lib/controls-view';
import { Chip, field, GroupPicker, InlineSelect, MarkerChip, MODEL_GROUPS, NumberField, ScopeField, ToolPicker } from './pickers';
import { ReplayEstimate } from './ReplayEstimate';

/** How a rule judged on the reply meets a streamed call and a Bedrock one. */
const HELD_REPLY_NOTE = 'In Watch, streamed calls are checked after they arrive. In Enforce, a streamed call that can use a listed tool arrives all at once, and a Bedrock one is refused.';
/** How many tools seen and not on a Data deletion rule are listed before "and N more". */
const UNLISTED_SHOWN = 5;

/** When each rule acts; Keywords depends on where it looks (KEYWORD_ACTS), Loop breaker on its number (loopActs). */
const ACTS: Record<Exclude<GovernanceRule['ruleType'], 'keyword' | 'loop_breaker'>, string> = {
  spend_cap: 'Acts before the next call.', model_allowlist: 'Acts before the call.',
  tool_list: 'Acts before the agent gets the tool call. Also covers tools the provider runs, like web search.', call_rate: 'Acts on the call over the limit.',
  send_limit: 'Acts before the agent gets the tool call. Tools the provider runs, like web search, always match.',
  outside_then_send: 'Checks each reply once the agent has read outside content. It never holds a call.',
  block_streak: 'Acts on the blocked call that reaches the limit.',
  trim_results: 'Acts before the request goes to the model.',
  model_route: 'It changes no call.',
  data_deletion: 'Acts before the agent gets the tool call.',
};
const KEYWORD_ACTS: Record<KeywordWhere, string> = {
  incoming: 'Acts before the call reaches the model.',
  replies: 'Acts on the reply before the agent gets it.',
  both: 'Acts before the call reaches the model, and on the reply before the agent gets it.',
};
const WHERE_OPTIONS = (Object.keys(KEYWORD_WHERE) as KeywordWhere[]).map((value) => ({ value, label: KEYWORD_WHERE[value][0].toUpperCase() + KEYWORD_WHERE[value].slice(1) }));
/** Fine print for When, behind its ⓘ. */
const WHEN_NOTES: Record<GovernanceRule['ruleType'], string | null> = {
  spend_cap: 'Dollar limits are estimates.',
  model_allowlist: null,
  call_rate: null,
  loop_breaker: 'Calls to the tools listed under Not counting never count as a loop.',
  keyword: 'Whole words, any case. Images and PDFs aren’t checked. The matched text is never stored, and the agent isn’t told which keyword matched.',
  tool_list: HELD_REPLY_NOTE,
  // Its streaming and Bedrock notes sit under Block, where they matter (DLP spec 3.2).
  send_limit: null,
  // Its help is in the editor, under When (DLP spec 3.3).
  outside_then_send: null,
  block_streak: 'Call rate blocks don’t count.',
  trim_results: 'Native Bedrock Converse calls aren’t trimmed.',
  model_route: 'Native Bedrock Converse calls aren’t covered.',
  data_deletion: HELD_REPLY_NOTE,
};

/** A Where tools can send data rule's Seen list, as the page has read it. */
export type SeenState = { status: 'loading' } | { status: 'failed' } | { status: 'ok'; rows: SendSeenRow[]; full?: boolean; fleetFull?: boolean };
const REPLY_NOTE = 'To block a streamed reply, it’s checked whole first, so its text arrives all at once. Bedrock replies are checked in Watch; in Enforce, Bedrock calls are refused.';
/** A reader without the list sees only how many domains it has (engine domainCount). */
const hiddenDomains = (p: SendLimitParams) => { const n = domainTotal(p); return n === 0 ? 'No domains are on the list.' : n === 1 ? '1 domain is hidden here.' : `${n} domains are hidden here.`; };
const help = { margin: 0, fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--tx2)' } as const;
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`;
const sentenceRow = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 'var(--fs-md)' } as const;

/** Shown on an empty Data deletion list when none of the fleet's tools has a command-like name. */
export const NO_COMMAND_TOOLS_NOTE = 'None of your agents’ tools look like they run commands or SQL. Add one with + Add tool.';

/** Why a Block tools list can't be estimated as it stands, or null. A list with targets (set outside this page) judges arguments, which aren't stored. */
export function toolEstimateBlocker(p: ToolListParams & { targets?: unknown }): string | null {
  if (Array.isArray(p.targets) && p.targets.length > 0) return 'A list with targets can’t be estimated.';
  return p.blockedTools.length === 0 ? 'Add a tool first.' : null;
}

export function RuleEditor({ fleetId, authKey, rule, draft, onDraft, agents, fleetTools, onToolPicker, govV1, alertChannel, history, ruleHistory, actors, undoOf, onUndo, fleetDailySpend = null, agentSpend = [], status, startOpen = false, dirty, error, saving, onSave, onDiscard, onClose, onRemove, seen, onSeenRetry, onStaged }: {
  /** The fleet, for the Estimate under the rule's settings; without it there is none. */
  fleetId?: string;
  authKey?: string;
  rule: GovernanceRule;
  /** Where tools can send data: its Seen list (the owner's only; absent otherwise). */
  seen?: SeenState;
  /** Read the Seen list again after a failed read. */
  onSeenRetry?: () => void;
  /** An edit was staged from outside the form (Add to list): say so. */
  onStaged?: (message: string) => void;
  draft: RuleDraft;
  onDraft: (d: RuleDraft) => void;
  agents: string[];
  /** The fleet's own tools for the tool pickers; empty until read, or when the engine has none to give. */
  fleetTools: readonly string[];
  /** A tool picker is showing: read the fleet's tools, if not already. */
  onToolPicker: () => void;
  govV1: boolean;
  /** Whether the fleet has somewhere to send alerts (Slack or Teams); null while unknown. */
  alertChannel: boolean | null;
  /** This rule's own history, newest first. */
  history: GovernanceHistoryEntry[];
  /** The fleet's whole rule history, for the time an action needs in Watch first. */
  ruleHistory: GovernanceHistoryEntry[];
  /** Open When for editing at once (a rule just added). */
  startOpen?: boolean;
  /** How to undo a change, or null (lib/rule-history). */
  undoOf: (h: GovernanceHistoryEntry) => Undo | null;
  onUndo: (u: Undo, entryId: string) => void;
  /** The fleet's average daily spend (all agents together) and over how many days, for a dollars-a-day cap; null when unknown. */
  fleetDailySpend?: { perDay: number; days: number } | null;
  actors: ControlActor[];
  /** Each covered agent's own average daily spend, for a dollars-a-day cap on specific agents. */
  agentSpend?: { agent: string; perDay: number; days: number }[];
  /** What the rule is doing now, in a sentence (controls-view ruleStatus). */
  status: string;
  dirty: boolean;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onClose: () => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<RuleDraft>) => onDraft({ ...draft, ...patch });
  const setParams = (patch: object) => set({ params: { ...draft.params, ...patch } as RuleDraft['params'] });
  const p = draft.params;
  const parsed = draftParams(draft);
  const asRule = { ...rule, mode: draft.mode, response: draft.response, params: 'params' in parsed ? parsed.params : p };
  const [keyword, setKeyword] = useState('');
  const keywords = rule.ruleType === 'keyword' ? (p as KeywordParams).keywords : [];
  // How many keywords the engine hid (no dashboard secret on the read), if it did.
  const hiddenKeywords = rule.ruleType === 'keyword' && !(rule.params as KeywordParams).keywords.length ? (rule.params as KeywordParams).keywordCount : undefined;
  const typed = keyword.trim();
  // A keyword already in the list, in any case: said under the field, and the text stays.
  const repeat = !!typed && keywords.some((x) => x.toLowerCase() === typed.toLowerCase());
  const addKeyword = () => {
    if (!typed || repeat || !keywordFits(keywords)) return;
    setParams({ keywords: [...keywords, typed] });
    setKeyword('');
  };
  const markers = keywords.filter(isMarker).length;
  // Where tools can send data. Without the dashboard's secret the engine sends only how many domains
  // there are: the editor is read only, has no Seen list, and never writes the hidden list back.
  const send = rule.ruleType === 'send_limit' ? (p as SendLimitParams) : null;
  // Outside content, then send data: two tool lists, and it only alerts (DLP spec 3.3).
  const flow = rule.ruleType === 'outside_then_send' ? (p as OutsideThenSendParams) : null;
  // Data deletion: the tools whose commands it reads, and the fleet's command-looking tools it doesn't read yet.
  const deletion = rule.ruleType === 'data_deletion' ? (p as DataDeletionParams) : null;
  const unlisted = deletion ? fleetTools.filter((t) => looksLikeCommandRunner(t) && !deletion.commandTools.includes(t)) : [];
  const addUnlisted = (tool: string) => {
    if (!deletion) return;
    setParams({ commandTools: [...deletion.commandTools, tool] });
    onStaged?.(`${tool} added. Save to apply.`);
  };
  // Old tool results edits requests: no action to pick and no alert (its response is fixed and unused).
  const trim = trims(rule);
  // Model routing: the models the agent may use, strongest first. No action to pick here either.
  const route = routes(rule) ? (p as ModelRouteParams) : null;
  const readOnly = domainsHidden(rule);
  const [domain, setDomain] = useState('');
  const domainTyped = domainEntry(domain);
  const domainWrong = send ? domainProblem(domain, send.domains) : null;
  const addDomain = () => {
    if (!send || !domainTyped || domainWrong) return;
    setParams({ domains: [...send.domains, domainTyped] });
    setDomain('');
  };
  const seenRows = send && seen?.status === 'ok' ? seenNotOnList(seen.rows, send.domains) : [];
  const noDomain = send && seen?.status === 'ok' ? toolsWithNoDomain(seen.rows, send.tools) : [];
  const fullLine = send && seen?.status === 'ok' ? seenFullLine(seen) : null;
  const addSeen = (row: SendSeenRow) => {
    if (!send || send.domains.length >= SEND_DOMAINS_MAX || send.domains.includes(row.domain)) return;
    setParams({ domains: [...send.domains, row.domain] });
    onStaged?.(`${row.domain} added. Save to apply.`);
  };
  // Only alert me, Pause and Stop alert; Block does when asked to.
  const alerts = sendsAlert(draft);
  // A rule with nothing to act on yet, or a number that doesn't read, opens with When expanded.
  const [whenOpen, setWhenOpen] = useState(() => startOpen || !!emptyPick(rule) || 'error' in draftParams(draft));
  const when = whenSentence({ ruleType: rule.ruleType, params: asRule.params });
  const where = rule.ruleType === 'keyword' ? (p as KeywordParams).where : null;
  const timing = draft.mode === 'off' ? '' : rule.ruleType === 'keyword' ? KEYWORD_ACTS[where!] : rule.ruleType === 'loop_breaker' ? loopActs(draft.number, (p as LoopBreakerParams).threshold) : ACTS[rule.ruleType];
  // What the fleet spends a day, to set a dollars-a-day cap by: behind When's ⓘ with the fine print.
  const dailyCap = rule.ruleType === 'spend_cap' && (p as SpendCapParams).unit === 'dollars' && (p as SpendCapParams).scope === 'day';
  const days = (n: number) => (n === 1 ? 'day' : `${n} days`);
  const spendNotes = !dailyCap ? [] : [
    ...agentSpend.map((a) => `${a.agent} spends about ${usd(a.perDay)} a day (last ${days(a.days)}).`),
    ...(fleetDailySpend !== null && (draft.appliesTo === 'all' || !agentSpend.length) ? [`Your fleet spends about ${usd(fleetDailySpend.perDay)} a day, all agents together (last ${days(fleetDailySpend.days)}).`] : []),
  ];
  const whenHint = [...spendNotes, timing, WHEN_NOTES[rule.ruleType], where && where !== 'incoming' ? REPLY_NOTE : ''].filter(Boolean).join(' ');
  // Re-read once a waiting period ends, so the option it held back opens on its own.
  const [, setTick] = useState(0);
  /** When an action can be picked, if it has to wait (a day in Watch first); null when it can now. Off and Watch never wait. */
  const waitUntil = (o: GovernanceResponse) => {
    if (rule.mode === 'enforce' && rule.response === o) return null;
    const needs = stopCheck(rule, { mode: 'enforce', response: o }, ruleHistory).kind === 'blocked'
      || keywordBlockCheck(rule, { mode: 'enforce', response: o, params: asRule.params }, ruleHistory).kind === 'blocked';
    return needs ? actionAvailableFrom(rule.id, ruleHistory, rule.mode) : null;
  };
  const actions = responseChoices(govV1, rule.ruleType, rule.response ?? 'block', draft.response);
  const oneAction = !trim && actions.length === 1;
  const nextOpen = Math.min(...actions.map(waitUntil).filter((t): t is number => typeof t === 'number'));
  useEffect(() => {
    if (!Number.isFinite(nextOpen)) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(2 ** 31 - 1, Math.max(0, nextOpen - Date.now()) + 1000));
    return () => clearTimeout(t);
  }, [nextOpen]);
  /** Why an action can't be picked yet, with when it can; null when it can. */
  const waitFor = (o: GovernanceResponse): string | null => {
    const from = waitUntil(o);
    if (from === null) return null;
    if (from === 'record-first') return 'needs 24 hours in Watch first';
    // In Watch, but the history doesn't say since when: waiting won't open it.
    if (from === 'unknown') return 'needs 24 hours in Watch first (we can’t see when it started watching)';
    const today = dayKey();
    const day = dayKey(from) === today ? 'today' : dayKey(from) === addDays(today, 1) ? 'tomorrow' : formatInZone(from, { month: 'short', day: 'numeric' });
    return `from ${fmtTime(from)} ${day}, after 24 hours in Watch`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, flex: '1 0 auto' }}>
      <div className="gov-edhead">
        {/* On a phone the editor is its own page: back to the list on the left, the mode on the right.
            On a wide screen the category and Close share the top line, the rule name under them. */}
        <button type="button" className="gov-edhead__back" onClick={onClose}>‹ Controls</button>
        <RuleCategory type={rule.ruleType} />
        <Button variant="ghost" size={28} onClick={onClose} className="gov-edhead__close">Close</Button>
        <h2 id="ctl-ed-title" tabIndex={-1} className="gov-edhead__title ctl-ed-title">{RULE_LABELS[rule.ruleType]}</h2>
        <span className={`gov-edhead__mode${draft.mode === 'enforce' && draft.response !== 'notify' ? ' is-on' : ''}`}>{modeTagText(draft)}{dirty ? ' · unsaved' : ''}</span>
      </div>
      {/* Phone only: the header cuts the name short and has no room for the category. */}
      <p className="gov-edhead__full"><RuleCategory type={rule.ruleType} /><span aria-hidden="true">{RULE_LABELS[rule.ruleType]}</span></p>
      <p className="ctl-status">{status}</p>
      {rule.sourceRecommendationId && (
        <p style={{ margin: '-12px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          From a Diagnosis suggestion · <Link href={ROUTES.performance} style={{ color: 'var(--brand)', fontWeight: 600 }}>see it in Performance</Link>
        </p>
      )}

      <fieldset disabled={saving || readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="gov-eyebrow ctl-q">When{whenHint && <Hint text={whenHint} size={12} />}</p>
        {!whenOpen ? (<>
          <div className="ctl-when">
            <span style={{ fontSize: 'var(--fs-md)' }}>{when.pre}{when.val && <span style={{ fontFamily: FONT_MONO }}>{when.val}</span>}{when.post}</span>
            <Button size={28} onClick={() => setWhenOpen(true)} aria-expanded={false}>Change</Button>
          </div>
          {send && readOnly && <p style={{ ...help, color: 'var(--tx)' }}>{hiddenDomains(send)}</p>}
        </>) : <>
        {rule.ruleType === 'spend_cap' && (
          <div style={sentenceRow}>
            An agent spends more than
            <NumberField label="Spend limit" value={draft.number} onChange={(v) => set({ number: v })} />
            <InlineSelect label="Limit unit" value={(p as SpendCapParams).unit} options={['dollars', 'tokens'] as const} onChange={(unit) => onDraft(changeUnit(draft, unit))} />
            in a
            <InlineSelect label="Limit period" value={(p as SpendCapParams).scope} options={['day', 'run'] as const} onChange={(scope) => setParams({ scope })} />
          </div>
        )}
        {rule.ruleType === 'loop_breaker' && (
          <>
            <div style={sentenceRow}>
              An agent makes the same call
              <NumberField label="Repeated-call limit" value={draft.number} onChange={(v) => set({ number: v })} />
              times in a
              <InlineSelect label="Limit period" value={(p as LoopBreakerParams).scope} options={['run', 'day'] as const} onChange={(scope) => setParams({ scope })} />
            </div>
            <span style={help}>Not counting:</span>
            <ToolPicker values={(p as LoopBreakerParams).ignoreTools} onChange={(ignoreTools) => setParams({ ignoreTools })} fleetTools={fleetTools} onShow={onToolPicker} />
          </>
        )}
        {rule.ruleType === 'call_rate' && (
          <div style={sentenceRow}>
            An agent makes more than
            <NumberField label="Calls per minute limit" value={draft.number} onChange={(v) => set({ number: v })} />
            calls in a minute
          </div>
        )}
        {rule.ruleType === 'model_allowlist' && (
          <>
            <span style={{ fontSize: 'var(--fs-md)' }}>Only allow these models:</span>
            <GroupPicker values={(p as ModelAllowlistParams).allowedModels} onChange={(allowedModels) => setParams({ allowedModels })} groups={MODEL_GROUPS}
              addLabel="+ Add model" ariaLabel="Add a model" otherLabel="Other (type deployment name or model ID)…" placeholder="deployment name or model ID" />
            {fleetId && (
              <ReplayEstimate fleetId={fleetId} authKey={authKey} ruleType={rule.ruleType} params={p} appliesTo={draft.appliesTo}
                disabledReason={(p as ModelAllowlistParams).allowedModels.length === 0 ? 'Add a model first.' : null} />
            )}
          </>
        )}
        {rule.ruleType === 'keyword' && (
          <>
            <div style={sentenceRow}>
              <select className="gov-field" aria-label="Where to look" value={(p as KeywordParams).where} onChange={(e) => setParams({ where: e.target.value as KeywordWhere })}
                disabled={hiddenKeywords !== undefined} style={{ ...field, padding: '0 8px', cursor: 'pointer' }}>
                {WHERE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              contains any of:
            </div>
            {hiddenKeywords !== undefined ? (
              // The engine sent only the count: the list can't be changed from here, the rest of the rule can.
              <p style={{ ...help, color: 'var(--tx)' }}>{hiddenKeywords === 1 ? '1 keyword is' : `${hiddenKeywords} keywords are`} hidden here. Reload the page to see and change them.</p>
            ) : <>
            {keywords.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {keywords.map((k, i) => {
                  const remove = () => setParams({ keywords: keywords.filter((_, j) => j !== i) });
                  return isMarker(k)
                    ? <MarkerChip key={`${i}:${k}`} code={k} onRemove={remove} />
                    : <Chip key={`${i}:${k}`} label={`“${k}”`} removeLabel={`Remove ${k}`} onRemove={remove} />;
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="gov-field" aria-label="Keyword or phrase" placeholder="Type a word or phrase" value={keyword} maxLength={KEYWORD_MAX_CHARS}
                onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }}
                style={{ ...field, padding: '0 10px', flex: '1 1 160px', minWidth: 0 }} />
              <Button onClick={addKeyword} disabled={!typed || repeat || !keywordFits(keywords)}>Add</Button>
            </div>
            <Button size={28} onClick={() => setParams({ keywords: [...keywords, newMarker()] })} disabled={!keywordFits(keywords)} style={{ alignSelf: 'flex-start' }}>Generate marker</Button>
            {repeat && <p style={help}>That keyword is already in the list.</p>}
            {!keywordFits(keywords) && <p style={help}>A rule holds up to {KEYWORD_MAX} keywords. Remove one to add another.</p>}
            {markers > 0 && (
              <p style={help}>A marker is a made-up code. Copy it into private records and this rule flags it when it shows up.{where !== 'replies' && ' With incoming data on, it also matches when an agent reads the record.'}</p>
            )}
            </>}
          </>
        )}
        {rule.ruleType === 'tool_list' && (
          <>
            <span style={{ fontSize: 'var(--fs-md)' }}>When an agent is about to run any of these tools:</span>
            <ToolPicker values={(p as ToolListParams).blockedTools} onChange={(blockedTools) => setParams({ blockedTools })} fleetTools={fleetTools} onShow={onToolPicker} first={looksLikeDeleteOrChange} />
            {fleetId && (
              <ReplayEstimate fleetId={fleetId} authKey={authKey} ruleType={rule.ruleType} params={p} appliesTo={draft.appliesTo}
                disabledReason={toolEstimateBlocker(p as ToolListParams & { targets?: unknown })} />
            )}
          </>
        )}
        {deletion && (
          <>
            <span style={{ fontSize: 'var(--fs-md)' }}>Tools that run commands or SQL:</span>
            <ToolPicker values={deletion.commandTools} onChange={(commandTools) => setParams({ commandTools })} fleetTools={fleetTools} onShow={onToolPicker} first={looksLikeCommandRunner} ariaLabel="Add a tool that runs commands or SQL" />
            {/* Nothing was pre-picked and nothing is suggested below: say why, so the empty list doesn't read as broken. */}
            {deletion.commandTools.length === 0 && fleetTools.length > 0 && !fleetTools.some(looksLikeCommandRunner) && <p style={help}>{NO_COMMAND_TOOLS_NOTE}</p>}
            {deletion.commandTools.length > COMMAND_TOOLS_MAX && <p style={help}>{toolsFull(COMMAND_TOOLS_MAX)}</p>}
            <p style={help}>
              Looks for commands that delete from a database or a cloud account. It catches mistakes, not commands written to hide what they do.{' '}
              <a href={DELETION_DOCS_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>See what it covers</a>
            </p>
            {draft.mode === 'watch' && <p style={help}>Check what it catches in Watch before you enforce it.</p>}
          </>
        )}
        {send && (
          <>
            <span style={{ fontSize: 'var(--fs-md)' }}>One of these tools sends to a domain that isn’t on the list:</span>
            <ToolPicker values={send.tools} onChange={(tools) => setParams({ tools })} fleetTools={fleetTools} onShow={onToolPicker} first={looksLikeSender} />
            {send.tools.length > SEND_TOOLS_MAX && <p style={help}>{toolsFull(SEND_TOOLS_MAX)}</p>}
            {noDomain.map((t) => (
              <p key={t} style={help}><span style={{ fontFamily: FONT_MONO }}>{t}</span>: no domain found. Block would stop every call it makes.</p>
            ))}
          </>
        )}
        {rule.ruleType === 'block_streak' && (
          <>
            <div style={sentenceRow}>
              An agent has
              <NumberField label="Blocked calls in a row" value={draft.number} onChange={(v) => set({ number: v })} />
              calls in a row blocked in a run
            </div>
            <p style={help}>Counts calls that another rule in Enforce blocked. A call that isn’t blocked starts the count over.</p>
          </>
        )}
        {trim && (
          <>
            <div style={sentenceRow}>
              A request is about
              <NumberField label="Request size in tokens" value={draft.number2 ?? ''} onChange={(v) => set({ number2: v })} />
              tokens or more,
            </div>
            <div style={sentenceRow}>
              with tool results older than the newest
              <NumberField label="Recent turns to keep" value={draft.number} onChange={(v) => set({ number: v })} />
              turns
            </div>
            <p style={help}>Each old result is replaced with a short note. The agent can call the tool again if it needs one back.</p>
          </>
        )}
        {route && (
          <>
            <span style={{ fontSize: 'var(--fs-md)' }}>Models, strongest first:</span>
            {/* The picker edits the names; an entry that also says which model a deployment runs keeps that, also when it is removed and added back. */}
            <GroupPicker values={ladderIds(route)} onChange={(ids) => setParams({ ladder: ids.map((id) => [...route.ladder, ...(rule.params as ModelRouteParams).ladder].find((x) => typeof x !== 'string' && x.id === id) ?? id) })} groups={MODEL_GROUPS}
              addLabel="+ Add model" ariaLabel="Add a model" otherLabel="Other (type deployment name or model ID)…" placeholder="deployment name or model ID" />
            <p style={help}>Add the strongest first, then each cheaper one. To change the order, remove a model and add it back.</p>
          </>
        )}
        {flow && (
          <>
            <span style={{ fontSize: 'var(--fs-md)' }}>{FLOW_WHEN}.</span>
            <p style={help}>A web page, email or file can carry hidden instructions. An agent that reads mail and replies will match on most runs.</p>
          </>
        )}
        {/* Where tools can send data and Outside content, then send data end When with their own sections, Done under them. */}
        {!send && !flow && <Button size={28} onClick={() => setWhenOpen(false)} style={{ alignSelf: 'flex-start' }} aria-expanded>Done</Button>}
        </>}
      </section>

      {send && whenOpen && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="gov-eyebrow ctl-q">Allowed domains</p>
          {readOnly ? (
            <p style={{ ...help, color: 'var(--tx)' }}>{hiddenDomains(send)}</p>
          ) : <>
            {send.domains.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {send.domains.map((d) => <Chip key={d} label={d} onRemove={() => setParams({ domains: send.domains.filter((x) => x !== d) })} />)}
              </div>
            ) : <p style={help}>Nothing is allowed yet. Leave this in Watch to see where these tools send data, then add what’s fine.</p>}
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="gov-field" aria-label="Domain" placeholder="acme.com" value={domain} maxLength={253} autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDomain(); } }}
                aria-describedby={domainWrong ? 'ctl-domain-problem' : undefined}
                style={{ ...field, padding: '0 10px', flex: '1 1 140px', minWidth: 0 }} />
              <Button onClick={addDomain} disabled={!domainTyped || !!domainWrong}>Add</Button>
            </div>
            {domainWrong && <p id="ctl-domain-problem" style={help}>{domainWrong}</p>}
          </>}
          <Button size={28} onClick={() => setWhenOpen(false)} style={{ alignSelf: 'flex-start' }} aria-expanded>Done</Button>
        </section>
      )}

      {flow && whenOpen && (
        <>
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p className="gov-eyebrow ctl-q">Reads outside content</p>
            <ToolPicker values={flow.readTools} onChange={(readTools) => setParams({ readTools })} fleetTools={fleetTools} onShow={onToolPicker} first={looksLikeReader} ariaLabel="Add a tool that reads outside content" />
            <p style={help}>The provider’s web search and web fetch always count.</p>
          </section>
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p className="gov-eyebrow ctl-q">Sends data out</p>
            <ToolPicker values={flow.sendTools} onChange={(sendTools) => setParams({ sendTools })} fleetTools={fleetTools} onShow={onToolPicker} first={looksLikeSender} ariaLabel="Add a tool that sends data out" />
            {(flow.readTools.length > FLOW_TOOLS_MAX || flow.sendTools.length > FLOW_TOOLS_MAX) && <p style={help}>A rule holds up to {FLOW_TOOLS_MAX} tools in each list. Remove one to save.</p>}
            <Button size={28} onClick={() => setWhenOpen(false)} style={{ alignSelf: 'flex-start' }} aria-expanded>Done</Button>
          </section>
        </>
      )}

      {/* How the list gets built: shown whether or not When is open (DLP spec 3.2). Never for a reader without the list. */}
      {send && !readOnly && seen && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="ctl-seen-title">
          <p className="gov-eyebrow ctl-q" id="ctl-seen-title">Seen, not on the list</p>
          {seen.status === 'loading' && <p style={help} role="status">Loading…</p>}
          {seen.status === 'failed' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <p style={help}>Couldn’t load this list.</p>
              {onSeenRetry && <Button size={28} onClick={onSeenRetry}>Try again</Button>}
            </div>
          )}
          {seen.status === 'ok' && (seenRows.length ? (
            <>
              <div className="ctl-seen">
                {seenRows.map((r) => {
                  const reserved = SEEN_RESERVED_TEXT[r.domain];
                  return (
                    <div key={`${r.tool}\n${r.domain}`} className="ctl-seen__row">
                      <span className="ctl-seen__what">
                        {reserved ? <span>{reserved}</span> : <span style={{ fontFamily: FONT_MONO }}>{r.domain}</span>}
                        <span className="ctl-seen__sub">{[r.agentId, r.tool, formatInZone(r.firstSeen, { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}</span>
                      </span>
                      {canAddSeen(r) && (
                        <Button size={28} onClick={() => addSeen(r)} disabled={saving || send.domains.length >= SEND_DOMAINS_MAX} aria-label={`Add ${r.domain} to the list`}>Add to list</Button>
                      )}
                    </div>
                  );
                })}
              </div>
              <p style={help}>Only the domain is stored, never what was sent.</p>
              {send.domains.length >= SEND_DOMAINS_MAX && <p style={help}>A rule allows up to {SEND_DOMAINS_MAX} domains. Remove one to add another.</p>}
            </>
          ) : <p style={help}>Nothing new.</p>)}
          {fullLine && <p style={help}>{fullLine}</p>}
        </section>
      )}

      {/* Tools the fleet has that look like they run commands and aren't on this rule: it reads nothing from them until they're added. */}
      {deletion && unlisted.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-labelledby="ctl-unlisted-title">
          <p className="gov-eyebrow ctl-q" id="ctl-unlisted-title">Other tools that run commands</p>
          <div className="ctl-seen">
            {unlisted.slice(0, UNLISTED_SHOWN).map((t) => (
              <div key={t} className="ctl-seen__row">
                <span className="ctl-seen__what"><span style={{ fontFamily: FONT_MONO }}>{t}</span></span>
                <Button size={28} onClick={() => addUnlisted(t)} disabled={saving || deletion.commandTools.length >= COMMAND_TOOLS_MAX} aria-label={`Add ${t} to the list`}>Add to list</Button>
              </div>
            ))}
          </div>
          {unlisted.length > UNLISTED_SHOWN && <p style={help}>and {unlisted.length - UNLISTED_SHOWN} more</p>}
          <p style={help}>This rule doesn’t check them until you add them.</p>
        </section>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Narrowing a rule for all agents: Save asks whether to keep it for everyone and add a copy, or move it. */}
        <p className="gov-eyebrow ctl-q">Who{rule.appliesTo === 'all' && draft.appliesTo !== 'all' && draft.appliesTo.length > 0
          && <Hint text="When you save, you’ll choose: keep this rule for everyone and add a copy, or move it." size={12} />}</p>
        <ScopeField scope={draft.appliesTo} agents={agents} onChange={(appliesTo) => set({ appliesTo })} namedOnly={!!route} />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="gov-eyebrow ctl-q" id="ctl-what">What happens{canAct(asRule) && <Hint text={UNNAMED_CALLS_ENFORCE} size={12} />}</p>
        {/* Hugs its content on a wide screen; takes the row on a phone (gov-fill). */}
        <div className="gov-fill" style={{ alignSelf: 'flex-start', display: 'flex', maxWidth: '100%' }}>
          <SegmentedControl<GovernanceMode> label="What happens" value={draft.mode}
            onChange={(m) => onDraft(chooseMode(draft, m, rule, actions, (r) => !waitFor(r)))}
            options={modeChoices(rule.ruleType).map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        </div>
        {/* Outside content, then send data only alerts: fixed text, no choice (DLP spec 3.3). The same for Repeated blocks on a fleet without Pause and Stop. */}
        {draft.mode === 'enforce' && oneAction && (
          <p style={{ margin: 0, fontSize: 'var(--fs-md)' }}>When enforced: <strong>{RESPONSE_LABEL[actions[0]]}</strong></p>
        )}
        {draft.mode === 'enforce' && !oneAction && !trim && (
          <label style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 'var(--fs-md)' }}>
            When enforced:
            {/* An action that needs a day in Watch first stays in the list, disabled, saying when it opens. */}
            <select className="gov-field" aria-label="When enforced" value={draft.response} onChange={(e) => onDraft(chooseAction(draft, e.target.value as GovernanceResponse))}
              style={{ ...field, padding: '0 8px', cursor: 'pointer', maxWidth: '100%' }}>
              {actions.map((r) => {
                const wait = waitFor(r);
                return <option key={r} value={r} disabled={!!wait}>{`${RESPONSE_LABEL[r]}${wait ? ` · ${wait}` : ''}`}</option>;
              })}
            </select>
          </label>
        )}
        {/* Block's own alert. Only in Enforce: a rule in Watch sends no alerts. Pause and Stop always alert; Only alert me is the alert. */}
        {draft.mode === 'enforce' && draft.response === 'block' && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 'var(--fs-sm)', cursor: 'pointer', alignSelf: 'flex-start', minHeight: 32 }}>
            <input type="checkbox" checked={draft.alsoNotify} onChange={(e) => set({ alsoNotify: e.target.checked })} style={{ width: 16, height: 16, margin: 0, accentColor: 'var(--brand)' }} />
            Also alert me
          </label>
        )}
        <p style={help}>{send && draft.mode === 'enforce' && draft.response === 'notify' ? 'You get an alert the first time a tool sends to a new domain. The call goes through.'
          : flow && draft.mode === 'enforce' ? 'You get one alert per run. The agent keeps going.' : whatHappensLine(draft)}</p>
        {send && draft.mode === 'enforce' && draft.response === 'block' && (
          <p style={help}>Streamed replies from agents with these tools arrive all at once. Replies on Bedrock can’t be checked yet.</p>
        )}
        {alerts && alertChannel === false && (
          <p style={{ ...help, color: 'var(--warn-tx)' }}>No alert channel is connected. <Link href={`${ROUTES.settings}#alerts`} style={{ color: 'var(--brand)', fontWeight: 600 }}>Connect one in Settings →</Link></p>
        )}
      </section>
      </fieldset>

      {error && <Banner variant="error">{error}</Banner>}

      {/* On a phone Remove sits at the end of the rule, and the bar below shows only once something changed. */}
      <div className="gov-remove-row">
        <Button variant="ghost" className="ctl-remove" onClick={onRemove} disabled={saving || readOnly}>Remove rule</Button>
      </div>
      <div className={`gov-actbar${dirty || saving ? ' is-dirty' : ''}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
        <Button variant="primary" onClick={onSave} disabled={!dirty} busy={saving} busyLabel="Saving…" className="gov-actbar__save">Save</Button>
        <Button variant="secondary" onClick={onDiscard} disabled={!dirty || saving} className="gov-actbar__discard">Discard changes</Button>
        <Button variant="ghost" onClick={onRemove} disabled={saving || readOnly} className="gov-remove ctl-remove" style={{ marginLeft: 'auto' }}>Remove rule</Button>
      </div>

      <details className="gov-details">
        <summary>What the agent sees</summary>
        <pre style={{ margin: '10px 0 0', background: 'var(--sunk)', borderRadius: 7, padding: 12, fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', lineHeight: 1.6, color: 'var(--tx2)', overflowX: 'auto' }}>
          {agentGets({ ruleType: rule.ruleType, params: asRule.params, response: draft.response })}
        </pre>
        {draft.response !== 'notify' && <p style={{ ...help, marginTop: 8 }}>{AGENT_NOTE[rule.ruleType]}</p>}
      </details>

      <details className="gov-details">
        <summary>History</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {history.length === 0 && <p style={help}>No history yet.</p>}
          {history.slice(0, 10).map((h) => (
            <HistoryLine key={h.id} entry={h} actors={actors} undo={undoOf(h)} onUndo={onUndo} busy={saving} />
          ))}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            <Link href={ROUTES.practiceTest} style={{ color: 'var(--brand)', fontWeight: 600, fontSize: 'var(--fs-sm)' }}>Test in Sandbox</Link>
          </div>
        </div>
      </details>
    </div>
  );
}
