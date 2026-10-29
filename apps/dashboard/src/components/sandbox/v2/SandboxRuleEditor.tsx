'use client';

// One Sandbox rule, edited in place (spec sandbox-v2 §2 step 3): its settings,
// who it covers, and Off · Watch · Enforce with one "When enforced" action
// and an alert checkbox. Built from Controls' field pickers and draft helpers
// (imported, not changed). Controls' RuleEditor isn't reused: it carries the
// production page's history, audit check, 24-hour Watch waits and links.

import { useState } from 'react';
import { Banner, Button, SegmentedControl } from '@whiteroom/ui';
import { Chip, field, GroupPicker, InlineSelect, MODEL_GROUPS, NumberField, ScopeField, TOOL_GROUPS } from '@/app/(citadel)/controls/_components/pickers';
import {
  changeUnit, chooseAction, chooseMode, draftChanges, draftFrom, draftProblem, KEYWORD_MAX, KEYWORD_MAX_CHARS, KEYWORD_WHERE, keywordFits,
  MODE_CHOICES, responseChoices, whatHappensLine, type RuleDraft,
} from '@/lib/controls-view';
import { RESPONSE_LABEL } from '@/lib/governance';
import { MODE_LABEL } from '@/lib/vocab';
import type { GovernanceMode, GovernanceResponse, GovernanceRule, KeywordParams, KeywordWhere, LoopBreakerParams, ModelAllowlistParams, SpendCapParams, ToolListParams } from '@/lib/whiteroom/types';
import type { SandboxRuleFields } from '@/lib/sandbox/rules';
import v from './v2.module.css';

const WHERE_OPTIONS = (Object.keys(KEYWORD_WHERE) as KeywordWhere[]).map((value) => ({ value, label: KEYWORD_WHERE[value][0].toUpperCase() + KEYWORD_WHERE[value].slice(1) }));

