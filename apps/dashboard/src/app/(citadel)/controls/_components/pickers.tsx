'use client';

// The Controls editor's fields: chips with an add menu (models, tools,
// agents), and the inline number, in the shared control style (sunk well,
// line2 border, 7px corners).

import { useState } from 'react';
import { FONT_MONO, Icon } from '@whiteroom/ui';
import type { GovernanceScope } from '@/lib/whiteroom/types';

export const field = { background: 'var(--sunk)', border: '1px solid var(--line2)', borderRadius: 7, color: 'var(--tx)', fontSize: 'var(--fs-sm)', minHeight: '1.875rem', boxSizing: 'border-box' } as const;

export type PickGroup = { label: string; options: { id: string; label: string }[] };

/** Models people pick most, newest first; "Other…" takes any deployment name or model ID. */
export const MODEL_GROUPS: PickGroup[] = [
  { label: 'Anthropic', options: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  ] },
  { label: 'OpenAI', options: [
    { id: 'gpt-4.1', label: 'GPT-4.1' }, { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' }, { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
    { id: 'gpt-4o', label: 'GPT-4o' }, { id: 'gpt-4o-mini', label: 'GPT-4o Mini' }, { id: 'o3', label: 'o3' }, { id: 'o4-mini', label: 'o4-mini' },
  ] },
  { label: 'Google', options: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }, { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }] },
  { label: 'AWS Bedrock', options: [
    { id: 'anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5' },
    { id: 'anthropic.claude-sonnet-4-20250514-v1:0', label: 'Claude Sonnet 4' },
    { id: 'amazon.nova-pro-v1:0', label: 'Nova Pro' }, { id: 'amazon.nova-lite-v1:0', label: 'Nova Lite' },
  ] },
  { label: 'Azure OpenAI', options: [{ id: 'azure/gpt-4.1', label: 'GPT-4.1 (via Azure)' }, { id: 'azure/gpt-4o', label: 'GPT-4o (via Azure)' }, { id: 'azure/gpt-4o-mini', label: 'GPT-4o Mini (via Azure)' }] },
];

export const TOOL_GROUPS: PickGroup[] = [
  { label: 'File & code', tools: ['read_file', 'write_file', 'list_directory', 'search_files', 'edit_file'] },
  { label: 'Web & API', tools: ['http_request', 'fetch_url', 'web_search', 'api_call'] },
  { label: 'Execution', tools: ['run_command', 'execute_code', 'shell', 'bash'] },
  { label: 'Memory & state', tools: ['get_memory', 'set_memory', 'read_context', 'save_state'] },
].map((g) => ({ label: g.label, options: g.tools.map((t) => ({ id: t, label: t })) }));

export function Chip({ label, onRemove, removeLabel = `Remove ${label}` }: { label: string; onRemove: () => void; removeLabel?: string }) {
  return (
    <span className="gov-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, minHeight: '1.625rem', padding: '0 2px 0 9px', borderRadius: 6, border: '1px solid var(--line2)', background: 'var(--sunk)', fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx)' }}>
      {label}
      <button type="button" onClick={onRemove} aria-label={removeLabel} style={{ background: 'none', border: 0, color: 'var(--tx2)', width: 24, height: 24, cursor: 'pointer', fontSize: 'var(--fs-md)' }}>&times;</button>
    </span>
  );
}

