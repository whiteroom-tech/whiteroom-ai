'use client';

// The selected rule, as four steps (When · Then · Applies to · Mode) and a
// Save button: nothing reaches the engine until Save (Controls spec Rev 1, D1).

import Link from 'next/link';
import { Banner, Button, FONT_MONO, Hint, SegmentedControl, SelectChip } from '@whiteroom/ui';
import type {
  GovernanceHistoryEntry, GovernanceMode, GovernanceRule, LoopBreakerParams, ModelAllowlistParams, RuleWouldActResult, SpendCapParams, ToolListParams,
} from '@/lib/whiteroom/types';
import { RESPONSE_EFFECT, RULE_LABELS, responseOptions } from '@/lib/governance';
import { canAct, watchSummary } from '@/lib/controls-guard';
import { historyWho, type ControlActor } from '@/lib/control-actors';
import { timeAgo } from '@/lib/format';
import { UNNAMED_CALLS_ENFORCE } from '@/lib/setup';
import { AGENT_NOTE, agentGets, draftParams, type RuleDraft } from '@/lib/controls-view';
import { GroupPicker, InlineSelect, MODEL_GROUPS, NumberField, ScopeField, TOOL_GROUPS } from './pickers';

const ACTS: Record<GovernanceRule['ruleType'], string> = {
  spend_cap: 'Acts before the next call.', loop_breaker: 'Acts on the Nth call.', model_allowlist: 'Acts before the call.',
  tool_list: 'Acts before the agent gets the tool call.', call_rate: 'Acts on the call over the limit.',
};
const MODES: { value: GovernanceMode; label: string; dot?: 'warn' }[] = [
  { value: 'off', label: 'Off' }, { value: 'watch', label: 'Watch only' }, { value: 'enforce', label: 'Enforce', dot: 'warn' },
];
const eyebrow = { margin: 0, fontFamily: FONT_MONO, fontSize: 10, fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase', color: 'var(--tx2)' } as const;
const help = { margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--tx2)' } as const;
const sentenceRow = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 13.5 } as const;

