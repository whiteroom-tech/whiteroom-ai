'use client';

import { useEffect, useState } from 'react';
import { Panel } from '@whiteroom/ui';
import { healthHistory, type HealthHistoryEvent } from '@/lib/whiteroom/client';
import { fetchControlActors, type ControlActor } from '@/lib/control-actors';
import { formatInZone } from '@/lib/zone-time';
import { checkName, EVENT_LABEL, historyDays, whoActed } from '@/lib/health-history';

/** Days the Agent detail list covers, and the entries it shows. */
const DAYS = 30;
const SHOWN = 10;

/**
 * Agent detail › Health history (Agent Health item 9): what the health checks
 * found for this agent in the last 30 days and what was done about it,
 * newest first. Hidden while loading, when there's nothing, and on engines
 * without it; a failed read hides it too (it's extra, not the page).
 */
export function HealthHistory({ fleetId, agentId, authKey, preview }: { fleetId: string; agentId: string; authKey?: string; preview?: HealthHistoryEvent[] }) {
  const [events, setEvents] = useState<HealthHistoryEvent[] | null>(preview ?? null);
  // More than one page in the window: the list says there's more without a count.
  const [more, setMore] = useState(false);
  const [actions, setActions] = useState<ControlActor[]>([]);

  useEffect(() => {
    if (preview) return;
    let live = true;
    setEvents(null);
    healthHistory(fleetId, { ...historyDays(DAYS), agentId }, authKey).then(
      (page) => { if (live) { setEvents(page?.events ?? []); setMore(!!page?.cursor); } },
      () => { if (live) setEvents([]); },
    );
    return () => { live = false; };
  }, [fleetId, agentId, authKey, preview]);

  useEffect(() => {
    if (preview || !events?.some((e) => e.actor)) return;
    let live = true;
    fetchControlActors(fleetId, [...events].reverse().find((e) => e.actor)!.at).then((a) => { if (live) setActions(a); }, () => {});
    return () => { live = false; };
  }, [fleetId, events, preview]);

  if (!events || events.length === 0) return null;
  const shown = events.slice(0, SHOWN);
  return (
    <Panel title="Health history" actions={<span className="wr-agent-cap">Last {DAYS} days</span>}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {shown.map((e, i) => (
          <li key={`${e.at}-${i}`} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 'var(--fs-sm)' }}>
            <span className="wr-agent-cap" style={{ minWidth: 104 }}>{formatInZone(new Date(e.at), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            <span><strong style={{ fontWeight: 600 }}>{checkName(e.detector)}</strong>: {EVENT_LABEL[e.event] ?? e.event}{e.actor ? ` by ${whoActed(e.actor, actions)}` : ''}</span>
          </li>
        ))}
      </ul>
      {(events.length > SHOWN || more) && (
        <p className="wr-agent-cap" style={{ margin: '8px 0 0' }}>
          {more ? 'More' : `${events.length - SHOWN} more`} in the health report: Download report on Performance.
        </p>
      )}
    </Panel>
  );
}
