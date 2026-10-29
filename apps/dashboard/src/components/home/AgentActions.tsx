'use client';

import { useEffect, useRef, useState } from 'react';
import { Toast } from '@whiteroom/ui';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { StopNotes } from '@/components/citadel/StopNotes';
import { checkWatch, controlFailure, pauseAgent, resumeAgent, stopAgent } from '@/lib/whiteroom/client';
import type { AgentHold, AgentInfo } from '@/lib/whiteroom/types';

export type Act = 'pause' | 'stop' | 'resume';

/** What the ⋯ offers: Resume for a held agent, else Pause and Stop…. */
export function agentMenu(agent: Pick<AgentInfo, 'hold'>): { act: Act; label: string }[] {
  return agent.hold
    ? [{ act: 'resume', label: 'Resume' }]
    : [{ act: 'pause', label: 'Pause' }, { act: 'stop', label: 'Stop…' }];
}
const CALL: Record<Act, typeof pauseAgent> = { pause: pauseAgent, stop: stopAgent, resume: resumeAgent };
const VERB: Record<Act, string> = { pause: 'pause', stop: 'stop', resume: 'resume' };

/**
 * A toast the Home page shows once, whichever agent raised it: the newest
 * replaces the older one. `owner` is the agent whose ⋯ renders it, so its Undo
 * sits in the tab order right after that ⋯.
 */
export interface PageToast {
  key: string;
  owner: string;
  message: string;
  action?: { label: string; onClick: () => void };
}
export interface PageToasts {
  current: PageToast | null;
  /** Shows a toast, replacing any other. */
  show: (t: PageToast) => void;
  /** Replaces or clears a toast, only while it's still the one shown. */
  update: (key: string, t: PageToast | null) => void;
}

/** A hold this Pause made: paused, and not one that replaced an earlier hold (which keeps its first `since`). */
export function ownPause(hold: AgentHold | null | undefined): AgentHold | null {
  if (!hold || hold.state !== 'paused') return null;
  if (hold.since && hold.since !== hold.at) return null;
  return hold;
}

/** The toast after an act, from the hold the engine returned. Undo only for a pause this act made. */
export function actToast(agentId: string, act: Act, hold: AgentHold | null | undefined): { message: string; undo: boolean } {
  if (act === 'resume') return { message: `${agentId} resumed.`, undo: false };
  if (act === 'stop') return { message: `${agentId} stopped.`, undo: false };
  if (hold?.state === 'stopped') return { message: `${agentId} is stopped; Pause didn’t change that.`, undo: false };
  if (hold?.state === 'paused' && !ownPause(hold)) return { message: `${agentId} was already held, so there’s nothing to undo.`, undo: false };
  // Older engines don't return the hold: no Undo, since it can't tell its own pause from another.
  return { message: `${agentId} paused.`, undo: !!ownPause(hold) };
}

/**
 * The ⋯ on a Home agent card or table row (Rev 9 §7): Pause, Stop… or Resume
 * without opening the agent. Gov v1 fleets only. Pause acts at once and says
 * so in a toast with Undo; Stop asks for the agent's name first. A failure
 * stays on screen until dismissed. The menu works from the keyboard: arrows,
 * Home and End move, Escape closes it and focus goes back to the ⋯.
 */
