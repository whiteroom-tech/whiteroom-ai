import { describe, expect, it } from 'vitest';
import {
  agentDaySavings, agentTotals, agentTotalsFromBuckets, auditSavingsEvent, dailySavings, dailySavingsFromBuckets,
  handoverSaved, isHandoverEntry, localDayFromTs, savedFromBuckets, type SavingsBucket,
} from '@/lib/analytics-metrics';
import { governanceFromSummary } from '@/lib/governance';

// The same events, totalled the old way (raw events in the browser) and the
// new way (the engine's per-agent-day buckets), must give identical numbers.
const now = Date.now();
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const events = [
  { type: 'task_complete', timestamp: at(1), agentId: 'Lead-Agent', tokensUsed: 1200 },
  { type: 'task_complete', timestamp: at(2), agentId: 'lead-agent', tokensUsed: 800 },
  { type: 'task_complete', timestamp: at(3), agentId: 'lead-agent' },
  { type: 'self_handover', timestamp: at(2), agentId: 'lead-agent', contextTokens: 10000, handoverDocTokens: 500 },
  { type: 'paired_handover', timestamp: at(30), agentId: 'x', from: 'writer', contextTokens: 1000, tokensUsed: 50 },
  { type: 'context_offload', timestamp: at(30), agentId: 'writer', contextTokens: 900, returnedTokens: 100 },
  { type: 'watch_start', timestamp: at(50), tokensUsed: 70 },
];

/** What the engine's audit_summary returns for these events (its SQL, restated). */
function engineBuckets(es: typeof events): SavingsBucket[] {
  const m = new Map<string, SavingsBucket>();
  for (const e of es as Array<Record<string, unknown> & { type: string; timestamp: string }>) {
    const day = localDayFromTs(e.timestamp);
    const agent = String((isHandoverEntry(e) ? (e.from || e.agentId) : e.agentId) ?? '').toLowerCase();
    const b = m.get(`${agent}|${day}`) ?? { day, agent, used: 0, tasks: 0, handovers: 0, handoverSaved: 0, offloadSaved: 0 };
    b.used += Number(e.tokensUsed ?? 0);
    if (e.type === 'task_complete') b.tasks++;
    if (isHandoverEntry(e)) { b.handovers++; b.handoverSaved += handoverSaved(e as { contextTokens?: number; handoverDocTokens?: number }); }
    if (e.type === 'context_offload') b.offloadSaved += Math.max(0, Number(e.contextTokens) - Number(e.returnedTokens));
    m.set(`${agent}|${day}`, b);
  }
  return [...m.values()];
}

describe('savings from engine buckets', () => {
  const buckets = engineBuckets(events);

  it('totals the same as the per-event math', () => {
    let fromEvents = 0;
    for (const v of agentDaySavings(events.map((e) => auditSavingsEvent(e, localDayFromTs(e.timestamp)))).byDay.values()) fromEvents += v;
    expect(savedFromBuckets(buckets)).toBe(fromEvents);
    expect(fromEvents).toBeGreaterThan(0);
  });

  it('draws the same 7-day chart', () => {
    expect(dailySavingsFromBuckets(buckets, 7, now)).toEqual(dailySavings(events, 7, now));
  });

  it('builds the same By agent rows', () => {
    expect(agentTotalsFromBuckets(buckets)).toEqual(agentTotals(events, 0));
  });
});

describe('governance totals from the engine', () => {
  it('fills every rule type', () => {
    const g = governanceFromSummary({ blocks: 3, wouldBlocks: 7, byAgent: { a: { blocks: 3, wouldBlocks: 7 } }, byRule: { loop_breaker: { blocks: 0, wouldBlocks: 7 } } });
    expect(g.byRule).toEqual({ spend_cap: { blocks: 0, wouldBlocks: 0 }, loop_breaker: { blocks: 0, wouldBlocks: 7 }, model_allowlist: { blocks: 0, wouldBlocks: 0 }, tool_list: { blocks: 0, wouldBlocks: 0 }, call_rate: { blocks: 0, wouldBlocks: 0 } });
    expect(g).toMatchObject({ blocks: 3, wouldBlocks: 7 });
  });
});
