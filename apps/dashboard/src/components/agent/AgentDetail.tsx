'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Hint, Panel, StatusPill, Tag, TextInput, FONT_MONO, type AgentState } from '@whiteroom/ui';
import { auditLog, checkWatch, controlFailure, getHandover, isAuthError, pauseAgent, resumeAgent, stopAgent, updateAgentTaskType } from '@/lib/whiteroom/client';
import type { AgentInfo, AuditEntry, HandoverDoc } from '@/lib/whiteroom/types';
import { usePoll } from '@/hooks/usePoll';
import { fmtTime, fmtTokens } from '@/lib/format';
import { HELP } from '@/lib/metric-definitions';
import { ROUTES } from '@/lib/routes';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { ActivityRows } from '@/components/home/ActivityRows';
import { RecentRuns } from '@/components/agent/RecentRuns';
import { fetchControlActors, holdWho, type ControlActor } from '@/lib/control-actors';
import { RefreshFailed } from '@/components/citadel/States';
import { agentState, clock, latestActivity } from '@/lib/home';
import {
  breakEndsAt, canResume, canStartBreak, handoverLines, notesAreLong, isNotFound, lastModel, notesStatus, shiftProgress, shiftSummary,
} from '@/lib/agent-detail';

type Pending = 'pausing' | 'stopping' | 'resuming' | null;

/**
 * Agent detail (redesign screen 3): one agent's shift, handover notes, task
 * type and latest activity, with the actions today's engine supports.
 * Actions are not optimistic: the pill reads "Pausing…" / "Resuming…" until
 * the engine reports the new status, and a failure stays on screen.
 */