export function AgentActions({ agent, fleetId, authKey, onChanged, onAuthError, preview = false, toasts }: {
  agent: AgentInfo;
  fleetId: string;
  authKey?: string;
  /** After an act: what it did and the hold it left (a real page reloads; a preview applies it). */
  onChanged: (change?: { act: Act; hold: AgentHold | null }) => void;
  /** The page's session-expired handler; without one, a note asks to reload. */
  onAuthError?: (message: string) => void;
  /** /dev/home: the menu, toast and Undo work, but nothing is sent. */
  preview?: boolean;
  /** The page's one toast; without it (a lone ⋯), this keeps its own. */
  toasts?: PageToasts;
}) {
  const [open, setOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownToast, setOwnToast] = useState<PageToast | null>(null);
  const local: PageToasts = {
    current: ownToast,
    show: setOwnToast,
    update: (key, t) => setOwnToast((cur) => (cur?.key === key ? t : cur)),
  };
  const page = toasts ?? local;
  const shown = page.current?.owner === agent.agentId ? page.current : null;
  // The hold this Pause set, as the engine returned it, so Undo can tell its own pause from any other.
  const ownHold = useRef<AgentHold | null>(null);
  const previewHold = useRef<AgentHold | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!busy && refocus.current) { refocus.current = false; trigger.current?.focus(); }
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    // The first item takes focus when the menu opens.
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  function menuKey(e: React.KeyboardEvent) {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  }

  function say(message: string, undo: boolean) {
    const key = `${agent.agentId}-${Date.now()}-${Math.random()}`;
    page.show({ key, owner: agent.agentId, message, action: undo ? { label: 'Undo', onClick: () => void undoPause(key) } : undefined });
  }

  /**
   * One act. `guard` runs just before the call (Undo's last hold check), so
   * nothing else happens between the check and the call.
   */
  async function run(act: Act, guard?: () => Promise<boolean>) {
    setOpen(false);
    setConfirmStop(false);
    setError(null);
    setBusy(true);
    try {
      if (guard && !(await guard())) return;
      const res: { hold?: AgentHold | null } = preview
        ? { hold: (previewHold.current = act === 'resume' ? null : { state: act === 'stop' ? 'stopped' : 'paused', by: 'preview', reason: null, at: new Date().toISOString() }) }
        : await CALL[act](fleetId, agent.agentId, authKey);
      if (act === 'pause') ownHold.current = ownPause(res.hold);
      const t = actToast(agent.agentId, act, res.hold);
      say(t.message, t.undo);
      onChanged({ act, hold: res.hold ?? null });
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
      // Focus comes back to the ⋯ once it's enabled again, so the toast's Undo is the next Tab stop.
      refocus.current = true;
    }
  }

  // Undo puts back only the pause this toast is about. Once a refresh shows
  // the agent in any other state (stopped by someone, resumed by someone
  // else), Undo would lift a hold it didn't make, so it's withdrawn.
  const holdState = agent.hold?.state ?? null;
  const sawPause = useRef(false);
  const undoKey = shown?.action ? shown.key : null;
  useEffect(() => {
    if (!undoKey) { sawPause.current = false; return; }
    if (holdState === 'paused') sawPause.current = true;
    else if (holdState !== null || sawPause.current) page.update(undoKey, { key: undoKey, owner: agent.agentId, message: shown!.message });
    // page and shown change identity every render; the key and the hold are what matter.
  }, [holdState, undoKey]);

  // Undo reads the agent right before resuming and resumes only while it's
  // still held by this exact pause (same time and same person as the engine
  // returned). A stop, another pause or a resume by someone else is left
  // alone. A stop landing between the read and the resume could still be
  // lifted: closing that needs an engine resume_agent that takes the hold's
  // time (if_hold_at), a follow-up.
  async function undoPause(key: string) {
    page.update(key, null);
    const own = ownHold.current;
    await run('resume', async () => {
      let hold: AgentHold | null | undefined;
      try {
        hold = preview ? previewHold.current : (await checkWatch(agent.agentId, fleetId, authKey)).hold;
      } catch {
        setError(`Couldn’t check ${agent.agentId} before undoing. Nothing changed.`);
        return false;
      }
      if (own && hold?.state === 'paused' && hold.at === own.at && hold.by === own.by) return true;
      say(`${agent.agentId} was held or resumed again since. Nothing changed.`, false);
      onChanged();
      return false;
    });
  }

  const items = agentMenu(agent);

  return (
    <div ref={root} className="wr-agent-actions">
      <button ref={trigger} type="button" className="wr-agent-actions__btn" aria-label={`Actions for ${agent.agentId}`} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((o) => !o)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
      </button>
      {shown && (
        <Toast
          message={shown.message}
          action={shown.action}
          // Only this toast: Undo's own "resumed." may already have replaced it.
          onClose={() => page.update(shown.key, null)}
        />
      )}
      {open && (
        <div ref={menu} role="menu" aria-label={`Actions for ${agent.agentId}`} className="wr-agent-actions__menu" onKeyDown={menuKey}>
          {items.map((i) => (
            <button key={i.act} type="button" role="menuitem" tabIndex={-1} className="wr-agent-actions__item" data-danger={i.act === 'stop' || undefined}
              onClick={() => (i.act === 'stop' ? (setOpen(false), setConfirmStop(true)) : void run(i.act))}>
              {i.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div role="alert" className="wr-agent-actions__error">
          <span>{error}</span>
          <button type="button" className="wr-agent-actions__dismiss" aria-label="Dismiss" onClick={() => { setError(null); trigger.current?.focus(); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmStop}
        title={`Stop ${agent.agentId}?`}
        body={<>It refuses every call until someone resumes it, even after a restart. Its current run ends.<StopNotes /></>}
        confirmLabel="Stop agent"
        confirmPhrase={agent.agentId}
        busy={busy}
        onConfirm={() => void run('stop')}
        onCancel={() => { setConfirmStop(false); trigger.current?.focus(); }}
      />
    </div>
  );
}
