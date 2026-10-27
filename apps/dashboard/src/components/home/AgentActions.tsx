'use client';

import { useEffect, useRef, useState } from 'react';
import { Toast } from '@whiteroom/ui';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { UNNAMED_CALLS_REFUSED } from '@/lib/setup';
import { checkWatch, controlFailure, pauseAgent, resumeAgent, stopAgent } from '@/lib/whiteroom/client';
import type { AgentInfo } from '@/lib/whiteroom/types';

export type Act = 'pause' | 'stop' | 'resume';

/** What the ⋯ offers: Resume for a held agent, else Pause and Stop…. */
export function agentMenu(agent: Pick<AgentInfo, 'hold'>): { act: Act; label: string }[] {
  return agent.hold
    ? [{ act: 'resume', label: 'Resume' }]
    : [{ act: 'pause', label: 'Pause' }, { act: 'stop', label: 'Stop…' }];
}
const CALL: Record<Act, typeof pauseAgent> = { pause: pauseAgent, stop: stopAgent, resume: resumeAgent };
const VERB: Record<Act, string> = { pause: 'pause', stop: 'stop', resume: 'resume' };
const DONE: Record<Act, string> = { pause: 'paused', stop: 'stopped', resume: 'resumed' };
/** What Undo does after each act: a Pause is undone by Resume. A Stop has no Undo (it was confirmed by name); a Resume none either. */
const UNDO: Partial<Record<Act, Act>> = { pause: 'resume' };

/**
 * The ⋯ on a Home agent card or table row (Rev 9 §7): Pause, Stop… or Resume
 * without opening the agent. Gov v1 fleets only. Pause acts at once and says
 * so in a toast with Undo; Stop asks for the agent's name first. A failure
 * stays on screen until dismissed.
 */
export function AgentActions({ agent, fleetId, authKey, onChanged, onAuthError }: {
  agent: AgentInfo;
  fleetId: string;
  authKey?: string;
  onChanged: () => void;
  /** The page's session-expired handler; without one, a note asks to reload. */
  onAuthError?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; undo?: Act } | null>(null);
  // When this Pause was made, so Undo can tell its own pause from a later one.
  const pausedAt = useRef(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  async function run(act: Act) {
    setOpen(false);
    setConfirmStop(false);
    setError(null);
    setToast(null);
    setBusy(true);
    try {
      await CALL[act](fleetId, agent.agentId, authKey);
      if (act === 'pause') pausedAt.current = Date.now();
      setToast({ message: `${agent.agentId} ${DONE[act]}.`, undo: UNDO[act] });
      onChanged();
    } catch (e) {
      const failure = controlFailure(e);
      if (failure === 'sign-out') {
        if (onAuthError) onAuthError('Session expired. Please sign in again.');
        else setError('Your session expired. Reload the page to sign in again.');
        return;
      }
      setError(failure === 'refused' ? (e as Error).message : `Couldn’t ${VERB[act]} ${agent.agentId}. Nothing changed.`);
    } finally {
      setBusy(false);
    }
  }

  // Undo puts back only the pause this toast is about. Once a refresh shows
  // the agent in any other state (stopped by a rule, resumed by someone
  // else), Undo would lift a hold it didn't make, so it's withdrawn.
  const holdState = agent.hold?.state ?? null;
  const sawPause = useRef(false);
  useEffect(() => {
    if (toast?.undo !== 'resume') { sawPause.current = false; return; }
    if (holdState === 'paused') sawPause.current = true;
    else if (holdState !== null || sawPause.current) setToast((t) => (t ? { message: t.message } : t));
  }, [holdState, toast?.undo]);

  // Undo reads the agent first and resumes only while it's still held by
  // this pause: paused, and paused within a minute of when it was made. A
  // stop, a later pause or a resume by someone else is left alone.
  async function undoPause() {
    setToast(null);
    setError(null);
    let hold: AgentInfo['hold'];
    try {
      hold = (await checkWatch(agent.agentId, fleetId, authKey)).hold;
    } catch {
      setError(`Couldn’t check ${agent.agentId} before undoing. Nothing changed.`);
      return;
    }
    const at = hold ? Date.parse(hold.at) : NaN;
    const ours = hold?.state === 'paused' && (Number.isNaN(at) || Math.abs(at - pausedAt.current) <= 60_000);
    if (!ours) {
      setToast({ message: `${agent.agentId} was held or resumed again since. Nothing changed.` });
      onChanged();
      return;
    }
    await run('resume');
  }

  const items = agentMenu(agent);

  return (
    <div ref={root} className="wr-agent-actions">
      <button type="button" className="wr-agent-actions__btn" aria-label={`Actions for ${agent.agentId}`} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((o) => !o)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
      </button>
      {open && (
        <div role="menu" className="wr-agent-actions__menu">
          {items.map((i) => (
            <button key={i.act} type="button" role="menuitem" className="wr-agent-actions__item" data-danger={i.act === 'stop' || undefined}
              onClick={() => (i.act === 'stop' ? (setOpen(false), setConfirmStop(true)) : void run(i.act))}>
              {i.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div role="alert" className="wr-agent-actions__error">
          <span>{error}</span>
          <button type="button" className="wr-agent-actions__dismiss" aria-label="Dismiss" onClick={() => setError(null)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}
      {toast && (
        <Toast
          message={toast.message}
          action={toast.undo ? { label: 'Undo', onClick: () => void undoPause() } : undefined}
          onClose={() => setToast(null)}
        />
      )}
      <ConfirmDialog
        open={confirmStop}
        title={`Stop ${agent.agentId}?`}
        body={<>It refuses every call until someone resumes it, even after a restart. Its current run ends.<span style={{ display: 'block', marginTop: 8 }}>{UNNAMED_CALLS_REFUSED}</span></>}
        confirmLabel="Stop agent"
        confirmPhrase={agent.agentId}
        busy={busy}
        onConfirm={() => void run('stop')}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  );
}
