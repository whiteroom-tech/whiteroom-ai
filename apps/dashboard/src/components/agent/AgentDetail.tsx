'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Banner, Button, Panel, TextInput, Toast, FONT_MONO } from '@whiteroom/ui';
import { auditLog, checkWatch, controlFailure, getDiagnosis, isAuthError, listRuns, pauseAgent, removeAgent, resumeAgent, stopAgent, updateAgentTaskType } from '@/lib/whiteroom/client';
import type { AgentInfo, AuditEntry, FleetDiagnosis, GovernanceRule, RunSummary } from '@/lib/whiteroom/types';
import type { AgentWeek } from '@/lib/home-agents';
import { usePoll } from '@/hooks/usePoll';
import { fmtTime } from '@/lib/format';
import { formatInZone } from '@/lib/zone-time';
import { ROUTES } from '@/lib/routes';
import { LiveStatus, PageHeader } from '@/components/citadel/PageChrome';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { SHARED_KEY_STOP_NOTE, UNNAMED_CALLS_REFUSED } from '@/lib/setup';
import { ActivityRows } from '@/components/home/ActivityRows';
import { RecentRuns, type RecentRunsState } from '@/components/agent/RecentRuns';
import { AgentWeekCard } from '@/components/agent/AgentWeekCard';
import { RulesOnAgent } from '@/components/agent/RulesOnAgent';
import { fetchControlActors, holdWho, type ControlActor } from '@/lib/control-actors';
import { RefreshFailed } from '@/components/citadel/States';
import { agentState, clock, latestActivity } from '@/lib/home';
import { runHref, runsDays } from '@/lib/runs';
import {
  agentHealthLine, breakEndsAt, canPause, canResume, headerAction, isNotFound, lastModel, nowCard, statusWords,
} from '@/lib/agent-detail';

type Pending = 'pausing' | 'stopping' | 'resuming' | 'removing' | null;

/** "Oct 24" in the viewer's time zone. */
const shortDate = (iso: string) => formatInZone(iso, { month: 'short', day: 'numeric' });

/**
 * Agent detail: one agent's last 7 days and score, a health line when the
 * fleet health check has looked at it, what it's doing now, its task type,
 * the rules on it, its recent runs and latest activity. The header has one
 * Pause / Resume button (Pause shows a toast with Undo) and a ⋯ menu with
 * Stop… and Remove…. Actions are not optimistic: the status reads
 * "Pausing…" / "Resuming…" until the engine reports it, and a failure stays
 * on screen.
 */
