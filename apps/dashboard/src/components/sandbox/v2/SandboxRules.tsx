'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Panel, SkeletonCard, Tag } from '@whiteroom/ui';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { AddRuleDialog } from '@/app/(citadel)/controls/_components/AddRuleDialog';
import { ruleSentenceText } from '@/lib/controls-view';
import { RULE_LABELS } from '@/lib/governance';
import { modeTagText } from '@/lib/vocab';
import { governanceList } from '@/lib/whiteroom/client';
import type { GovernanceRule, GovernanceRuleType } from '@/lib/whiteroom/types';
import { SandboxFleetError } from '@/lib/sandbox/fleet';
import {
  applyReadyMadeRules, copyProductionRules, previewReadyMade, createSandboxRule, deleteSandboxRule, listSandboxRules, SANDBOX_RULES_ONLY, sourceLine,
  updateSandboxRule, type SandboxRuleFields, type SandboxRulesState,
} from '@/lib/sandbox/rules';
import { SandboxRuleEditor } from './SandboxRuleEditor';
import v from './v2.module.css';

/** /dev/sandbox-v2: a fixed state instead of the engine. Actions change only the page. */
export interface SandboxRulesPreview {
  state: SandboxRulesState | null;
  /** How many rules production has (0 hides Copy my production rules). */
  productionRules: number;
  agents?: string[];
  error?: string;
  /** The rule open in the editor. */
  editing?: string;
  now?: number;
}

type Replace = 'ready-made' | 'copy' | null;

const message = (e: unknown) => (e instanceof SandboxFleetError ? e.message : 'That didn’t work. Check your connection and try again.');
/** The Sandbox changed under the page (gone, reset or reconnected elsewhere). */
const stale = (e: unknown) => e instanceof SandboxFleetError && (e.status === 404 || e.status === 409);

/**
 * "3. Sandbox rules" (spec sandbox-v2 §1 decision 3, §2 step 3, §4): the
 * ready-made set by default (applied once, when the Sandbox has no rules
 * yet), "Copy my production rules" when production has any, and an editor.
 * Rules change only on the Sandbox fleet; there's no link to Controls (§8.2).
 */
