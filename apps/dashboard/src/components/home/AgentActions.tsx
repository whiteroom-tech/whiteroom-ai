'use client';

import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { controlFailure, pauseAgent, resumeAgent, stopAgent } from '@/lib/whiteroom/client';
import type { AgentInfo } from '@/lib/whiteroom/types';

type Act = 'pause' | 'stop' | 'resume';
const CALL: Record<Act, typeof pauseAgent> = { pause: pauseAgent, stop: stopAgent, resume: resumeAgent };
const VERB: Record<Act, string> = { pause: 'pause', stop: 'stop', resume: 'resume' };

/**
 * The ⋯ on a Home agent card (Rev 9 §7): Pause, Stop… or Resume without
 * opening the agent. Gov v1 fleets only; elsewhere Agent detail has the
 * break controls. Sits beside the card's link, never inside it.
 */
export function AgentActions({ agent, fleetId, authKey, onChanged }: {
  agent: AgentInfo;
  fleetId: string;
  authKey?: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setBusy(true);
    try {
      await CALL[act](fleetId, agent.agentId, authKey);
      onChanged();
    } catch (e) {
      const failure = controlFailure(e);
      if (failure === 'sign-out') { setError('Your session expired. Reload the page to sign in again.'); return; }
      setError(failure === 'refused' ? (e as Error).message : `Couldn’t ${VERB[act]} ${agent.agentId}. Nothing changed.`);
    } finally {
      setBusy(false);
    }
  }

  const items: { act: Act; label: string }[] = agent.hold
    ? [{ act: 'resume', label: 'Resume' }]
    : [{ act: 'pause', label: 'Pause' }, { act: 'stop', label: 'Stop…' }];

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
      {error && <p role="alert" className="wr-agent-actions__error">{error}</p>}
      <ConfirmDialog
        open={confirmStop}
        title={`Stop ${agent.agentId}?`}
        body={<>It refuses every call until someone resumes it, even after a restart. Its current run ends.</>}
        confirmLabel="Stop agent"
        confirmPhrase={agent.agentId}
        busy={busy}
        onConfirm={() => void run('stop')}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  );
}
