'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Hint, Icon, Panel, StatusPill, FONT_MONO } from '@whiteroom/ui';
import { controlFailure, listRuns, resumeAgent } from '@/lib/whiteroom/client';
import type { AgentHold, AgentInfo, RunSummary } from '@/lib/whiteroom/types';
import { removedHeld } from '@/lib/home';
import { usePoll } from '@/hooks/usePoll';
import { HELP } from '@/lib/metric-definitions';
import { fmtTime } from '@/lib/format';
import { flagText, ignoresFlagged, runHref, runsDays } from '@/lib/runs';
import { safeGet, safeSet } from '@/lib/safe-storage';

const SEEN_KEY = 'wr.needsYou.seenRuns';
const UNDO_MS = 5000;

function readSeen(): string[] {
  try { const v = JSON.parse(safeGet(SEEN_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

/**
 * Home › Needs you (README › Screens › 1a, P2.2): what only a person can
 * decide. Held agents (paused or stopped) until someone resumes them, and
 * today's flagged runs until marked as seen (kept in this browser). Hidden
 * until the engine reports holds or flags, so older engines show nothing.
 */
export function NeedsYou({ agents, holds, holdsKnown, fleet, onResumed }: {
  agents: AgentInfo[];
  /** The fleet report's holds, which include agents that were removed while held. */
  holds?: Record<string, AgentHold>;
  holdsKnown: boolean;
  fleet?: { fleetId: string; authKey?: string };
  /** After a Resume here: reload now rather than at the next poll. */
  onResumed?: () => void;
}) {
  const fleetId = fleet?.fleetId;
  const authKey = fleet?.authKey;
  const [flagged, setFlagged] = useState<RunSummary[] | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const [undo, setUndo] = useState<string | null>(null);
  useEffect(() => { setSeen(readSeen()); }, []);

  const load = useCallback(async (stale: () => boolean) => {
    if (!fleetId) return;
    const res = await listRuns(fleetId, { ...runsDays('today'), flagged: true, pageSize: 10 }, authKey).catch(() => null);
    if (stale() || !res || 'unsupported' in res) return;
    setFlagged(ignoresFlagged(res.runs) ? null : res.runs.filter((r) => r.flags?.length));
  }, [fleetId, authKey]);
  usePoll(load, { intervalMs: 60_000, enabled: !!fleetId });

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

  function markSeen(runId: string | null, add: boolean) {
    if (!runId) return;
    // From storage, not state: another tab may have marked runs since.
    const current = readSeen();
    const next = add ? [...current.filter((s) => s !== runId), runId].slice(-200) : current.filter((s) => s !== runId);
    setSeen(next);
    safeSet(SEEN_KEY, JSON.stringify(next));
    setUndo(add ? runId : null);
  }

  const held = agents.filter((a) => a.hold);
  // Held agents that were removed: no Agent detail to open, so Resume is here.
  const gone = removedHeld(holds, agents);
  const [resuming, setResuming] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  async function resume(agentId: string) {
    if (!fleetId) return;
    setResuming(agentId);
    setResumeError(null);
    try {
      await resumeAgent(fleetId, agentId, authKey);
      onResumed?.();
    } catch (e) {
      setResumeError(controlFailure(e) === 'refused' ? (e as Error).message : `Couldn’t resume ${agentId}. Nothing changed; try again.`);
    } finally {
      setResuming(null);
    }
  }
  const runs = (flagged ?? []).filter((r) => !seen.includes(r.runId));
  if (!holdsKnown && flagged === null) return null;
  const count = held.length + gone.length + runs.length;
  if (count === 0) {
    return (
      <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--tx2)' }}>
        <span style={{ display: 'flex', color: 'var(--ok)' }}><Icon name="check" size={14} /></span>
        Nothing needs you right now.
        {undo && <Button variant="ghost" size={28} onClick={() => markSeen(undo, false)}>Undo</Button>}
      </p>
    );
  }

  const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: 14, alignItems: 'center', padding: '12px 18px', borderBottom: '1px solid var(--line)', fontSize: 13 };
  return (
    <Panel title={<>Needs you<Hint text={HELP.needsYou} /></>} count={<span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: 'var(--warn)' }}>{count}</span>} bodyPadding={0}>
      {held.map((a) => (
        <div key={a.agentId} style={row}>
          <StatusPill state={a.hold!.state} />
          <span style={{ minWidth: 0 }}>
            <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>{a.agentId}</span> was {a.hold!.state} at {fmtTime(a.hold!.at)}. It won&rsquo;t make calls until someone resumes it.
          </span>
          <Link href={`/agents/${encodeURIComponent(a.agentId)}`} className="wr-link">Open agent &rarr;</Link>
        </div>
      ))}
      {gone.map(([agentId, hold]) => (
        <div key={`gone-${agentId}`} style={row}>
          <StatusPill state={hold.state} />
          <span style={{ minWidth: 0 }}>
            <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>{agentId}</span> was removed while {hold.state}. It&rsquo;s still {hold.state}: if it registers again, its calls are refused until someone resumes it.
          </span>
          {fleetId && <Button size={28} disabled={resuming === agentId} onClick={() => void resume(agentId)}>{resuming === agentId ? 'Resuming…' : 'Resume'}</Button>}
        </div>
      ))}
      {resumeError && <div role="alert" style={{ ...row, gridTemplateColumns: '1fr', color: 'var(--bad)' }}>{resumeError}</div>}
      {runs.map((r) => (
        <div key={r.runId} style={row}>
          <span style={{ display: 'flex', color: 'var(--warn)' }}><Icon name="alert" size={14} /></span>
          <Link href={runHref(r.runId)} className="wr-link" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Run {r.shift} · {r.agentId}: {flagText(r.flags![0])}
          </Link>
          <Button variant="ghost" size={28} onClick={() => markSeen(r.runId, true)}>Mark as seen</Button>
        </div>
      ))}
      {undo && (
        <div style={{ ...row, gridTemplateColumns: '1fr auto', color: 'var(--tx2)' }}>
          <span>Marked as seen.</span>
          <Button variant="ghost" size={28} onClick={() => markSeen(undo, false)}>Undo</Button>
        </div>
      )}
    </Panel>
  );
}