export function AgentDetail({ fleetId, authKey, agentId, from, onAuthError, preview }: {
  fleetId: string;
  authKey?: string;
  agentId: string;
  /** Where the visitor came from, for the breadcrumb. */
  from: 'home' | 'runs';
  onAuthError?: (msg: string) => void;
  /** Sample data for /dev/agent: nothing is fetched and actions do nothing. */
  preview?: { agent: AgentInfo; entries: AuditEntry[]; week?: AgentWeek; rules?: GovernanceRule[]; runs?: RunSummary[]; diagnosis?: FleetDiagnosis | null };
}) {
  const [agent, setAgent] = useState<AgentInfo | null>(preview?.agent ?? null);
  const [notFound, setNotFound] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>(preview?.entries ?? []);
  const [failing, setFailing] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  // No retry for a refusal: asking again gets the same answer.
  const [actionError, setActionError] = useState<{ text: string; retry?: () => void } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const taskInput = useRef<HTMLDivElement>(null);
  const [runs, setRuns] = useState<RecentRunsState>(preview ? { kind: 'ok', runs: preview.runs ?? [] } : { kind: 'loading' });
  const [diagnosis, setDiagnosis] = useState<FleetDiagnosis | null>(preview?.diagnosis ?? null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(preview ? Date.now() : null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const router = useRouter();
  const [actors, setActors] = useState<ControlActor[]>([]);
  // Who set the hold: looked up once per hold, not on every poll.
  const holdAt = agent?.hold?.at;
  useEffect(() => {
    if (!holdAt || preview) return;
    let live = true;
    // The hold can show up (a poll, another tab) before its row is written: try once more shortly.
    let retry: ReturnType<typeof setTimeout> | undefined;
    fetchControlActors(fleetId, holdAt).then((a) => {
      if (!live) return;
      setActors(a);
      if (a.length === 0) retry = setTimeout(() => { fetchControlActors(fleetId, holdAt).then((b) => { if (live) setActors(b); }); }, 5_000);
    });
    return () => { live = false; clearTimeout(retry); };
  }, [fleetId, holdAt, preview]);
  const resumingHold = useRef(false);
  // Whether the resume request in progress has returned.
  const resumeSent = useRef(false);
  const [taskDraft, setTaskDraft] = useState<string | null>(null);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskNote, setTaskNote] = useState<{ ok: boolean; text: string } | null>(null);
  // The Resume gate depends on the clock, not only on new data: tick every
  // 15s so it enables between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async (stale: () => boolean) => {
    try {
      // The activity request starts alongside the status one, not after it.
      const logP = auditLog({ fleetId, agentId, limit: 50 }, authKey).catch((e: unknown) => e as Error);
      const res = await checkWatch(agentId, fleetId, authKey);
      if (stale()) return;
      if (isNotFound(res)) { setNotFound(true); return; }
      const err = (res as { error?: string }).error;
      if (err) throw new Error(err);
      setNotFound(false);
      setAgent({ ...res, agentId });
      const log = await logP;
      if (stale()) return;
      if (log instanceof Error) throw log;
      // An error payload is a failed refresh, not an empty history.
      if ('error' in log || !Array.isArray(log.entries)) throw new Error('activity unavailable');
      setEntries(log.entries);
      setFailing(false);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) { onAuthError?.('Session expired. Please sign in again.'); return; }
      setFailing(true);
    }
  }, [agentId, fleetId, authKey, onAuthError]);

  const { refresh, tick } = usePoll(load, { intervalMs: 10_000, enabled: !!fleetId && !preview });

  // Recent runs, also the Now card's link to the last run: read again when the
  // run number changes or a run ends, so the list and the link stay current.
  // Another agent starts from Loading, never with the last one's runs. Waits
  // for the agent's status, so a visit reads the list once, not twice.
  const runNumber = agent ? `${agent.currentShift?.watchNumber ?? agent.lastShift?.watchNumber ?? agent.watchNumber ?? '-'}:${agent.currentShift ? 'running' : 'ended'}` : undefined;
  const runsFor = useRef<string | null>(null);
  useEffect(() => {
    if (preview || runNumber === undefined) return;
    if (runsFor.current !== `${fleetId}/${agentId}`) { runsFor.current = `${fleetId}/${agentId}`; setRuns({ kind: 'loading' }); }
    let live = true;
    listRuns(fleetId, { ...runsDays('7d'), agentId, pageSize: 5 }, authKey).then(
      (res) => { if (live) setRuns('unsupported' in res ? { kind: 'unsupported' } : { kind: 'ok', runs: res.runs }); },
      (e: unknown) => {
        if (!live) return;
        if (isAuthError(e)) { onAuthError?.('Session expired. Please sign in again.'); return; }
        setRuns((r) => (r.kind === 'ok' ? r : { kind: 'failed' }));
      },
    );
    return () => { live = false; };
  }, [fleetId, authKey, agentId, preview, runNumber, onAuthError]);

  // The fleet health check, read again on the same 5-minute cadence as
  // Performance. A check that's off or fails shows nothing.
  useEffect(() => {
    if (preview) return;
    setDiagnosis(null);
    let live = true;
    // A failed read hides the line rather than keep an old result; an expired session signs out.
    const read = () => {
      getDiagnosis(fleetId, authKey).then(
        (d) => { if (live) setDiagnosis(d); },
        (e: unknown) => {
          if (!live) return;
          setDiagnosis(null);
          if (isAuthError(e)) onAuthError?.('Session expired. Please sign in again.');
        },
      );
    };
    read();
    const id = setInterval(read, 5 * 60_000);
    return () => { live = false; clearInterval(id); };
  }, [fleetId, authKey, preview, onAuthError]);

  // The ⋯ menu, as a menu: focus moves to its first item on open, arrow keys
  // move between items, Escape closes it and returns focus to ⋯; a click
  // outside closes it.
  useEffect(() => {
    if (!menuOpen) return;
    const items = () => [...(menuRoot.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    items()[0]?.focus();
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); return; }
        if (e.key === 'Tab') { setMenuOpen(false); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const list = items();
          const at = list.indexOf(document.activeElement as HTMLButtonElement);
          const down = e.key === 'ArrowDown';
          // From outside the items, Down goes to the first and Up to the last.
          const next = at === -1 ? (down ? 0 : list.length - 1) : (at + (down ? 1 : -1) + list.length) % list.length;
          list[next]?.focus();
        }
        return;
      }
      if (!menuRoot.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [menuOpen]);

  // Clear the pending pill once the engine reports the status we asked for.
  useEffect(() => {
    if (!pending || !agent) return;
    const s = agentState(agent);
    const held = s === 'paused' || s === 'stopped';
    // Releasing a hold is done once it's gone, whatever the watch status
    // underneath, and only after the resume request has returned: a status
    // read before it (Undo right after Pause) proves nothing.
    const resumed = resumeSent.current && (resumingHold.current ? !held : s !== 'resting' && !held);
    if ((pending === 'pausing' && (s === 'resting' || held)) || (pending === 'stopping' && s === 'stopped') || (pending === 'resuming' && resumed)) setPending(null);
  }, [pending, agent]);

  // While waiting for confirmation, check more often than the 10s poll. A
  // tick, not a refresh: a refresh would cancel a request still in flight,
  // so a slow engine would never confirm.
  useEffect(() => {
    // Removing ends on Home; there's no status to wait for.
    if (!pending || pending === 'removing') return;
    const id = setInterval(tick, 2000);
    const giveUp = setTimeout(() => {
      setPending(null);
      setActionError({ text: 'WhiteRoom accepted the request but hasn’t confirmed the new status yet. It may still change; refresh in a moment.', retry: refresh });
    }, 20_000);
    return () => { clearInterval(id); clearTimeout(giveUp); };
  }, [pending, refresh, tick]);

  /** /dev/agent: actions change the sample agent on screen, and nothing is sent. */
  const previewHold = (state: 'paused' | 'stopped' | null) =>
    setAgent((a) => (a ? { ...a, hold: state ? { state, by: 'dashboard', reason: null, at: new Date().toISOString() } : null } : a));

  async function pause() {
    // A Gov v1 fleet holds the agent until someone resumes it, so Pause offers
    // Undo; an older fleet pauses it for a moment and it starts again on its own.
    const held = !!agent?.govV1;
    const toastFor = (): { text: string; undo?: () => void } => held
      ? { text: `${agentId} paused. It makes no calls until you resume it. ${UNNAMED_CALLS_REFUSED}`, undo: () => void resume(true) }
      : { text: `${agentId} is paused for a moment. It starts again on its own.` };
    if (preview) { if (held) previewHold('paused'); setToast(toastFor()); return; }
    setActionError(null);
    setPending('pausing');
    try {
      await pauseAgent(fleetId, agentId, authKey);
      refresh();
      setToast(toastFor());
    } catch (e) {
      setPending(null);
      const failure = controlFailure(e);
      if (failure === 'sign-out') { onAuthError?.('Session expired. Please sign in again.'); return; }
      setActionError(failure === 'refused'
        ? { text: (e as Error).message }
        : { text: `Couldn’t pause ${agentId}. ${e instanceof Error ? e.message : ''} Nothing changed.`, retry: pause });
    }
  }

  async function stop() {
    setConfirmStop(false);
    // A pause toast's Undo would release the stop.
    setToast(null);
    if (preview) { previewHold('stopped'); return; }
    setActionError(null);
    setPending('stopping');
    try {
      await stopAgent(fleetId, agentId, authKey);
      refresh();
    } catch (e) {
      setPending(null);
      const failure = controlFailure(e);
      if (failure === 'sign-out') { onAuthError?.('Session expired. Please sign in again.'); return; }
      setActionError(failure === 'refused'
        ? { text: (e as Error).message }
        : { text: `Couldn’t stop ${agentId}. ${e instanceof Error ? e.message : ''} Nothing changed.`, retry: stop });
    }
  }

  async function remove() {
    setConfirmRemove(false);
    setToast(null);
    if (preview) return;
    setActionError(null);
    setPending('removing');
    try {
      await removeAgent(fleetId, agentId, authKey);
      router.push(ROUTES.home);
    } catch (e) {
      setPending(null);
      const failure = controlFailure(e);
      if (failure === 'sign-out') { onAuthError?.('Session expired. Please sign in again.'); return; }
      setActionError(failure === 'refused'
        ? { text: (e as Error).message }
        : { text: `Couldn’t remove ${agentId}. ${e instanceof Error ? e.message : ''} Nothing changed.`, retry: remove });
    }
  }

  /** `held`: releasing a hold just made here (Undo), before a poll has shown it. */
  async function resume(held = false) {
    // A pause toast would now be wrong.
    setToast(null);
    if (preview) { previewHold(null); return; }
    setActionError(null);
    resumingHold.current = held || !!agent?.hold;
    resumeSent.current = false;
    setPending('resuming');
    try {
      await resumeAgent(fleetId, agentId, authKey);
      resumeSent.current = true;
      refresh();
    } catch (e) {
      setPending(null);
      const failure = controlFailure(e);
      if (failure === 'sign-out') { onAuthError?.('Session expired. Please sign in again.'); return; }
      setActionError(failure === 'refused'
        ? { text: (e as Error).message }
        : { text: `Couldn’t resume ${agentId}. ${e instanceof Error ? e.message : ''}`, retry: () => void resume(held) });
    }
  }

  async function saveTaskType() {
    const value = (taskDraft ?? '').trim();
    if (!value || taskSaving) return;
    setTaskSaving(true);
    setTaskNote(null);
    try {
      if (!preview) await updateAgentTaskType(fleetId, agentId, value, authKey);
      // Show the saved value right away instead of the old one until the
      // next poll brings it back.
      setAgent((a) => (a ? { ...a, taskType: value } : a));
      setTaskDraft(null);
      setTaskNote({ ok: true, text: 'Saved.' });
      if (!preview) refresh();
    } catch {
      setTaskNote({ ok: false, text: 'Couldn’t save. Try again.' });
    } finally {
      setTaskSaving(false);
    }
  }

  const back = from === 'runs'
    ? <Link href={ROUTES.runs} className="wr-crumb">&larr; Runs</Link>
    : <Link href={ROUTES.home} className="wr-crumb">&larr; Home</Link>;
  const title = <span style={{ fontFamily: FONT_MONO }}>{agentId}</span>;
  // "← Home" sits on its own line above the title, as on the run page.
  const crumb = <div className="wr-agent-crumb">{back}</div>;

  if (notFound) {
    return (
      <>
        {crumb}
        <PageHeader title={title} fleetId={fleetId} />
        <div style={{ padding: 24 }}>
          <Panel title="Agent not found">
            <p style={{ margin: 0, fontSize: 'var(--fs-md)', color: 'var(--tx2)' }}>
              There’s no agent called <span style={{ fontFamily: FONT_MONO, color: 'var(--tx)' }}>{agentId}</span> in this fleet. <Link href={ROUTES.home} className="wr-link">Back to Home &rarr;</Link>
            </p>
          </Panel>
        </div>
      </>
    );
  }

  const state = agent ? (pending ?? agentState(agent)) : null;
  const words = state ? statusWords(state) : null;
  const action = agent ? headerAction(agent) : 'pause';
  const pauseGate = agent ? canPause(agent) : { allowed: false };
  const resumeGate = agent ? canResume(agent, now) : { allowed: false };
  const gate = action === 'resume' ? resumeGate : pauseGate;
  const stopGate = !!agent?.govV1 && agent.hold?.state !== 'stopped';
  const model = lastModel(entries);
  const activity = latestActivity(entries, 8, Date.now(), { agentShown: true });
  const breakEnd = agent ? breakEndsAt(agent) : null;
  const health = agentHealthLine(diagnosis, agentId, now);
  const card = agent ? nowCard(agent, runs.kind === 'ok' ? runs.runs : null, shortDate) : null;
  const goToTaskType = () => {
    taskInput.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    taskInput.current?.querySelector('input')?.focus({ preventScroll: true });
  };

  return (
    <>
      {crumb}
      <PageHeader
        title={title}
        fleetId={fleetId}
        badge={<LiveStatus at={updatedAt} failing={failing} />}
      >
        {words && (
          <span className="wr-agent-status" data-tone={words.tone}>
            <span className="wr-agent-status__dot" aria-hidden="true" />{words.text}
          </span>
        )}
        {/* The model yields before the actions: cut with … rather than run under them. */}
        {model && <span className="wr-agent-model" title={model}>{model}</span>}
        <Button
          variant="primary"
          disabled={!agent || !gate.allowed || !!pending}
          title={gate.why}
          onClick={action === 'resume' ? () => void resume() : () => void pause()}
          busy={pending === 'pausing' || pending === 'resuming'}
          busyLabel={pending === 'resuming' ? 'Resuming…' : 'Pausing…'}
        >
          {action === 'resume' ? 'Resume' : 'Pause'}
        </Button>
        <div ref={menuRoot} className="wr-agent-menu">
          <Button ref={menuButton} aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} disabled={!agent || !!pending} onClick={() => setMenuOpen((o) => !o)}>&#x22EF;</Button>
          {menuOpen && (
            <div role="menu" className="wr-agent-menu__list">
              {agent?.govV1 && <button type="button" role="menuitem" className="wr-agent-menu__item" disabled={!stopGate} onClick={() => { setMenuOpen(false); setConfirmStop(true); }}>Stop&hellip;</button>}
              <button type="button" role="menuitem" className="wr-agent-menu__item" onClick={() => { setMenuOpen(false); setConfirmRemove(true); }}>Remove&hellip;</button>
            </div>
          )}
        </div>
      </PageHeader>

      <div className="wr-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div className="wr-agent-page">
          {actionError && (
            <Banner variant="error" actions={<>{actionError.retry && <Button size={28} onClick={() => { const r = actionError.retry; setActionError(null); r?.(); }}>Try again</Button>}<Button variant="ghost" size={28} onClick={() => setActionError(null)}>Dismiss</Button></>}>
              {actionError.text}
            </Banner>
          )}
          {agent?.hold && (
            <Banner variant="warn" icon={agent.hold.state === 'stopped' ? 'square' : 'pause'}>
              {agentId} was {agent.hold.state} at {fmtTime(agent.hold.at)} {holdWho(agent.hold, agentId, actors)}. It refuses every call until someone resumes it, even after a restart.
            </Banner>
          )}
          {failing && (
            <RefreshFailed />
          )}
          {state === 'resting' && (
            <Banner variant="info" icon="clock">
              {agentId} is paused{breakEnd ? ` until ${clock(breakEnd)}` : ' for a moment'}. It starts again on its own{action === 'resume' && resumeGate.allowed ? '; you can also resume it now.' : '.'}
            </Banner>
          )}

          {!agent || !card ? (
            <div className="wr-agent-grid" aria-busy="true">
              {[220, 180].map((h, i) => <div key={i} style={{ height: h, borderRadius: 14, background: 'var(--card)', border: '1px solid var(--line)' }} />)}
            </div>
          ) : (
            <>
            <AgentWeekCard fleetId={fleetId} authKey={authKey} agentId={agentId} preview={preview?.week} hasTaskType={!!agent.taskType} onSetTaskType={goToTaskType} />
            {health && (
              <p className="wr-agent-health" data-tone={health.tone}>
                <span className="wr-agent-health__label">Health check</span>
                <span>{health.text}</span>
                <Link href={`${ROUTES.performance}#agent-health-heading`} className="wr-link">Details on Performance &rarr;</Link>
              </p>
            )}
            <div className="wr-agent-grid">
              <div className="wr-agent-col">
                <Panel title="Now" actions={<span className="wr-agent-cap">{card.status}</span>}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {card.run ? (
                      <div>
                        {card.run.label} {card.runId ? <Link href={runHref(card.runId)} className="wr-link" style={{ fontFamily: FONT_MONO }}>#{card.run.number}</Link> : <span style={{ fontFamily: FONT_MONO }}>#{card.run.number}</span>}
                        {' · '}{card.run.tail}{card.runDate ? ` · ${card.runDate}` : ''}
                      </div>
                    ) : <div className="wr-agent-cap">No runs yet.</div>}
                    {card.allTime && <div className="wr-agent-cap">{card.allTime}</div>}
                  </div>
                </Panel>

                <Panel title="Task type">
                  <p className="wr-agent-cap" style={{ margin: '0 0 6px' }}>
                    {taskNote ? <span role="status" style={{ color: taskNote.ok ? 'var(--ok)' : 'var(--bad)' }}>{taskNote.text}</span> : 'Used to estimate cost per task on Performance'}
                  </p>
                  <div ref={taskInput} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TextInput
                        ariaLabel="Task type"
                        value={taskDraft ?? agent.taskType ?? ''}
                        onChange={setTaskDraft}
                        placeholder="e.g. claims triage"
                        className="w-full"
                      />
                    </div>
                    <Button disabled={taskDraft === null || !taskDraft.trim()} busy={taskSaving} busyLabel="Saving…" onClick={saveTaskType}>Save</Button>
                  </div>
                </Panel>

                <RulesOnAgent fleetId={fleetId} authKey={authKey} agentId={agentId} preview={preview ? (preview.rules ?? []) : undefined} />
              </div>

              <div className="wr-agent-col">
                <RecentRuns agentId={agentId} state={runs} />
                <Panel title="Recent activity" bodyPadding={0}>
                  <ActivityRows rows={activity} empty="Nothing yet for this agent." />
                </Panel>
              </div>
            </div>
            </>
          )}
        </div>
      </div>

      {toast && <Toast message={toast.text} action={toast.undo ? { label: 'Undo', onClick: toast.undo } : undefined} onClose={() => setToast(null)} />}
      <ConfirmDialog
        open={confirmStop}
        title={`Stop ${agentId}?`}
        body={<>The agent refuses every call until someone resumes it, even after a restart. Stop overrides a pause.<span style={{ display: 'block', marginTop: 8 }}>{UNNAMED_CALLS_REFUSED}</span><span style={{ display: 'block', marginTop: 8 }}>{SHARED_KEY_STOP_NOTE}</span></>}
        confirmLabel="Stop agent"
        confirmPhrase={agentId}
        onConfirm={stop}
        onCancel={() => setConfirmStop(false)}
      />
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${agentId}?`}
        body={<>It leaves this fleet’s agent lists. Its audit trail, rule history and rule actions stay.<span style={{ display: 'block', marginTop: 8 }}>If it makes another call through WhiteRoom, it comes back. To keep it from working, stop it instead.</span></>}
        confirmLabel="Remove agent"
        confirmPhrase={agentId}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
}