export function SandboxRules({ fleet, sandboxFleetId, preview, onStale }: {
  fleet: string;
  sandboxFleetId: string;
  preview?: SandboxRulesPreview;
  /** The Sandbox changed under the page: reload its status. */
  onStale?: () => void;
}) {
  const [state, setState] = useState<SandboxRulesState | null>(preview ? preview.state : null);
  const [productionRules, setProductionRules] = useState(preview?.productionRules ?? 0);
  const [agents, setAgents] = useState<string[]>(preview?.agents ?? []);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState(preview?.error ?? '');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(preview?.editing ?? null);
  const [editError, setEditError] = useState<string | null>(null);
  const [replace, setReplace] = useState<Replace>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<GovernanceRule | null>(null);
  // The ready-made set is applied once per Sandbox, on its first rules load with none set up.
  const autoApplied = useRef<string | null>(null);
  // Only the newest rules read (load, replace or quiet re-read) may land: an older one finishing last would undo a later change.
  const refreshReq = useRef(0);
  const now = preview?.now ?? Date.now();

  const failed = useCallback((e: unknown) => {
    setError(message(e));
    if (stale(e)) onStale?.();
  }, [onStale]);

  const load = useCallback(async () => {
    setLoading(true);
    const req = ++refreshReq.current;
    try {
      // Production's rules are only counted (read-only, Controls' own read); a failed read hides Copy.
      const [listed, gov] = await Promise.all([listSandboxRules(fleet, sandboxFleetId), governanceList(fleet).catch(() => null)]);
      setProductionRules(gov?.rules?.length ?? 0);
      setAgents(gov?.agents ?? []);
      let next = listed;
      if (listed.source === null && autoApplied.current !== sandboxFleetId) {
        // Marked before the call so a second load can't apply it twice; cleared if it fails so Try again re-applies.
        autoApplied.current = sandboxFleetId;
        try {
          next = await applyReadyMadeRules(fleet, sandboxFleetId);
        } catch (e) {
          autoApplied.current = null;
          throw e;
        }
      }
      if (req === refreshReq.current) setState(next);
      setError('');
    } catch (e) {
      failed(e);
    } finally {
      setLoading(false);
    }
  }, [fleet, sandboxFleetId, failed]);

  useEffect(() => {
    if (preview) return;
    void load();
  }, [load, preview]);

  async function run<T>(work: () => Promise<T>, done: (r: T) => void, onError: (e: unknown) => void = failed) {
    setBusy(true); setError('');
    try {
      done(await work());
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  function replaceAll(kind: Exclude<Replace, null>) {
    setReplace(null); setEditing(null);
    if (preview) {
      setState((s) => (kind === 'ready-made'
        ? { sandboxFleetId, rules: previewReadyMade(sandboxFleetId), source: 'ready_made', productionChanged: 0 }
        : { sandboxFleetId, rules: s?.rules ?? [], source: 'production_copy', copiedAt: new Date(now).toISOString(), productionChanged: 0 }));
      return;
    }
    // Newer than any quiet re-read still in flight: that older list mustn't overwrite this one.
    const req = ++refreshReq.current;
    void run(() => (kind === 'ready-made' ? applyReadyMadeRules(fleet, sandboxFleetId) : copyProductionRules(fleet, sandboxFleetId)), (next) => {
      if (req === refreshReq.current) setState(next);
    });
  }

  // After an edit: the rules at once, then the engine's own source line (quietly; a failed read keeps the page as is).
  const withRules = (rules: GovernanceRule[]) => {
    setState((s) => (s ? { ...s, rules } : s));
    if (preview) { setState((s) => (s ? { ...s, source: 'custom', productionChanged: 0 } : s)); return; }
    const req = ++refreshReq.current;
    listSandboxRules(fleet, sandboxFleetId).then((next) => { if (req === refreshReq.current) setState(next); }, () => {});
  };

  function add(ruleType: GovernanceRuleType) {
    setAdding(false);
    if (preview) {
      const id = `gr_preview_new_${ruleType}`;
      const rule = previewReadyMade(sandboxFleetId).find((r) => r.ruleType === ruleType)
        ?? { id, fleetId: sandboxFleetId, ruleType, mode: 'watch' as const, appliesTo: 'all' as const, version: 1, changedBy: '', changedAt: '', params: { blockedTools: [] } };
      withRules([...(state?.rules ?? []), { ...rule, id }]);
      setEditing(id);
      return;
    }
    void run(() => createSandboxRule(fleet, sandboxFleetId, { ruleType, mode: 'watch' }), (rule) => {
      withRules([...(state?.rules ?? []), rule]);
      setEditing(rule.id); setEditError(null);
    });
  }

  function save(rule: GovernanceRule, changes: SandboxRuleFields) {
    if (preview) {
      withRules((state?.rules ?? []).map((r) => (r.id === rule.id ? { ...r, ...changes, version: r.version + 1 } : r)));
      setEditing(null);
      return;
    }
    setEditError(null);
    void run(() => updateSandboxRule(fleet, sandboxFleetId, rule.id, { ...changes, ifVersion: rule.version }), (saved) => {
      withRules((state?.rules ?? []).map((r) => (r.id === saved.id ? saved : r)));
      setEditing(null);
    }, (e) => {
      setEditError(message(e));
      // Changed elsewhere since it was read: show the current rules.
      if (stale(e)) void load();
    });
  }

  function remove(rule: GovernanceRule) {
    setRemoving(null);
    if (preview) { withRules((state?.rules ?? []).filter((r) => r.id !== rule.id)); setEditing(null); return; }
    void run(() => deleteSandboxRule(fleet, sandboxFleetId, rule.id), () => {
      withRules((state?.rules ?? []).filter((r) => r.id !== rule.id));
      setEditing(null);
    });
  }

  const line = state ? sourceLine(state, now) : null;
  const rules = state?.rules ?? [];
  const canCopy = productionRules > 0;
  // Agents production has seen, and any a Sandbox rule already names.
  const agentNames = [...new Set([...agents, ...rules.flatMap((r) => (r.appliesTo === 'all' ? [] : r.appliesTo))])];

  return (
    <Panel title="3. Sandbox rules" actions={state ? <Button size={28} onClick={() => setAdding(true)} disabled={busy}>Add a rule</Button> : undefined}>
      <div className={v.stack}>
        <p className={v.text}>{SANDBOX_RULES_ONLY}</p>
        {loading && <SkeletonCard label="Loading your Sandbox rules…" lines={['60%', '45%']} heights={[12, 12]} />}
        {error && <Banner variant="error" actions={!state && !loading && !preview ? <Button size={28} onClick={() => void load()}>Try again</Button> : undefined}>{error}</Banner>}

        {line && (
          <div className={v.source}>
            <p className={v.sourceText}>{line.text}</p>
            {line.changed && (
              <p className={v.text}>
                {line.changed} · <button type="button" className={v.linkButton} onClick={() => setReplace('copy')} disabled={busy}>Copy again</button>
              </p>
            )}
          </div>
        )}

        {state && (
          <div className={v.actions}>
            <Button size={32} onClick={() => setReplace('ready-made')} disabled={busy}>Use the ready-made set</Button>
            {canCopy && <Button size={32} onClick={() => setReplace('copy')} disabled={busy}>Copy my production rules</Button>}
          </div>
        )}

        {state && rules.length === 0 && <p className={v.text}>No rules in your Sandbox. Add one, or use the ready-made set.</p>}
        {rules.length > 0 && (
          <ul className={v.rules}>
            {rules.map((r) => (
              <li key={r.id} className={v.rule}>
                <div className={v.ruleHead}>
                  <span className={v.ruleName}>{RULE_LABELS[r.ruleType]}</span>
                  <Tag tone={r.mode === 'enforce' && r.response !== 'notify' ? 'block' : r.mode === 'off' ? 'muted' : 'warn'}>{modeTagText({ mode: r.mode, response: r.response })}</Tag>
                  {editing !== r.id && <Button size={28} variant="ghost" className={v.push} onClick={() => { setEditing(r.id); setEditError(null); }} disabled={busy} aria-label={`Edit ${RULE_LABELS[r.ruleType]}`}>Edit</Button>}
                </div>
                {editing === r.id ? (
                  <SandboxRuleEditor key={`${r.id}@${r.version}`} rule={r} agents={agentNames} busy={busy} error={editError}
                    onSave={(changes) => save(r, changes)} onCancel={() => setEditing(null)} onRemove={() => setRemoving(r)} />
                ) : (
                  <p className={v.text}>{ruleSentenceText(r)}{r.appliesTo !== 'all' && ` For ${r.appliesTo.join(', ')}.`}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={replace === 'ready-made'}
        tone="neutral"
        title="Use the ready-made set?"
        body={<>This replaces your Sandbox rules. All start in Watch. Your live rules don’t change.</>}
        confirmLabel="Use the ready-made set"
        busy={busy}
        onConfirm={() => replaceAll('ready-made')}
        onCancel={() => setReplace(null)}
      />
      <ConfirmDialog
        open={replace === 'copy'}
        tone="neutral"
        title="Copy your production rules?"
        body={<>This replaces your Sandbox rules with a copy of your production rules. Your live rules don’t change.</>}
        confirmLabel="Copy my production rules"
        busy={busy}
        onConfirm={() => replaceAll('copy')}
        onCancel={() => setReplace(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        title="Remove this Sandbox rule?"
        body={<>It’s removed from your Sandbox only. Your live rules don’t change.</>}
        confirmLabel="Remove rule"
        busy={busy}
        onConfirm={() => { if (removing) remove(removing); }}
        onCancel={() => setRemoving(null)}
      />
      <AddRuleDialog open={adding} busy={busy} onPick={add} onCancel={() => setAdding(false)} />
    </Panel>
  );
}
