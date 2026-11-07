'use client';

// The selected rule as three questions (Rashad, Oct 27): When (a sentence,
// with Change to edit it), Who, and What happens (Off · Watch · Enforce, and
// when enforced, one action; Oct 28). Nothing reaches the engine until Save.

import { HistoryLine } from './HistoryLine';
import type { Undo } from '@/lib/rule-history';
import { MODE_LABEL, modeTagText } from '@/lib/vocab';
import { useEffect, useState } from 'react';
import type { GovernanceMode, GovernanceResponse } from '@/lib/whiteroom/types';
import Link from 'next/link';
import { Banner, Button, FONT_MONO, Hint, SegmentedControl } from '@whiteroom/ui';
import type {
  GovernanceHistoryEntry, GovernanceRule, KeywordParams, KeywordWhere, LoopBreakerParams, ModelAllowlistParams, SpendCapParams, ToolListParams,
} from '@/lib/whiteroom/types';
import { RESPONSE_LABEL, RULE_LABELS } from '@/lib/governance';
import { actionAvailableFrom, canAct, keywordBlockCheck, stopCheck } from '@/lib/controls-guard';
import { fmtTime } from '@/lib/format';
import { addDays, dayKey, formatInZone } from '@/lib/zone-time';
import type { ControlActor } from '@/lib/control-actors';
import { ROUTES } from '@/lib/routes';
import { UNNAMED_CALLS_ENFORCE } from '@/lib/setup';
import { AGENT_NOTE, KEYWORD_MAX, KEYWORD_MAX_CHARS, KEYWORD_WHERE, keywordFits, agentGets, loopActs, changeUnit, chooseAction, chooseMode, draftParams, emptyPick, MODE_CHOICES, responseChoices, sendsAlert, whatHappensLine, whenSentence, type RuleDraft } from '@/lib/controls-view';
import { Chip, field, GroupPicker, InlineSelect, MODEL_GROUPS, NumberField, ScopeField, TOOL_GROUPS } from './pickers';

