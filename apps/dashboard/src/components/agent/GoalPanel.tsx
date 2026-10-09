'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Hint, Panel, Tag } from '@whiteroom/ui';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { LoadFailed } from '@/components/citadel/States';
import { agentNewRun, goalGet, goalSetOwner, type OwnerGoal } from '@/lib/whiteroom/client';
import { HELP } from '@/lib/metric-definitions';
import { applyChange, changedElsewhere, conflictMessage, loadOptional } from '@/lib/settings-flow';
import { fmtTime } from '@/lib/format';
import { fetchControlActors, goalWho, type ControlActor } from '@/lib/control-actors';

const MAX = 2000;

/**
 * Agent detail › Goal (compression spec §14): the owner's goal for this agent,
 * which comes first across every task, plus Start a new task. Nothing changes
 * on screen until the engine confirms. Hidden on engines without goals; a
 * failed load says so, with Try again.
 */
export function GoalPanel({ fleetId, agentId }: { fleetId: string; agentId: string }) {
  const [owner, setOwner] = useState<OwnerGoal | null | undefined>(undefined);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'clear' | 'run' | null>(null);
  const [confirm, setConfirm] = useState<'clear' | 'run' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [actors, setActors] = useState<ControlActor[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // After a change someone else beat: the latest goal, shown above the open editor.
  const [showLatest, setShowLatest] = useState(false);

  // The agent on screen now: results for one the user moved away from are dropped.
  const current = useRef(`${fleetId}:${agentId}`);
  current.current = `${fleetId}:${agentId}`;

  const load = useCallback(async () => {
    const target = `${fleetId}:${agentId}`;
    const out = await loadOptional(() => goalGet(fleetId, agentId));
    if (current.current !== target) return;
    setLoadFailed(out.kind === 'failed');
    if (out.kind !== 'failed') setOwner(out.kind === 'loaded' ? out.value.owner : undefined);
  }, [fleetId, agentId]);

  useEffect(() => {
    // A different agent starts clean: no draft, note or dialog carries over.
    setOwner(undefined);
    setLoadFailed(false);
    setDraft(null);
    setShowLatest(false);
    setNote(null);
    setBusy(null);
    setConfirm(null);
    void load();
  }, [load]);

  // Who set the goal: looked up once per change, by name, never shown as the engine's account id.
  const setBy = owner?.goal ? owner.set_by : null;
  const setAt = owner?.updated_at;
  useEffect(() => {
    setActors(null);
    if (!setBy || !setAt) return;
    let live = true;
    fetchControlActors(fleetId, setAt).then((a) => { if (live) setActors(a); });
    return () => { live = false; };
  }, [fleetId, setBy, setAt]);

  if (owner === undefined) {
    if (!loadFailed) return null;
    return (
      <Panel title={<>Goal<Hint text={HELP.goal} /></>}>
        <LoadFailed what="this agent’s goal" busy={retrying} onRetry={() => { setRetrying(true); void load().finally(() => setRetrying(false)); }} />
      </Panel>
    );
  }
  // Nothing until the names arrive, so "a teammate" doesn't flash before the real name.
  const who = owner?.goal && actors ? goalWho(owner.set_by, owner.updated_at, agentId, actors) : '';

  /** One goal action: dropped if the user moved to another agent, never shown as done unless the engine applied it. */
  async function run<T>(kind: 'save' | 'clear' | 'run', send: () => Promise<T | null>, onApplied: (v: T) => void, done: string, applied: (v: T) => boolean) {
    const target = current.current;
    setBusy(kind);
    setNote(null);
    const out = await applyChange(send, () => current.current === target, applied);
    if (out.kind === 'stale') return;
    if (out.kind === 'applied') onApplied(out.value);
    const conflict = out.kind === 'failed' && changedElsewhere(out.message);
    // Someone else's change won: load theirs, so a second try applies over it. What the user typed stays.
    let reread = false;
    if (conflict) {
      const latest = await goalGet(fleetId, agentId).catch(() => null);
      if (current.current !== target) return;
      if (latest) { setOwner(latest.owner); reread = true; }
    }
    // Only an open editor shows the latest goal; Start a new task has none.
    setShowLatest(reread && kind !== 'run');
    setNote(out.kind === 'applied' ? { ok: true, text: done } : { ok: false, text: conflict ? conflictMessage(reread, kind) : out.message });
    setBusy(null);
    setConfirm(null);
  }

  // The goal on screen is what the user is changing: after a conflict it's the re-read latest, so a second try applies over it.
  const seen = owner?.revision ?? 0;
  const save = () => run('save', () => goalSetOwner(fleetId, agentId, (draft ?? '').trim(), seen),
    (r) => { setOwner(r.owner); setDraft(null); }, 'Saved. The agent works toward it from its next handover.',
    // A reply without the saved goal wasn't applied.
    (r) => !!r?.owner);

  return (
    <Panel
      title={<>Goal<Hint text={HELP.goal} /></>}
      actions={draft === null && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size={28} variant="ghost" title="Clears goals the agent set for itself; per-task limits start over. Your goal stays." disabled={!!busy} onClick={() => setConfirm('run')}>Start a new task</Button>
          <Button size={28} disabled={!!busy} onClick={() => setDraft(owner?.goal ?? '')}>{owner?.goal ? 'Edit goal' : 'Set a goal'}</Button>
        </div>
      )}
    >
      {draft !== null ? (
        <form onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }} style={{ display: 'grid', gap: 8 }}>
          {showLatest && (
            <div style={{ display: 'grid', gap: 4, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--tx2)' }}>Latest goal, from the other change</span>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--tx)', whiteSpace: 'pre-wrap' }}>
                {owner?.unreadable ? 'It can’t be read on this WhiteRoom engine.' : owner?.goal || 'No goal set.'}
              </p>
            </div>
          )}
          <textarea
            className="wr-input" rows={3} maxLength={MAX} required readOnly={!!busy} aria-label="Goal for this agent"
            value={draft} onChange={(e) => setDraft(e.target.value)} style={{ resize: 'vertical', fontSize: 13.5 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--tx2)', flex: 1 }}>{draft.length} / {MAX}</span>
            {owner?.goal && <Button type="button" size={28} variant="ghost" disabled={!!busy} onClick={() => setConfirm('clear')}>Clear goal</Button>}
            <Button type="button" size={28} variant="ghost" disabled={!!busy} onClick={() => { setDraft(null); setShowLatest(false); }}>Cancel</Button>
            <Button type="submit" size={28} variant="primary" busy={busy === 'save'} busyLabel="Saving…" disabled={!draft.trim() || !!busy}>Save goal</Button>
          </div>
        </form>
      ) : owner?.unreadable ? (
        <p role="note" style={{ margin: 0, fontSize: 13, color: 'var(--warn-tx)' }}>
          A goal is saved but can’t be opened on this engine. Setting one replaces it.
        </p>
      ) : owner?.goal ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <span><Tag tone="brand">Set by you</Tag></span>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--tx)', whiteSpace: 'pre-wrap' }}>{owner.goal}</p>
          <span style={{ fontSize: 12, color: 'var(--tx2)' }}>Updated {fmtTime(owner.updated_at)}{who ? ` ${who}` : ''} · applies to every task</span>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>
          No goal set. Until you set one, WhiteRoom uses the goal the agent gives, or its first message in the task.
        </p>
      )}
      {note && <p role={note.ok ? 'status' : 'alert'} style={{ margin: '10px 0 0', fontSize: 12.5, color: note.ok ? 'var(--tx2)' : 'var(--bad)' }}>{note.text}</p>}

      <ConfirmDialog
        open={confirm === 'clear'}
        title="Clear this agent’s goal?"
        body="The agent goes back to working toward its own goal, or its first message in the task."
        confirmLabel="Clear goal"
        cancelLabel="Keep goal"
        tone="neutral"
        busy={busy === 'clear'}
        onConfirm={() => void run('clear', () => goalSetOwner(fleetId, agentId, null, seen), (r) => { setOwner(r.owner); setDraft(null); }, 'Goal cleared.', (r) => !!r && 'owner' in r)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'run'}
        title="Start a new task?"
        body="Clears goals the agent set for itself, and per-task limits in Controls start over. Your goal stays, and its notes and history aren’t affected."
        confirmLabel="Start a new task"
        tone="neutral"
        busy={busy === 'run'}
        onConfirm={() => void run('run', () => agentNewRun(fleetId, agentId), () => {}, 'New task started.', (r) => r?.success === true)}
        onCancel={() => setConfirm(null)}
      />
    </Panel>
  );
}