export function AgentDetail({ fleetId, authKey, agentId, from, onAuthError, preview }: {
  fleetId: string;
  authKey?: string;
  agentId: string;
  /** Where the visitor came from, for the breadcrumb. */
  from: 'home' | 'runs';
  onAuthError?: (msg: string) => void;
  /** Sample data for /dev/agent: nothing is fetched and actions do nothing. */
  preview?: { agent: AgentInfo; handover: HandoverDoc | null; entries: AuditEntry[] };
}) {
  const [agent, setAgent] = useState<AgentInfo | null>(preview?.agent ?? null);
  const [notFound, setNotFound] = useState(false);
  const [handover, setHandover] = useState<HandoverDoc | null>(preview?.handover ?? null);
  // The shift the shown notes belong to, and whether fetching the current
  // shift's notes failed.
  const [notesShift, setNotesShift] = useState<number | null | undefined>(preview ? (preview.agent.watchNumber ?? null) : undefined);
  const [notesFailed, setNotesFailed] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>(preview?.entries ?? []);
  const [failing, setFailing] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  // No retry for a refusal: asking again gets the same answer.
  const [actionError, setActionError] = useState<{ text: string; retry?: () => void } | null>(null);
  const [confirmBreak, setConfirmBreak] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [actors, setActors] = useState<ControlActor[]>([]);
  // Who set the hold: looked up once per hold, not on every poll.
  const holdAt = agent?.hold?.at;
  useEffect(() => {
    if (!holdAt || preview) return;
    let live = true;
    fetchControlActors(fleetId).then((a) => { if (live) setActors(a); });
    return () => { live = false; };
  }, [fleetId, holdAt, preview]);
  const [notesOpen, setNotesOpen] = useState(false);
  const resumingHold = useRef(false);
  const [taskDraft, setTaskDraft] = useState<string | null>(null);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskNote, setTaskNote] = useState<{ ok: boolean; text: string } | null>(null);
  const lastShift = useRef<number | null>(null);
  // The shift whose handover is being fetched right now, so a slow or failing
  // request isn't started again by every 2s poll while an action is pending.
  const handoverInFlight = useRef<number | null | undefined>(undefined);
  // Break and shift gates depend on the clock, not only on new data: tick
  // every 15s so Resume enables and "min left" counts down between polls.
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
      // Handover notes change once per shift; fetch them when the shift does.
      // The shift is remembered only after a successful fetch, so a failed
      // one is retried on the next poll.
      const shift = res.watchNumber ?? null;
      if (shift !== lastShift.current && handoverInFlight.current !== shift) {
        handoverInFlight.current = shift;
        getHandover(agentId, fleetId, authKey)
          .then((h) => {
            if (stale()) return;
            if (h.error) { setNotesFailed(true); return; }
            lastShift.current = shift;
            setHandover(h.handoverDoc ?? h.lastHandoverDoc ?? null);
            setNotesShift(shift);
            setNotesFailed(false);
          })
          .catch(() => { if (!stale()) setNotesFailed(true); })
          .finally(() => {
            if (handoverInFlight.current === shift) handoverInFlight.current = undefined;
          });
      }
      const log = await logP;
      if (stale()) return;
      if (log instanceof Error) throw log;
      // An error payload is a failed refresh, not an empty history.
      if ('error' in log || !Array.isArray(log.entries)) throw new Error('activity unavailable');
      setEntries(log.entries);
      setFailing(false);
    } catch (e) {
      if (stale()) return;
      if (isAuthError(e)) { onAuthError?.('Session expired. Please sign in again.'); return; }
      setFailing(true);
    }
  }, [agentId, fleetId, authKey, onAuthError]);

  const { refresh, tick } = usePoll(load, { intervalMs: 10_000, enabled: !!fleetId && !preview });

  // Clear the pending pill once the engine reports the status we asked for.
  useEffect(() => {
    if (!pending || !agent) return;
    const s = agentState(agent);
    const held = s === 'paused' || s === 'stopped';
    // Releasing a hold is done once it's gone, whatever the watch status underneath.
    const resumed = resumingHold.current ? !held : s !== 'resting' && !held;
    if ((pending === 'pausing' && (s === 'resting' || held)) || (pending === 'stopping' && s === 'stopped') || (pending === 'resuming' && resumed)) setPending(null);
  }, [pending, agent]);

  // While waiting for confirmation, check more often than the 10s poll. A
  // tick, not a refresh: a refresh would cancel a request still in flight,
  // so a slow engine would never confirm.
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(tick, 2000);
    const giveUp = setTimeout(() => {
      setPending(null);
      setActionError({ text: 'WhiteRoom accepted the request but hasn’t confirmed the new status yet. It may still change; refresh in a moment.', retry: refresh });
    }, 20_000);
    return () => { clearInterval(id); clearTimeout(giveUp); };
  }, [pending, refresh, tick]);

  async function startBreak() {
    setConfirmBreak(false);
    if (preview) return;
    setActionError(null);
    setPending('pausing');
    try {
      await pauseAgent(fleetId, agentId, authKey);
      refresh();
    } catch (e) {
      setPending(null);
      const failure = controlFailure(e);
      if (failure === 'sign-out') { onAuthError?.('Session expired. Please sign in again.'); return; }
      setActionError(failure === 'refused'
        ? { text: (e as Error).message }
        : { text: `Couldn’t start a break for ${agentId}. ${e instanceof Error ? e.message : ''} It’s still working; nothing changed.`, retry: startBreak });
    }
  }

  async function stop() {
    setConfirmStop(false);
    if (preview) return;
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

  async function resume() {
    if (preview) return;
    setActionError(null);
    resumingHold.current = !!agent?.hold;
    setPending('resuming');
    try {
      await resumeAgent(fleetId, agentId, authKey);
      refresh();
    } catch (e) {
      setPending(null);
      const failure = controlFailure(e);
      if (failure === 'sign-out') { onAuthError?.('Session expired. Please sign in again.'); return; }
      setActionError(failure === 'refused'
        ? { text: (e as Error).message }
        : { text: `Couldn’t resume ${agentId}. ${e instanceof Error ? e.message : ''}`, retry: resume });
    }
  }

  async function saveTaskType() {
    const value = (taskDraft ?? '').trim();
    if (!value || taskSaving) return;
    setTaskSaving(true);
    setTaskNote(null);
    try {
      await updateAgentTaskType(fleetId, agentId, value, authKey);
      // Show the saved value right away instead of the old one until the
      // next poll brings it back.
      setAgent((a) => (a ? { ...a, taskType: value } : a));
      setTaskDraft(null);
      setTaskNote({ ok: true, text: 'Saved.' });
      refresh();
    } catch {
      setTaskNote({ ok: false, text: 'Couldn’t save. Try again.' });
    } finally {
      setTaskSaving(false);
    }
  }

  const back = from === 'runs'
    ? <Link href={ROUTES.runs} className="wr-crumb">&larr; Runs</Link>
    : <Link href={ROUTES.home} className="wr-crumb">&larr; Home</Link>;
  const title = (
    <>
      {back}
      <span aria-hidden="true" style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)', fontWeight: 400 }}>/</span>
      <span style={{ fontFamily: FONT_MONO }}>{agentId}</span>
    </>
  );

  if (notFound) {
    return (
      <>
        <PageHeader title={title} fleetId={fleetId} />
        <div style={{ padding: 24 }}>
          <Panel title="Agent not found">
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--tx2)' }}>
              There’s no agent called <span style={{ fontFamily: FONT_MONO, color: 'var(--tx)' }}>{agentId}</span> in this fleet. <Link href={ROUTES.home} className="wr-link">Back to Home &rarr;</Link>
            </p>
          </Panel>
        </div>
      </>
    );
  }

  const state: AgentState | null = agent ? (pending ?? agentState(agent)) : null;
  // Gov v1 fleets hold the agent (Pause, Stop); others give it a break.
  const v1 = !!agent?.govV1;
  const breakGate = !agent ? { allowed: false } : v1 ? (agent.hold ? { allowed: false, why: `It’s already ${agent.hold.state}.` } : { allowed: true }) : canStartBreak(agent);
  const stopGate = v1 && agent?.hold?.state !== 'stopped';
  const resumeGate = agent ? canResume(agent, now) : { allowed: false };
  const progress = agent ? shiftProgress(agent, now) : null;
  const notesState = agent ? notesStatus(notesShift, agent.watchNumber ?? null, notesFailed) : 'loading';
  const notes = notesState === 'current' ? handoverLines(handover) : [];
  const notesLong = notesAreLong(notes);
  const model = lastModel(entries);
  const activity = latestActivity(entries, 8);
  const breakEnd = agent ? breakEndsAt(agent) : null;

  return (
    <>
      <PageHeader
        title={title}
        fleetId={fleetId}
        badge={state && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <StatusPill state={state} />
            {model && <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>{model}</span>}
          </span>
        )}
      >
        <Button variant="primary" disabled={!resumeGate.allowed || !!pending} title={resumeGate.why} onClick={resume} busy={pending === 'resuming'} busyLabel="Resuming…">Resume</Button>
        <Button disabled={!breakGate.allowed || !!pending} title={breakGate.why} onClick={() => setConfirmBreak(true)} busy={pending === 'pausing'} busyLabel="Pausing…">{v1 ? 'Pause' : 'Start a break'}</Button>
        {v1 && <Button disabled={!stopGate || !!pending} onClick={() => setConfirmStop(true)} busy={pending === 'stopping'} busyLabel="Stopping…">Stop&hellip;</Button>}
      </PageHeader>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
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
              {agentId} is on a break{breakEnd ? ` until ${clock(breakEnd)}` : ''}. It starts again on its own when the break ends{resumeGate.allowed ? '; you can also resume it now.' : '.'}
            </Banner>
          )}

          {!agent ? (
            <div className="wr-agent-grid" aria-busy="true">
              {[220, 180].map((h, i) => <div key={i} style={{ height: h, borderRadius: 14, background: 'var(--card)', border: '1px solid var(--line)' }} />)}
            </div>
          ) : (
            <div className="wr-agent-grid">
              <div style={{ display: 'grid', gap: 16, alignContent: 'start', minWidth: 0 }}>
                <Panel title={<>Current shift<Hint text={HELP.currentShift} /></>} count={shiftSummary(agent, fmtTokens)}>
                  {progress && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 6 }}>
                        <span style={{ color: 'var(--tx2)' }}>{progress.onBreak ? 'Break progress' : 'Shift progress'}</span>
                        <span style={{ fontFamily: FONT_MONO }}>{progress.label}</span>
                      </div>
                      <div role="progressbar" aria-valuenow={Math.round(progress.pct)} aria-valuemin={0} aria-valuemax={100} aria-label={progress.onBreak ? 'Break progress' : 'Shift progress'} style={{ height: 5, borderRadius: 3, background: 'var(--track)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${progress.pct}%`, background: progress.onBreak ? 'var(--tx2)' : 'var(--brand)' }} />
                      </div>
                    </div>
                  )}
                </Panel>

                <Panel
                  title={<>Handover notes<Hint text={HELP.handoverNotes} /></>}
                  actions={notesState === 'current' && handover?.session_stats ? <Tag tone="ho">{handover.session_stats.tasks_completed} tasks → notes</Tag> : undefined}
                >
                  {notesState !== 'current' ? (
                    <p role={notesState === 'failed' ? 'status' : undefined} style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>
                      {notesState === 'failed' ? 'Couldn’t load this shift’s notes. Retrying…' : 'Loading notes…'}
                    </p>
                  ) : notes.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>
                      {(agent.watchNumber ?? 1) > 1
                        ? 'No handover notes saved for this agent.'
                        : 'No handover yet. Notes appear here after this agent’s first shift ends.'}
                    </p>
                  ) : (
                    <div style={{ display: 'grid', gap: 8, fontSize: 13, lineHeight: 1.5, color: 'var(--tx2)' }}>
                      {/* Long notes start as two lines each; the toggle shows them in full. */}
                      {notes.map((n) => (
                        <div key={n.label} className={notesLong && !notesOpen ? 'wr-clamp-2' : undefined}>
                          <span style={{ color: 'var(--tx)', fontWeight: 600 }}>{n.label}</span> · {n.text}
                        </div>
                      ))}
                      {notesLong && (
                        <button type="button" className="wr-link" aria-expanded={notesOpen} onClick={() => setNotesOpen((o) => !o)} style={{ justifySelf: 'start', background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: 12.5 }}>
                          {notesOpen ? 'Show less' : 'Show full notes'}
                        </button>
                      )}
                    </div>
                  )}
                </Panel>

                <Panel title={<>Task type<Hint text={HELP.taskType} /></>}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TextInput
                        ariaLabel="Task type"
                        value={taskDraft ?? agent.taskType ?? ''}
                        onChange={setTaskDraft}
                        placeholder="e.g. claims triage"
                        className="w-full"
                      />
                    </div>
                    <Button variant="primary" disabled={taskDraft === null || !taskDraft.trim()} busy={taskSaving} busyLabel="Saving…" onClick={saveTaskType}>Save</Button>
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 12, color: taskNote ? (taskNote.ok ? 'var(--ok)' : 'var(--bad)') : 'var(--tx2)' }} role={taskNote ? 'status' : undefined}>
                    {taskNote ? taskNote.text : 'Keys the per-task cost estimate on Performance.'}
                  </p>
                </Panel>
              </div>

              <div style={{ display: 'grid', gap: 16, alignContent: 'start', minWidth: 0 }}>
                <RecentRuns fleetId={fleetId} authKey={authKey} agentId={agentId} preview={preview ? [] : undefined} />
                <Panel title="Recent activity" bodyPadding={0}>
                  <ActivityRows rows={activity} empty="Nothing yet for this agent." />
                </Panel>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmBreak}
        tone="neutral"
        title={v1 ? `Pause ${agentId}?` : `Give ${agentId} a break now?`}
        body={v1
          ? <>Its current run ends. It can&rsquo;t make calls until someone resumes it, even after a restart.</>
          : <>It stops making calls and takes its scheduled break now, instead of at the end of this shift. It starts again on its own when the break ends.</>}
        confirmLabel={v1 ? 'Pause' : 'Start the break'}
        onConfirm={startBreak}
        onCancel={() => setConfirmBreak(false)}
      />
      <ConfirmDialog
        open={confirmStop}
        title={`Stop ${agentId}?`}
        body={<>The agent refuses every call until someone resumes it, even after a restart. Stop overrides a pause.</>}
        confirmLabel="Stop agent"
        confirmPhrase={agentId}
        onConfirm={stop}
        onCancel={() => setConfirmStop(false)}
      />
    </>
  );
}
