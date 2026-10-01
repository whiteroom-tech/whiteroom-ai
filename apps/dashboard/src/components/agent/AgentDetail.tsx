'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Hint, Panel, StatusPill, Tag, TextInput, FONT_MONO, type AgentState } from '@whiteroom/ui';
import { auditLog, checkWatch, getHandover, isAuthError, pauseAgent, resumeAgent, updateAgentTaskType } from '@/lib/whiteroom/client';
import type { AgentInfo, AuditEntry, HandoverDoc } from '@/lib/whiteroom/types';
import { usePoll } from '@/hooks/usePoll';
import { fmtTokens } from '@/lib/format';
import { HELP } from '@/lib/metric-definitions';
import { ROUTES } from '@/lib/routes';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { agentState, clock, latestActivity } from '@/lib/home';
import {
  breakEndsAt, canResume, canStartBreak, handoverLines, isNotFound, lastModel, shiftProgress, shiftSummary,
} from '@/lib/agent-detail';

type Pending = 'pausing' | 'resuming' | null;

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
  const [entries, setEntries] = useState<AuditEntry[]>(preview?.entries ?? []);
  const [failing, setFailing] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [actionError, setActionError] = useState<{ text: string; retry: () => void } | null>(null);
  const [confirmBreak, setConfirmBreak] = useState(false);
  const [taskDraft, setTaskDraft] = useState<string | null>(null);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskNote, setTaskNote] = useState<{ ok: boolean; text: string } | null>(null);
  const lastShift = useRef<number | null>(null);
  // Break and shift gates depend on the clock, not only on new data: tick
  // every 15s so Resume enables and "min left" counts down between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async (stale: () => boolean) => {
    try {
      const res = await checkWatch(agentId, fleetId, authKey);
      if (stale()) return;
      if (isNotFound(res)) { setNotFound(true); return; }
      if ((res as { error?: string }).error) throw new Error((res as { error?: string }).error);
      setNotFound(false);
      setAgent({ ...res, agentId });
      // Handover notes change once per shift; fetch them when the shift does.
      // The shift is remembered only after a successful fetch, so a failed
      // one is retried on the next poll.
      const shift = res.watchNumber ?? null;
      if (shift !== lastShift.current) {
        getHandover(agentId, fleetId, authKey)
          .then((h) => {
            if (stale() || h.error) return;
            lastShift.current = shift;
            setHandover(h.handoverDoc ?? null);
          })
          .catch(() => {});
      }
      const log = await auditLog({ fleetId, agentId, limit: 50 }, authKey);
      if (stale()) return;
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

  const { refresh } = usePoll(load, { intervalMs: 10_000, enabled: !!fleetId && !preview });

  // Clear the pending pill once the engine reports the status we asked for.
  useEffect(() => {
    if (!pending || !agent) return;
    const s = agentState(agent);
    if ((pending === 'pausing' && s === 'resting') || (pending === 'resuming' && s === 'working')) setPending(null);
  }, [pending, agent]);

  // While waiting for confirmation, check more often than the 10s poll.
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(refresh, 2000);
    const giveUp = setTimeout(() => {
      setPending(null);
      setActionError({ text: 'WhiteRoom accepted the request but hasn’t confirmed the new status yet. It may still change; refresh in a moment.', retry: refresh });
    }, 20_000);
    return () => { clearInterval(id); clearTimeout(giveUp); };
  }, [pending, refresh]);

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
      setActionError({ text: `Couldn’t start a break for ${agentId}. ${e instanceof Error ? e.message : ''} It’s still working; nothing changed.`, retry: startBreak });
    }
  }

  async function resume() {
    if (preview) return;
    setActionError(null);
    setPending('resuming');
    try {
      await resumeAgent(fleetId, agentId, authKey);
      refresh();
    } catch (e) {
      setPending(null);
      setActionError({ text: `Couldn’t resume ${agentId}. ${e instanceof Error ? e.message : ''}`, retry: resume });
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
  const breakGate = agent ? canStartBreak(agent) : { allowed: false };
  const resumeGate = agent ? canResume(agent, now) : { allowed: false };
  const progress = agent ? shiftProgress(agent, now) : null;
  const notes = handoverLines(handover);
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
        <Button disabled={!breakGate.allowed || !!pending} title={breakGate.why} onClick={() => setConfirmBreak(true)} busy={pending === 'pausing'} busyLabel="Pausing…">Start a break</Button>
      </PageHeader>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {actionError && (
            <Banner variant="error" actions={<><Button size={28} onClick={() => { const r = actionError.retry; setActionError(null); r(); }}>Try again</Button><Button variant="ghost" size={28} onClick={() => setActionError(null)}>Dismiss</Button></>}>
              {actionError.text}
            </Banner>
          )}
          {failing && (
            <p role="status" style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)' }}>Couldn&rsquo;t refresh. Retrying&hellip; Showing the last data we had.</p>
          )}
          {agent && agentState(agent) === 'resting' && (
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
                  actions={handover?.session_stats ? <Tag tone="ho">{handover.session_stats.tasks_completed} tasks → notes</Tag> : undefined}
                >
                  {notes.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>No handover yet. Notes appear here after this agent’s first shift ends.</p>
                  ) : (
                    <div style={{ display: 'grid', gap: 8, fontSize: 13, lineHeight: 1.5, color: 'var(--tx2)' }}>
                      {notes.map((n) => <div key={n.label}><span style={{ color: 'var(--tx)', fontWeight: 600 }}>{n.label}</span> · {n.text}</div>)}
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
                <Panel title="Recent activity" bodyPadding={0} actions={<Link href={ROUTES.runs} className="wr-link">All runs &rarr;</Link>}>
                  {activity.length === 0 ? (
                    <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>Nothing yet for this agent.</p>
                  ) : activity.map((r) => (
                    <div key={r.key} className="wr-activity-row">
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--tx2)' }}>{r.time}</span>
                      <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.text}</span>
                      {r.tag ? <Tag tone={r.tag.tone}>{r.tag.label}</Tag> : <span />}
                    </div>
                  ))}
                </Panel>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmBreak}
        tone="neutral"
        title={`Give ${agentId} a break now?`}
        body={<>It stops making calls and takes its scheduled break now, instead of at the end of this shift. It starts again on its own when the break ends.</>}
        confirmLabel="Start the break"
        onConfirm={startBreak}
        onCancel={() => setConfirmBreak(false)}
      />
    </>
  );
}
