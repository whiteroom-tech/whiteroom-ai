'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { FONT_MONO } from '@whiteroom/ui';
import { controlFailure, resumeAgent } from '@/lib/whiteroom/client';
import type { AgentHold, AgentInfo } from '@/lib/whiteroom/types';
import { removedHeld } from '@/lib/home';
import { tallyTotal, type GovernanceTally } from '@/lib/governance';
import { fmtCount, plural } from '@/lib/format';
import { ROUTES } from '@/lib/routes';

/**
 * Home's fact line (mockup): "No agents on hold · 0 flagged runs today ·
 * rules caught 0 calls today · Last 7 days →". Held agents are named with a
 * link each; one removed while held has its Resume here, since it has no
 * agent page. A part whose data the engine doesn't send is left out.
 */
export function HomeFacts({ agents, holds, holdsKnown, flaggedToday, todayRules, fleet, onResumed }: {
  agents: AgentInfo[];
  /** The fleet report's holds, which include agents that were removed while held. */
  holds?: Record<string, AgentHold>;
  holdsKnown: boolean;
  /** Today's flagged runs; null when unknown (older engines). */
  flaggedToday: number | null;
  todayRules: GovernanceTally | null;
  fleet?: { fleetId: string; authKey?: string };
  onResumed?: () => void;
}) {
  const held = agents.filter((a) => a.hold);
  const gone = removedHeld(holds, agents);
  const [resuming, setResuming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resume(agentId: string) {
    if (!fleet) return;
    setResuming(agentId);
    setError(null);
    try {
      await resumeAgent(fleet.fleetId, agentId, fleet.authKey);
      onResumed?.();
    } catch (e) {
      const failure = controlFailure(e);
      setError(
        failure === 'refused' ? (e as Error).message
        : failure === 'sign-out' ? 'Your session expired. Reload the page to sign in again.'
        : `Couldn’t resume ${agentId}. Nothing changed; try again.`,
      );
    } finally {
      setResuming(null);
    }
  }

  const count = held.length + gone.length;
  const parts: React.ReactNode[] = [];
  if (count > 0) {
    parts.push(
      <span key="holds">
        <strong style={{ color: 'var(--warn)' }}>{count} {plural(count, 'agent')} on hold:</strong>{' '}
        {held.map((a, i) => (
          <Fragment key={a.agentId}>
            {i > 0 && ', '}
            <Link href={`/agents/${encodeURIComponent(a.agentId)}`} className="wr-link"><span style={{ fontFamily: FONT_MONO, fontSize: '.92em' }}>{a.agentId}</span> ({a.hold!.state})</Link>
          </Fragment>
        ))}
        {gone.map(([agentId, hold], i) => (
          <Fragment key={`gone-${agentId}`}>
            {held.length + i > 0 && ', '}
            <span title={`Removed while ${hold.state}. If it registers again, its calls are refused until someone resumes it.`}>
              <span style={{ fontFamily: FONT_MONO, fontSize: '.92em' }}>{agentId}</span> (removed, {hold.state})
            </span>
            {fleet && <> <button type="button" className="wr-facts__btn" disabled={resuming !== null} onClick={() => void resume(agentId)}>{resuming === agentId ? 'Resuming…' : 'Resume'}</button></>}
          </Fragment>
        ))}
      </span>,
    );
  } else if (holdsKnown) {
    parts.push(<span key="holds">No agents on hold</span>);
  }
  if (flaggedToday !== null) {
    const text = `${fmtCount(flaggedToday)} flagged ${plural(flaggedToday, 'run')} today`;
    parts.push(flaggedToday > 0
      ? <Link key="flagged" href={`${ROUTES.runs}?show=flagged&range=today`} className="wr-link">{text}</Link>
      : <span key="flagged">{text}</span>);
  }
  if (todayRules) {
    const n = tallyTotal(todayRules);
    parts.push(<span key="rules">rules caught {fmtCount(n)} {plural(n, 'call')} today</span>);
  }
  parts.push(<Link key="week" href={ROUTES.performance} className="wr-link">Last 7 days &rarr;</Link>);

  return (
    <>
      <p className="wr-home-facts">
        {parts.map((p, i) => <Fragment key={i}>{i > 0 && ' · '}{p}</Fragment>)}
      </p>
      {error && <p role="alert" style={{ margin: '-20px 0 24px', color: 'var(--bad)', fontSize: 'var(--fs-sm)' }}>{error}</p>}
    </>
  );
}
