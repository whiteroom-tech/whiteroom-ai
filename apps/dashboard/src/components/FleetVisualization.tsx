'use client';

import { useEffect, useRef, useState } from 'react';
import { Beacon } from './AgentGauge';
import { eventModel, eventKey, sortNewestFirst, relTime, type AuditEntry } from '@/lib/activity';
import { FONT_MONO } from '@whiteroom/ui';

// Real-time "what is each agent doing" board. Reuses the Beacon glyph from
// the agent-view toggle (same status colors, same continuous working/resting
// animation) and adds one thing on top: a one-shot ping the instant a fresh
// audit entry lands for that agent, plus a persistent plain-English caption
// of its last action — so there's always something true to read, and a
// visible "pop" for the moment something actually happens.
//
// No cross-node geometry (no measured positions, no drawn connectors): every
// animation is self-contained per node, driven by state, not layout math.

export interface VizAgent {
  agentId: string;
  status: string;
  color: string;
}

const FRESH_MS = 20_000; // only entries this recent trigger the burst — older ones just update the caption, so opening the tab doesn't replay history as if it just happened.
const SEEN_CAP = 500;

export function FleetVisualization({ agents, entries }: { agents: VizAgent[]; entries: AuditEntry[] }) {
  const [lastByAgent, setLastByAgent] = useState<Record<string, AuditEntry>>({});
  const [burstKeys, setBurstKeys] = useState<Record<string, number>>({});
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const recent = sortNewestFirst(entries).slice(0, 40);
    const now = Date.now();
    let updates: Record<string, AuditEntry> | null = null;
    let bursts: Record<string, number> | null = null;

    for (const e of recent) {
      const k = eventKey(e);
      if (seenRef.current.has(k)) continue;
      seenRef.current.add(k);
      const aid = e.agentId || e.toAgent || e.fromAgent;
      if (!aid) continue;
      updates = updates || {};
      updates[aid] = e;
      if (now - new Date(e.timestamp).getTime() < FRESH_MS) {
        bursts = bursts || {};
        bursts[aid] = (bursts[aid] ?? 0) + 1;
      }
    }

    if (updates) setLastByAgent((prev) => ({ ...prev, ...updates }));
    if (bursts) setBurstKeys((prev) => ({ ...prev, ...Object.fromEntries(Object.entries(bursts!).map(([id, n]) => [id, (prev[id] || 0) + n])) }));
    if (seenRef.current.size > SEEN_CAP) seenRef.current = new Set(recent.map(eventKey));
  }, [entries]);

  if (agents.length === 0) {
    return (
      <div className="flex-1 min-h-0" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 12 }}>
        No agents connected yet
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0" style={{ overflowY: 'auto', padding: '28px 24px' }}>
      <div className="flex flex-wrap" style={{ gap: 32 }}>
        {agents.map((a) => {
          const last = lastByAgent[a.agentId];
          const model = last ? eventModel(last) : null;
          const burst = burstKeys[a.agentId];
          return (
            <div key={a.agentId} className="flex flex-col items-center" style={{ width: 136, gap: 10 }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 62, height: 62 }}>
                <Beacon color={a.color} animate={a.status === 'working'} breathe={a.status === 'resting'} size={30} />
                {!!burst && (
                  <span
                    key={burst}
                    aria-hidden
                    style={{
                      position: 'absolute', width: 30, height: 30, borderRadius: '50%',
                      border: `1.5px solid ${a.color}`, animation: 'beacon-ping 1s ease-out',
                    }}
                  />
                )}
              </div>
              <div style={{ textAlign: 'center' as const }}>
                <div style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>{a.agentId.toUpperCase()}</div>
                <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 4, minHeight: 28, lineHeight: 1.4 }}>
                  {model ? <>{model.icon} {model.who} {model.said}</> : <span style={{ color: '#475569' }}>No activity yet</span>}
                </div>
                {last && <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>{relTime(last.timestamp)}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
