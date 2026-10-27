'use client';

// The selected rule, as four steps (When · Then · Applies to · Mode) and a
// Save button: nothing reaches the engine until Save (Controls spec Rev 1, D1).

import { HistoryLine } from './HistoryLine';
import type { Undo } from '@/lib/rule-history';
import { MODE_LABEL } from '@/lib/vocab';
import { useState } from 'react';
import Link from 'next/link';
import { Banner, Button, FONT_MONO, Hint, SegmentedControl, SelectChip } from '@whiteroom/ui';
import type {
  GovernanceHistoryEntry, GovernanceMode, GovernanceRule, KeywordParams, KeywordWhere, LoopBreakerParams, ModelAllowlistParams, RuleWouldActResult, SpendCapParams, ToolListParams,
} from '@/lib/whiteroom/types';
import { RESPONSE_EFFECT, RULE_LABELS, responseOptions } from '@/lib/governance';
import { canAct, watchSummary } from '@/lib/controls-guard';
import type { ControlActor } from '@/lib/control-actors';
import { timeAgo } from '@/lib/format';
import { ROUTES } from '@/lib/routes';
import { UNNAMED_CALLS_ENFORCE } from '@/lib/setup';
import { AGENT_NOTE, KEYWORD_MAX, KEYWORD_MAX_CHARS, KEYWORD_WHERE, keywordFits, agentGets, changeResponse, loopActs, changeUnit, draftParams, sendsAlert, type RuleDraft } from '@/lib/controls-view';
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
const MODES: { value: GovernanceMode; label: string; dot?: 'bad' }[] = [
  { value: 'off', label: MODE_LABEL.off }, { value: 'watch', label: MODE_LABEL.watch }, { value: 'enforce', label: MODE_LABEL.enforce, dot: 'bad' },
];
const help = { margin: 0, fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--tx2)' } as const;
const sentenceRow = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 'var(--fs-md)' } as const;