export function SandboxRuleEditor({ rule, agents, busy, error, onSave, onCancel, onRemove }: {
  rule: GovernanceRule;
  /** Agent names to offer under Who. */
  agents: string[];
  busy: boolean;
  error: string | null;
  /** Only what changed; never called with nothing. */
  onSave: (changes: SandboxRuleFields) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(() => draftFrom(rule));
  const [keyword, setKeyword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<RuleDraft>) => { setProblem(null); setDraft((d) => ({ ...d, ...patch })); };
  const setParams = (patch: object) => set({ params: { ...draft.params, ...patch } as RuleDraft['params'] });
  const p = draft.params;
  const actions = responseChoices(true, rule.response ?? 'block');
  const changes = draftChanges(draft, rule);

  const keywords = rule.ruleType === 'keyword' ? (p as KeywordParams).keywords : [];
  const typed = keyword.trim();
  const repeat = !!typed && keywords.some((k) => k.toLowerCase() === typed.toLowerCase());
  const addKeyword = () => {
    if (!typed || repeat || !keywordFits(keywords)) return;
    setParams({ keywords: [...keywords, typed] });
    setKeyword('');
  };

  const save = () => {
    const why = draftProblem(draft);
    if (why) { setProblem(why); return; }
    if (changes) onSave(changes);
  };

  return (
    <div className={v.editor}>
      <fieldset disabled={busy} className={v.fields}>
        <p className={v.label}>When</p>
        {rule.ruleType === 'spend_cap' && (
          <div className={v.sentence}>
            An agent spends more than
            <NumberField label="Spend limit" value={draft.number} onChange={(n) => set({ number: n })} />
            <InlineSelect label="Limit unit" value={(p as SpendCapParams).unit} options={['dollars', 'tokens']} onChange={(unit) => setDraft(changeUnit(draft, unit))} />
            in a
            <InlineSelect label="Limit period" value={(p as SpendCapParams).scope} options={['run', 'day']} onChange={(scope) => setParams({ scope })} />
          </div>
        )}
        {rule.ruleType === 'loop_breaker' && <>
          <div className={v.sentence}>
            An agent makes the same call
            <NumberField label="Repeated-call limit" value={draft.number} onChange={(n) => set({ number: n })} />
            times in a
            <InlineSelect label="Limit period" value={(p as LoopBreakerParams).scope} options={['run', 'day']} onChange={(scope) => setParams({ scope })} />
          </div>
          <span className={v.text}>Not counting:</span>
          <GroupPicker values={(p as LoopBreakerParams).ignoreTools} onChange={(ignoreTools) => setParams({ ignoreTools })} groups={TOOL_GROUPS}
            addLabel="+ Add tool" ariaLabel="Add a tool" otherLabel="Other (type tool name)…" placeholder="tool name" />
        </>}
        {rule.ruleType === 'call_rate' && (
          <div className={v.sentence}>
            An agent makes more than
            <NumberField label="Calls per minute limit" value={draft.number} onChange={(n) => set({ number: n })} />
            calls in a minute
          </div>
        )}
        {rule.ruleType === 'model_allowlist' && <>
          <span className={v.sentence}>Only allow these models:</span>
          <GroupPicker values={(p as ModelAllowlistParams).allowedModels} onChange={(allowedModels) => setParams({ allowedModels })} groups={MODEL_GROUPS}
            addLabel="+ Add model" ariaLabel="Add a model" otherLabel="Other (type deployment name or model ID)…" placeholder="deployment name or model ID" />
        </>}
        {rule.ruleType === 'tool_list' && <>
          <span className={v.sentence}>When an agent is about to run any of these tools:</span>
          <GroupPicker values={(p as ToolListParams).blockedTools} onChange={(blockedTools) => setParams({ blockedTools })} groups={TOOL_GROUPS}
            addLabel="+ Add tool" ariaLabel="Add a tool" otherLabel="Other (type tool name)…" placeholder="tool name" />
        </>}
        {rule.ruleType === 'keyword' && <>
          <div className={v.sentence}>
            <select className="gov-field" aria-label="Where to look" value={(p as KeywordParams).where} onChange={(e) => setParams({ where: e.target.value as KeywordWhere })}
              style={{ ...field, padding: '0 8px', cursor: 'pointer' }}>
              {WHERE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            contains any of:
          </div>
          {keywords.length > 0 && (
            <div className={v.chips}>
              {keywords.map((k, i) => <Chip key={`${i}:${k}`} label={`“${k}”`} removeLabel={`Remove ${k}`} onRemove={() => setParams({ keywords: keywords.filter((_, j) => j !== i) })} />)}
            </div>
          )}
          <div className={v.formRow}>
            <input className="gov-field" aria-label="Keyword or phrase" placeholder="Type a word or phrase" value={keyword} maxLength={KEYWORD_MAX_CHARS}
              onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }}
              style={{ ...field, padding: '0 10px', flex: '1 1 160px', minWidth: 0 }} />
            <Button size={28} onClick={addKeyword} disabled={!typed || repeat || !keywordFits(keywords)}>Add</Button>
          </div>
          {repeat && <p className={v.text}>That keyword is already in the list.</p>}
          {!keywordFits(keywords) && <p className={v.text}>A rule holds up to {KEYWORD_MAX} keywords. Remove one to add another.</p>}
        </>}

        <p className={v.label}>Who</p>
        <ScopeField scope={draft.appliesTo} agents={agents} onChange={(appliesTo) => set({ appliesTo })} />

        <p className={v.label}>What happens</p>
        <div className={v.segment}>
          <SegmentedControl<GovernanceMode> label="What happens" value={draft.mode}
            onChange={(m) => { setProblem(null); setDraft(chooseMode(draft, m, rule, actions)); }}
            options={MODE_CHOICES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        </div>
        {draft.mode === 'enforce' && (
          <label className={v.sentence}>
            When enforced:
            <select className="gov-field" aria-label="When enforced" value={draft.response} onChange={(e) => setDraft(chooseAction(draft, e.target.value as GovernanceResponse))}
              style={{ ...field, padding: '0 8px', cursor: 'pointer', maxWidth: '100%' }}>
              {actions.map((r) => <option key={r} value={r}>{RESPONSE_LABEL[r]}</option>)}
            </select>
          </label>
        )}
        {draft.mode === 'enforce' && draft.response === 'block' && (
          <label className={v.check}>
            <input type="checkbox" checked={draft.alsoNotify} onChange={(e) => set({ alsoNotify: e.target.checked })} />
            Also alert me
          </label>
        )}
        <p className={v.text}>{whatHappensLine(draft)}</p>
      </fieldset>

      {(problem || error) && <Banner variant="error">{problem ?? error}</Banner>}

      <div className={v.actions}>
        <Button variant="primary" size={32} onClick={save} disabled={!changes} busy={busy} busyLabel="Saving…">Save</Button>
        <Button size={32} onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="ghost" size={32} onClick={onRemove} disabled={busy} className={v.push}>Remove rule</Button>
      </div>
    </div>
  );
}