/** Chosen values as chips, a grouped menu to add more, and "Other…" for one that isn't listed. */
export function GroupPicker({ values, onChange, groups, addLabel, otherLabel, placeholder, ariaLabel = addLabel }: {
  values: string[];
  onChange: (next: string[]) => void;
  groups: PickGroup[];
  addLabel: string;
  otherLabel: string;
  placeholder: string;
  /** The add menu's name for screen readers, when addLabel ("+ add agent") reads badly. */
  ariaLabel?: string;
}) {
  const [other, setOther] = useState<string | null>(null);
  const labelOf = (id: string) => groups.flatMap((g) => g.options).find((o) => o.id === id)?.label ?? id;
  const add = (v: string) => { const t = v.trim().slice(0, 64); if (t && !values.includes(t)) onChange([...values, t]); };
  const addOther = () => { if (other !== null) add(other); setOther(null); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {values.map((v) => <Chip key={v} label={labelOf(v)} onRemove={() => onChange(values.filter((x) => x !== v))} />)}
        {/* Looks like a button; the native menu under it keeps the keyboard and screen readers working. */}
        <span className="wr-btn wr-btn--secondary wr-btn--h28 gov-addpick">
          <span aria-hidden="true">{addLabel}</span>
          <select
            aria-label={ariaLabel}
            value=""
            onChange={(e) => { const v = e.target.value; if (v === '__other__') setOther(''); else if (v) add(v); }}
          >
          <option value="">{addLabel}</option>
          {groups.map((g) => {
            const left = g.options.filter((o) => !values.includes(o.id));
            return left.length ? <optgroup key={g.label} label={g.label}>{left.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup> : null;
          })}
          <option value="__other__">{otherLabel}</option>
          </select>
        </span>
      </div>
      {other !== null && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="gov-field"
            autoFocus
            aria-label={otherLabel}
            placeholder={placeholder}
            value={other}
            onChange={(e) => setOther(e.target.value.slice(0, 64))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOther(); } if (e.key === 'Escape') setOther(null); }}
            style={{ ...field, padding: '0 10px', flex: '1 1 160px', minWidth: 0, fontFamily: FONT_MONO }}
          />
          <button type="button" className="wr-btn wr-btn--secondary wr-btn--h32" onClick={addOther}>Add</button>
        </div>
      )}
    </div>
  );
}

/** All agents, or chosen ones; an empty choice applies to none, and Save says so. */
export function ScopeField({ scope, agents, onChange }: { scope: GovernanceScope; agents: string[]; onChange: (s: GovernanceScope) => void }) {
  const chosen = scope === 'all' ? [] : scope;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <FieldSelect label="Which agents this rule applies to" value={scope === 'all' ? 'all' : 'some'} onChange={(v) => onChange(v === 'all' ? 'all' : [])} style={{ alignSelf: 'flex-start' }}>
        <option value="all">All agents</option>
        <option value="some">Specific agents</option>
      </FieldSelect>
      {scope !== 'all' && (
        <>
          {/* Agents the fleet has seen, or any name typed in: a rule can cover an agent before its first call. */}
          <GroupPicker values={chosen} onChange={onChange} groups={agents.length ? [{ label: 'Agents', options: agents.map((a) => ({ id: a, label: a })) }] : []}
            addLabel="+ Add agent" ariaLabel="Add an agent" otherLabel="Other (type an agent name)…" placeholder="agent name" />
          {agents.length === 0 && (
            <p style={{ margin: 0, fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--tx2)' }}>No agents have made a call yet. Pick Other to type an agent’s name.</p>
          )}
        </>
      )}
    </div>
  );
}

/** A number typed in a sentence; kept as text until Save, so "1,0" isn't forced into 10. */
export function NumberField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <input
      className="gov-field"
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value.slice(0, 16))}
      style={{ ...field, width: 96, padding: '0 10px', fontFamily: FONT_MONO, textAlign: 'right' }}
    />
  );
}

/** A native select in the shared select style (the chevron SelectChip uses). */
function FieldSelect({ label, value, onChange, style, children }: { label: string; value: string; onChange: (v: string) => void; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <span className="wr-select gov-select" style={style}>
      <select className="gov-field" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
      <Icon name="chevronDown" size={10} strokeWidth={2.5} />
    </span>
  );
}

/** A small select in a sentence (unit, period). */
export function InlineSelect<V extends string>({ value, onChange, options, label }: { value: V; onChange: (v: V) => void; options: V[]; label: string }) {
  return (
    <FieldSelect label={label} value={value} onChange={(v) => onChange(v as V)}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </FieldSelect>
  );
}
