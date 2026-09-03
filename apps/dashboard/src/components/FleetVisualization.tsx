'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Beacon } from './AgentGauge';
import { eventModel, eventKey, sortNewestFirst, relTime, type AuditEntry } from '@/lib/activity';
import { FONT_MONO } from '@whiteroom/ui';

// Real-time "how is the fleet performing" board. Three layers, each earning
// its motion from real data rather than decoration:
//   1. A leaderboard — who's ahead right now, ranked by tasks finished this
//      watch. The bar is the metric; it grows because the number grew.
//   2. Per-agent nodes — the Beacon glyph (shared with the agent-view
//      toggle) plus a live throughput sparkline, so "performing" reads as a
//      trend, not just a snapshot.
//   3. A one-shot pop the instant a fresh audit entry lands — the token
//      count or event code riding the ping upward, so the burst carries the
//      number that just changed instead of being pure ornament.
//
// No cross-node geometry anywhere: every animation is self-contained state,
// never a measured position or a drawn connector.

export interface VizAgent {
  agentId: string;
  status: string;
  color: string;
  tokensUsed: number;
  tasksCompleted: number;
}

interface Sample {
  t: number;
  tokens: number;
}

const FRESH_MS = 20_000; // only entries this recent trigger the pop — opening the tab shouldn't replay history as if it just happened.
const SEEN_CAP = 500;
const HISTORY_CAP = 16; // sparkline points per agent

const fmtK = (n: number) => (n / 1000).toFixed(1) + 'K';

function Sparkline({ points, color }: { points: number[]; color: string }) {
  const w = 92;
  const h = 24;
  if (points.length < 2) {
    return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}><line x1={0} y1={h - 2} x2={w} y2={h - 2} stroke={color} strokeOpacity={0.15} strokeWidth={2} /></svg>;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const coords = points.map((p, i) => [
    (i / (points.length - 1)) * w,
    h - 2 - ((p - min) / span) * (h - 4),
  ]);
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const [ex, ey] = coords[coords.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={area} fill={color} fillOpacity={0.1} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ transition: 'd .5s ease' }} />
      <circle cx={ex} cy={ey} r={2.6} fill={color} stroke="var(--card)" strokeWidth={1.5} />
    </svg>
  );
}

export function FleetVisualization({ agents, entries }: { agents: VizAgent[]; entries: AuditEntry[] }) {
  const [lastByAgent, setLastByAgent] = useState<Record<string, AuditEntry>>({});
  const [burstKeys, setBurstKeys] = useState<Record<string, number>>({});
  const [, forceTick] = useState(0); // re-render periodically so sparkline history (a ref) and relative times stay current
  const seenRef = useRef<Set<string>>(new Set());
  const historyRef = useRef<Record<string, Sample[]>>({});

  // Signature that only changes when the numbers agents actually report
  // change — not on every unrelated re-render (a caption ticking, a toast
  // expiring elsewhere in the parent).
  const tokenSignature = agents.map((a) => `${a.agentId}:${a.tokensUsed}`).join('|');

  useEffect(() => {
    const now = Date.now();
    agents.forEach((a) => {
      const h = historyRef.current[a.agentId] || [];
      h.push({ t: now, tokens: a.tokensUsed });
      historyRef.current[a.agentId] = h.slice(-HISTORY_CAP);
    });
    forceTick((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenSignature]);

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

  // Refresh relative-time labels every few seconds even between polls.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const leaderboard = useMemo(
    () => [...agents].sort((a, b) => b.tasksCompleted - a.tasksCompleted || b.tokensUsed - a.tokensUsed),
    [agents],
  );
  const maxTasks = Math.max(1, ...leaderboard.map((a) => a.tasksCompleted));

  if (agents.length === 0) {
    return (
      <div className="flex-1 min-h-0" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tx3)', fontSize: 12 }}>
        No agents connected yet
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0" style={{ overflowY: 'auto', padding: '20px 24px 28px' }}>
      {/* ── Leaderboard: who's ahead right now ── */}
      <div style={{ marginBottom: 26 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.2, color: 'var(--tx2)', textTransform: 'uppercase' as const, marginBottom: 8 }}>
          Leaderboard — tasks this watch
        </div>
        <div className="flex flex-col" style={{ gap: 5 }}>
          {leaderboard.map((a, i) => (
            <div key={a.agentId} className="flex items-center gap-3">
              <span style={{ width: 14, textAlign: 'right' as const, fontFamily: FONT_MONO, fontSize: 10, color: i === 0 ? a.color : 'var(--tx3)', fontWeight: 700 }}>{i + 1}</span>
              <span style={{ width: 78, fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600, color: 'var(--tx)' }}>{a.agentId.toUpperCase()}</span>
              <div style={{ position: 'relative', flex: 1, height: 8, borderRadius: 99, background: 'var(--line)', overflow: 'hidden' }}>
                <div
                  style={{
                    position: 'relative', height: '100%', borderRadius: 99, overflow: 'hidden',
                    width: `${Math.max(3, (a.tasksCompleted / maxTasks) * 100)}%`,
                    background: a.color, transition: 'width .6s ease',
                  }}
                >
                  {i === 0 && a.tasksCompleted > 0 && (
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute', inset: 0, width: '40%',
                        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)',
                        animation: 'bar-sheen 2.6s ease-in-out infinite',
                      }}
                    />
                  )}
                </div>
              </div>
              <span style={{ width: 118, textAlign: 'right' as const, fontSize: 10, color: 'var(--tx2)' }}>{a.tasksCompleted} tasks · {fmtK(a.tokensUsed)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Live nodes: what each agent is doing, and its recent trend ── */}
      <div className="flex flex-wrap" style={{ gap: 30 }}>
        {agents.map((a) => {
          const last = lastByAgent[a.agentId];
          const model = last ? eventModel(last) : null;
          const burst = burstKeys[a.agentId];
          const history = historyRef.current[a.agentId] || [];
          const popLabel = model
            ? model.type === 'task_complete'
              ? `+${fmtK(last?.tokensUsed || 0)}`
              : model.code
            : null;

          return (
            <div key={a.agentId} className="flex flex-col items-center" style={{ width: 136, gap: 8 }}>
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
                {!!burst && popLabel && (
                  <span
                    key={`pop-${burst}`}
                    aria-hidden
                    style={{
                      position: 'absolute', top: -6, fontFamily: FONT_MONO, fontSize: 10.5, fontWeight: 700,
                      color: a.color, whiteSpace: 'nowrap' as const, animation: 'float-up 1.2s ease-out',
                    }}
                  >
                    {popLabel}
                  </span>
                )}
              </div>
              <div style={{ textAlign: 'center' as const }}>
                <div style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700, color: 'var(--tx)' }}>{a.agentId.toUpperCase()}</div>
                <div style={{ fontSize: 10.5, color: 'var(--tx2)', marginTop: 4, minHeight: 28, lineHeight: 1.4 }}>
                  {model ? <>{model.icon} {model.who} {model.said}</> : <span style={{ color: 'var(--tx3)' }}>No activity yet</span>}
                </div>
                {last && <div style={{ fontSize: 9, color: 'var(--tx3)', marginTop: 1 }}>{relTime(last.timestamp)}</div>}
              </div>
              <Sparkline points={history.map((s) => s.tokens)} color={a.color} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