export function RuleEditor({ rule, draft, onDraft, agents, govV1, wouldAct, history, actors, dirty, error, saving, onSave, onDiscard, onClose, onRemove }: {
  rule: GovernanceRule;
  draft: RuleDraft;
  onDraft: (d: RuleDraft) => void;
  agents: string[];
  govV1: boolean;
  /** Watch counts for the saved version, when loaded. */
  wouldAct: RuleWouldActResult | null;
  /** This rule's own history, newest first. */
  history: GovernanceHistoryEntry[];
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
  const seen = watching && wouldAct ? watchSummary({ response: rule.response }, wouldAct) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, flex: '1 0 auto' }}>
      <div className="gov-edhead" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{RULE_LABELS[rule.ruleType]}</h2>
        <Button variant="ghost" size={28} onClick={onClose}>Close</Button>
      </div>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={eyebrow}>When</p>
        {rule.ruleType === 'spend_cap' && (
          <>
            <div style={sentenceRow}>
              An agent spends more than
              <NumberField label="Spend limit" value={draft.number} onChange={(v) => set({ number: v })} />
              <InlineSelect label="Limit unit" value={(p as SpendCapParams).unit} options={['dollars', 'tokens'] as const} onChange={(unit) => setParams({ unit })} />
              in a
              <InlineSelect label="Limit period" value={(p as SpendCapParams).scope} options={['day', 'run'] as const} onChange={(scope) => setParams({ scope })} />
            </div>
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
              addLabel="+ add tool" otherLabel="Other (type tool name)…" placeholder="tool name" />
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
            <span style={{ fontSize: 13.5 }}>Only allow these models:</span>
            <GroupPicker values={(p as ModelAllowlistParams).allowedModels} onChange={(allowedModels) => setParams({ allowedModels })} groups={MODEL_GROUPS}
              addLabel="+ add model" otherLabel="Other (type deployment name or model ID)…" placeholder="deployment name or model ID" />
          </>
        )}
        {rule.ruleType === 'tool_list' && (
          <>
            <span style={{ fontSize: 13.5 }}>When an agent is about to run any of these tools:</span>
            <GroupPicker values={(p as ToolListParams).blockedTools} onChange={(blockedTools) => setParams({ blockedTools })} groups={TOOL_GROUPS}
              addLabel="+ add tool" otherLabel="Other (type tool name)…" placeholder="tool name" />
            <p style={help}>In Enforce, a streamed call is checked before it streams, so its text arrives all at once. In Watch, streamed calls aren’t checked.</p>
          </>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={eyebrow}>Then</p>
        <div style={{ alignSelf: 'flex-start' }}>
          <SelectChip label="What the rule does" value={draft.response} onChange={(response) => set({ response })} options={responseOptions(govV1, draft.response)} />
        </div>
        <p style={help}>{RESPONSE_EFFECT[draft.response]}</p>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={eyebrow}>Applies to</p>
        <ScopeField scope={draft.appliesTo} agents={agents} onChange={(appliesTo) => set({ appliesTo })} />
        {draft.appliesTo === 'all' && <p style={help}>Applies to all agents in this fleet.</p>}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={eyebrow}>Mode</p>
        <div style={{ alignSelf: 'flex-start' }}>
          <SegmentedControl<GovernanceMode> label="Mode" value={draft.mode} onChange={(mode) => set({ mode })} options={MODES} />
        </div>
        <p style={{ ...help, display: 'inline-flex', alignItems: 'center' }}>
          {draft.mode === 'off' ? 'Off. Not counting.' : draft.mode === 'watch' ? 'Watch only. Counting, never acting.' : ACTS[rule.ruleType]}
          {canAct(asRule) && <Hint text={UNNAMED_CALLS_ENFORCE} size={12} />}
        </p>
        {watching && wouldAct && (
          <p style={{ ...help, color: seen ? 'var(--warn-tx)' : 'var(--tx2)' }}>
            {seen ?? 'Watching: it hasn’t fired since its last change.'}
            {wouldAct.since ? ` Last changed ${timeAgo(wouldAct.since)}.` : ''}
          </p>
        )}
      </section>

      {error && <Banner variant="error">{error}</Banner>}

      <div className="gov-actbar" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
        <Button variant="primary" onClick={onSave} disabled={!dirty} busy={saving} busyLabel="Saving…">Save</Button>
        <Button variant="secondary" onClick={onDiscard} disabled={!dirty || saving}>Discard changes</Button>
        <Button variant="danger" onClick={onRemove} disabled={saving} className="gov-remove" style={{ marginLeft: 'auto' }}>Remove rule</Button>
      </div>

      <details className="gov-details">
        <summary>What the agent gets</summary>
        <pre style={{ margin: '10px 0 0', background: 'var(--sunk)', borderRadius: 7, padding: 12, fontFamily: FONT_MONO, fontSize: 11.5, lineHeight: 1.6, color: 'var(--tx2)', overflowX: 'auto' }}>
          {agentGets({ ruleType: rule.ruleType, params: asRule.params, response: draft.response })}
        </pre>
        {draft.response !== 'notify' && <p style={{ ...help, marginTop: 8 }}>{AGENT_NOTE[rule.ruleType]}</p>}
      </details>

      <details className="gov-details">
        <summary>History</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {history.length === 0 && <p style={help}>No history yet.</p>}
          {history.slice(0, 10).map((h) => (
            <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5 }}>
              <span>{h.description}</span>
              <span style={{ color: 'var(--tx2)', flex: 'none' }}>{timeAgo(h.time)} · {historyWho(h, actors)}</span>
            </div>
          ))}
          <Link href="/settings#audit-integrity" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--brand)' }}>Audit integrity →</Link>
        </div>
      </details>
    </div>
  );
}