export function RuleEditor({ rule, draft, onDraft, agents, govV1, alertChannel, wouldAct, history, actors, undoOf, onUndo, fleetDailySpend = null, dirty, error, saving, onSave, onDiscard, onClose, onRemove }: {
  rule: GovernanceRule;
  draft: RuleDraft;
  onDraft: (d: RuleDraft) => void;
  agents: string[];
  govV1: boolean;
  /** Whether the fleet has somewhere to send alerts (Slack or Teams); null while unknown. */
  alertChannel: boolean | null;
  /** Watch counts for the saved version, when loaded. */
  wouldAct: RuleWouldActResult | null;
  /** This rule's own history, newest first. */
  history: GovernanceHistoryEntry[];
  /** How to undo a change, or null (lib/rule-history). */
  undoOf: (h: GovernanceHistoryEntry) => Undo | null;
  onUndo: (u: Undo, entryId: string) => void;
  /** The fleet's average daily spend (all agents together) and over how many days, for a dollars-a-day cap; null when unknown. */
  fleetDailySpend?: { perDay: number; days: number } | null;
  actors: ControlActor[];
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
  const watching = rule.mode === 'watch' && draft.mode === 'watch';
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
  // Alert me, Pause and Stop alert; Block does when asked to.
  const alerts = sendsAlert(draft);
  const seen = watching && wouldAct ? watchSummary({ response: rule.response }, wouldAct) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, flex: '1 0 auto' }}>
      <div className="gov-edhead" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        {/* On a phone the editor is its own page: back to the list on the left, the mode on the right. */}
        <button type="button" className="gov-edhead__back" onClick={onClose}>‹ Controls</button>
        <h2 className="gov-edhead__title" style={{ margin: 0, fontSize: 'var(--fs-card)', fontWeight: 700 }}>{RULE_LABELS[rule.ruleType]}</h2>
        <span className={`gov-edhead__mode${draft.mode === 'enforce' ? ' is-on' : ''}`}>{MODES.find((m) => m.value === draft.mode)?.label}{dirty ? ' · unsaved' : ''}</span>
        <Button variant="ghost" size={28} onClick={onClose} className="gov-edhead__close">Close</Button>
      </div>
      {rule.sourceRecommendationId && (
        <p style={{ margin: '-12px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          From a Diagnosis suggestion · <Link href={ROUTES.performance} style={{ color: 'var(--brand)', fontWeight: 600 }}>see it in Performance</Link>
        </p>
      )}

      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="gov-eyebrow">When</p>
        {rule.ruleType === 'spend_cap' && (
          <>
            <div style={sentenceRow}>
              An agent spends more than
              <NumberField label="Spend limit" value={draft.number} onChange={(v) => set({ number: v })} />
              <InlineSelect label="Limit unit" value={(p as SpendCapParams).unit} options={['dollars', 'tokens'] as const} onChange={(unit) => onDraft(changeUnit(draft, unit))} />
              in a
              <InlineSelect label="Limit period" value={(p as SpendCapParams).scope} options={['day', 'run'] as const} onChange={(scope) => setParams({ scope })} />
            </div>
            {(p as SpendCapParams).unit === 'dollars' && (p as SpendCapParams).scope === 'day' && fleetDailySpend !== null && (
              <p style={{ ...help, color: 'var(--tx)' }}>Your fleet spends about ${fleetDailySpend.perDay < 10 ? fleetDailySpend.perDay.toFixed(2) : Math.round(fleetDailySpend.perDay).toLocaleString('en-US')} a day, all agents together (last {fleetDailySpend.days === 1 ? 'day' : `${fleetDailySpend.days} days`}).</p>
            )}
            {(p as SpendCapParams).unit === 'dollars' && (
              <p style={help}>Dollar estimates use a blended rate of $0.003/1K tokens. Actual cost varies by model — see the Performance tab for per-model pricing.</p>
            )}
          </>
        )}
        {rule.ruleType === 'loop_breaker' && (
          <>
            <div style={sentenceRow}>
              An agent makes the same call
              <NumberField label="Repeated-call limit" value={draft.number} onChange={(v) => set({ number: v })} />
              times in a
              <InlineSelect label="Limit period" value={(p as LoopBreakerParams).scope} options={['run', 'day'] as const} onChange={(scope) => setParams({ scope })} />
            </div>
            <span style={help}>Ignore:</span>
            <GroupPicker values={(p as LoopBreakerParams).ignoreTools} onChange={(ignoreTools) => setParams({ ignoreTools })} groups={TOOL_GROUPS}
              addLabel="+ Add tool" ariaLabel="Add a tool" otherLabel="Other (type tool name)…" placeholder="tool name" />
            <p style={help}>Calls to these tools never count as a loop.</p>
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
            <p style={help}>Whole words, any case. Images and PDFs aren’t checked. The matched text is never stored, and the agent isn’t told which keyword matched.</p>
            {(p as KeywordParams).where !== 'incoming' && (
              <p style={help}>To block a streamed reply, it’s checked whole first, so its text arrives all at once. Replies on Bedrock can’t be checked yet.</p>
            )}
          </>
        )}
        {rule.ruleType === 'tool_list' && (
          <>
            <span style={{ fontSize: 'var(--fs-md)' }}>When an agent is about to run any of these tools:</span>
            <GroupPicker values={(p as ToolListParams).blockedTools} onChange={(blockedTools) => setParams({ blockedTools })} groups={TOOL_GROUPS}
              addLabel="+ Add tool" ariaLabel="Add a tool" otherLabel="Other (type tool name)…" placeholder="tool name" />
            <p style={help}>In Block, a streamed call is checked before it streams, so its text arrives all at once. In Record only, streamed calls aren’t checked.</p>
          </>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="gov-eyebrow">Then</p>
        <div className="gov-fill" style={{ alignSelf: 'flex-start' }}>
          <SelectChip label="What the rule does" value={draft.response} onChange={(response) => onDraft(changeResponse(draft, response))} options={responseOptions(govV1, draft.response)} />
        </div>
        {draft.mode !== 'enforce' && (
          <p style={{ ...help, color: 'var(--tx)', fontWeight: 600 }}>
            {draft.mode === 'watch' ? 'Record only: this doesn’t happen yet. WhiteRoom records it and lets the call through.' : 'Off: this doesn’t happen.'} It happens in Block.
          </p>
        )}
        <p style={help}>
          {draft.mode === 'enforce' ? '' : 'In Block: '}{RESPONSE_EFFECT[draft.response]}
          {draft.response === 'block' && draft.alsoNotify && ' You also get an alert in your alert channel (Settings › Alerts) with a link to the run.'}
        </p>
        {alerts && alertChannel === false && (
          <p style={{ ...help, color: 'var(--warn-tx)' }}>
            No alert channel is connected, so no one will get the alert. <Link href={`${ROUTES.settings}#alerts`} style={{ color: 'var(--brand)', fontWeight: 600 }}>Connect one in Settings →</Link>
          </p>
        )}
        {draft.response === 'block' && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 'var(--fs-sm)', cursor: 'pointer', alignSelf: 'flex-start', minHeight: 32 }}>
            <input type="checkbox" checked={draft.alsoNotify} onChange={(e) => set({ alsoNotify: e.target.checked })} style={{ width: 16, height: 16, margin: 0, accentColor: 'var(--brand)' }} />
            Also send me an alert
          </label>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="gov-eyebrow">Applies to</p>
        <ScopeField scope={draft.appliesTo} agents={agents} onChange={(appliesTo) => set({ appliesTo })} />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="gov-eyebrow">Mode</p>
        <div className="gov-fill" style={{ alignSelf: 'flex-start' }}>
          <SegmentedControl<GovernanceMode> label="Mode" value={draft.mode} onChange={(mode) => set({ mode })} options={MODES} />
        </div>
        <p style={{ ...help, display: 'inline-flex', alignItems: 'center' }}>
          {draft.mode === 'off' ? 'Off. Not counting.' : draft.mode === 'watch' ? 'Record only. Records what it would do, never acts.' : rule.ruleType === 'keyword' ? KEYWORD_ACTS[(p as KeywordParams).where] : rule.ruleType === 'loop_breaker' ? loopActs(draft.number, (p as LoopBreakerParams).threshold) : ACTS[rule.ruleType]}
          {canAct(asRule) && <Hint text={UNNAMED_CALLS_ENFORCE} size={12} />}
        </p>
        {watching && wouldAct && (
          <p style={{ ...help, color: seen ? 'var(--warn-tx)' : 'var(--tx2)' }}>
            {seen ?? 'Record only: it hasn’t matched since its last change.'}
            {wouldAct.since ? ` Last changed ${timeAgo(wouldAct.since)}.` : ''}
          </p>
        )}
      </section>

      </fieldset>

      {error && <Banner variant="error">{error}</Banner>}

      {/* On a phone Remove sits at the end of the rule, and the bar below shows only once something changed. */}
      <div className="gov-remove-row">
        <Button variant="danger" onClick={onRemove} disabled={saving}>Remove rule</Button>
      </div>
      <div className={`gov-actbar${dirty || saving ? ' is-dirty' : ''}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
        <Button variant="primary" onClick={onSave} disabled={!dirty} busy={saving} busyLabel="Saving…" className="gov-actbar__save">Save</Button>
        <Button variant="secondary" onClick={onDiscard} disabled={!dirty || saving} className="gov-actbar__discard">Discard changes</Button>
        <Button variant="danger" onClick={onRemove} disabled={saving} className="gov-remove" style={{ marginLeft: 'auto' }}>Remove rule</Button>
      </div>

      <details className="gov-details">
        <summary>What the agent gets</summary>
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
          <Link href={`${ROUTES.settings}#audit-integrity`} style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--brand)' }}>Audit integrity →</Link>
        </div>
      </details>
    </div>
  );
}