/** When each rule acts; Keywords depends on where it looks (KEYWORD_ACTS), Loop breaker on its number (loopActs). */
const ACTS: Record<Exclude<GovernanceRule['ruleType'], 'keyword' | 'loop_breaker'>, string> = {
  spend_cap: 'Acts before the next call.', model_allowlist: 'Acts before the call.',
  tool_list: 'Acts before the agent gets the tool call.', call_rate: 'Acts on the call over the limit.',
};
const KEYWORD_ACTS: Record<KeywordWhere, string> = {
  incoming: 'Acts before the call reaches the model.',
  replies: 'Acts on the reply before the agent gets it.',
  both: 'Acts before the call reaches the model, and on the reply before the agent gets it.',
};
const WHERE_OPTIONS = (Object.keys(KEYWORD_WHERE) as KeywordWhere[]).map((value) => ({ value, label: KEYWORD_WHERE[value][0].toUpperCase() + KEYWORD_WHERE[value].slice(1) }));
/** Fine print for When, behind its ⓘ. */
const WHEN_NOTES: Partial<Record<GovernanceRule['ruleType'], string>> = {
  spend_cap: 'Dollar limits are estimates.',
  loop_breaker: 'Calls to the tools listed under Not counting never count as a loop.',
  keyword: 'Whole words, any case. Images and PDFs aren’t checked. The matched text is never stored, and the agent isn’t told which keyword matched.',
  tool_list: 'In Enforce, a streamed call is checked before it streams, so its text arrives all at once. In Watch, streamed calls aren’t checked.',
};
const REPLY_NOTE = 'To block a streamed reply, it’s checked whole first, so its text arrives all at once. Replies on Bedrock can’t be checked yet.';
const help = { margin: 0, fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--tx2)' } as const;
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`;
const sentenceRow = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 'var(--fs-md)' } as const;

export function RuleEditor({ rule, draft, onDraft, agents, govV1, alertChannel, history, ruleHistory, actors, undoOf, onUndo, fleetDailySpend = null, agentSpend = [], status, startOpen = false, dirty, error, saving, onSave, onDiscard, onClose, onRemove, onAudit }: {
  rule: GovernanceRule;
  draft: RuleDraft;
  onDraft: (d: RuleDraft) => void;
  agents: string[];
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
  /** Opens the audit trail check. */
  onAudit: () => void;
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
  const actions = responseChoices(govV1, rule.response ?? 'block', draft.response);
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
      <div className="gov-edhead" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        {/* On a phone the editor is its own page: back to the list on the left, the mode on the right. */}
        <button type="button" className="gov-edhead__back" onClick={onClose}>‹ Controls</button>
        <h2 id="ctl-ed-title" tabIndex={-1} className="gov-edhead__title ctl-ed-title">{RULE_LABELS[rule.ruleType]}</h2>
        <span className={`gov-edhead__mode${draft.mode === 'enforce' && draft.response !== 'notify' ? ' is-on' : ''}`}>{modeTagText(draft)}{dirty ? ' · unsaved' : ''}</span>
        <Button variant="ghost" size={28} onClick={onClose} className="gov-edhead__close">Close</Button>
      </div>
      <p className="ctl-status">{status}</p>
      {rule.sourceRecommendationId && (
        <p style={{ margin: '-12px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          From a Diagnosis suggestion · <Link href={ROUTES.performance} style={{ color: 'var(--brand)', fontWeight: 600 }}>see it in Performance</Link>
        </p>
      )}

      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="gov-eyebrow ctl-q">When{whenHint && <Hint text={whenHint} size={12} />}</p>
        {!whenOpen ? (
          <div className="ctl-when">
            <span style={{ fontSize: 'var(--fs-md)' }}>{when.pre}{when.val && <span style={{ fontFamily: FONT_MONO }}>{when.val}</span>}{when.post}</span>
            <Button size={28} onClick={() => setWhenOpen(true)} aria-expanded={false}>Change</Button>
          </div>
        ) : <>
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
            <GroupPicker values={(p as LoopBreakerParams).ignoreTools} onChange={(ignoreTools) => setParams({ ignoreTools })} groups={TOOL_GROUPS}
              addLabel="+ Add tool" ariaLabel="Add a tool" otherLabel="Other (type tool name)…" placeholder="tool name" />
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
                {keywords.map((k, i) => (
                  <Chip key={`${i}:${k}`} label={`“${k}”`} removeLabel={`Remove ${k}`} onRemove={() => setParams({ keywords: keywords.filter((_, j) => j !== i) })} />
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="gov-field" aria-label="Keyword or phrase" placeholder="Type a word or phrase" value={keyword} maxLength={KEYWORD_MAX_CHARS}
                onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }}
                style={{ ...field, padding: '0 10px', flex: '1 1 160px', minWidth: 0 }} />
              <Button onClick={addKeyword} disabled={!typed || repeat || !keywordFits(keywords)}>Add</Button>
            </div>
            {repeat && <p style={help}>That keyword is already in the list.</p>}
            {!keywordFits(keywords) && <p style={help}>A rule holds up to {KEYWORD_MAX} keywords. Remove one to add another.</p>}
            </>}
          </>
        )}
        {rule.ruleType === 'tool_list' && (
          <>
            <span style={{ fontSize: 'var(--fs-md)' }}>When an agent is about to run any of these tools:</span>
            <GroupPicker values={(p as ToolListParams).blockedTools} onChange={(blockedTools) => setParams({ blockedTools })} groups={TOOL_GROUPS}
              addLabel="+ Add tool" ariaLabel="Add a tool" otherLabel="Other (type tool name)…" placeholder="tool name" />
          </>
        )}
        <Button size={28} onClick={() => setWhenOpen(false)} style={{ alignSelf: 'flex-start' }} aria-expanded>Done</Button>
        </>}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Narrowing a rule for all agents: Save asks whether to keep it for everyone and add a copy, or move it. */}
        <p className="gov-eyebrow ctl-q">Who{rule.appliesTo === 'all' && draft.appliesTo !== 'all' && draft.appliesTo.length > 0
          && <Hint text="When you save, you’ll choose: keep this rule for everyone and add a copy, or move it." size={12} />}</p>
        <ScopeField scope={draft.appliesTo} agents={agents} onChange={(appliesTo) => set({ appliesTo })} />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="gov-eyebrow ctl-q" id="ctl-what">What happens{canAct(asRule) && <Hint text={UNNAMED_CALLS_ENFORCE} size={12} />}</p>
        {/* Hugs its content on a wide screen; takes the row on a phone (gov-fill). */}
        <div className="gov-fill" style={{ alignSelf: 'flex-start', display: 'flex', maxWidth: '100%' }}>
          <SegmentedControl<GovernanceMode> label="What happens" value={draft.mode}
            onChange={(m) => onDraft(chooseMode(draft, m, rule, actions, (r) => !waitFor(r)))}
            options={MODE_CHOICES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        </div>
        {draft.mode === 'enforce' && (
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
        <p style={help}>{whatHappensLine(draft)}</p>
        {alerts && alertChannel === false && (
          <p style={{ ...help, color: 'var(--warn-tx)' }}>No alert channel is connected. <Link href={`${ROUTES.settings}#alerts`} style={{ color: 'var(--brand)', fontWeight: 600 }}>Connect one in Settings →</Link></p>
        )}
      </section>
      </fieldset>

      {error && <Banner variant="error">{error}</Banner>}

      {/* On a phone Remove sits at the end of the rule, and the bar below shows only once something changed. */}
      <div className="gov-remove-row">
        <Button variant="ghost" className="ctl-remove" onClick={onRemove} disabled={saving}>Remove rule</Button>
      </div>
      <div className={`gov-actbar${dirty || saving ? ' is-dirty' : ''}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
        <Button variant="primary" onClick={onSave} disabled={!dirty} busy={saving} busyLabel="Saving…" className="gov-actbar__save">Save</Button>
        <Button variant="secondary" onClick={onDiscard} disabled={!dirty || saving} className="gov-actbar__discard">Discard changes</Button>
        <Button variant="ghost" onClick={onRemove} disabled={saving} className="gov-remove ctl-remove" style={{ marginLeft: 'auto' }}>Remove rule</Button>
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
            <Button size={28} onClick={onAudit}>Check audit trail</Button>
            <Link href={ROUTES.practiceTest} style={{ color: 'var(--brand)', fontWeight: 600, fontSize: 'var(--fs-sm)' }}>Test in Sandbox</Link>
          </div>
        </div>
      </details>
    </div>
  );
}
