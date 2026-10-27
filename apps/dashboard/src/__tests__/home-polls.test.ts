// @vitest-environment happy-dom
// Home's two extra polls, with the engine mocked: today's rule activity every
// minute, the 7-day reads only every 5 minutes, both on the header's Refresh,
// and a failed today read that leaves the week's figures alone.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/components/home/LiveFeedPanel', () => ({ LiveFeedPanel: () => null }));
vi.mock('@/components/home/NeedsYou', () => ({ NeedsYou: () => null }));

const counts = (blocked: number) => ({ blocked, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 });
const api = vi.hoisted(() => ({ audit: vi.fn(), scores: vi.fn(), rules: vi.fn(), hourly: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  fleetReport: async () => ({
    fleetId: 'f1', agentCount: 1, agentDetails: [{ agentId: 'lead-agent', status: 'idle', watchNumber: 1, tasksCompleted: 0, minutesWorked: 0 }],
    status: { working: [], resting: [], idle: ['lead-agent'], handover_out: [] },
    totals: { workMinutes: 0, tokens: 0, tasks: 0, handovers: 0 },
    energySavings: { compressionRatio: 0, estimatedTokensSaved: 0, estimatedCostSaved: '$0', estimatedEnergySaved: '0 kWh', formula: '' },
    compliance: { allAgentsWithinLimits: true, restingAgentsCount: 0, laborScore: '100%' },
  }),
  auditLog: async () => ({ entries: [] }),
  auditSummary: api.audit,
  performanceAgentScores: api.scores,
  performanceFleetHourly: api.hourly,
  ruleActions: api.rules,
}));
const { HomeContent } = await import('@/components/home/HomeContent');

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const isToday = (q: { fromDay: string; toDay: string }) => q.fromDay === q.toDay;
const dayReads = () => api.rules.mock.calls.filter(([, q]) => isToday(q)).length;
const weekRuleReads = () => api.rules.mock.calls.filter(([, q]) => !isToday(q)).length;

afterEach(() => { vi.useRealTimers(); for (const f of Object.values(api)) f.mockReset(); });

async function mount() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  api.audit.mockResolvedValue({ fleetId: 'f1', savingsBuckets: [{ day: '2026-10-26', agent: 'lead-agent', used: 1000, tasks: 1, handovers: 0, handoverSaved: 0, offloadSaved: 0 }], governance: { blocks: 0, wouldBlocks: 0, byAgent: {}, byRule: {} } });
  api.scores.mockResolvedValue({ fleetId: 'f1', agents: [] });
  api.hourly.mockResolvedValue({ hourly: [] });
  // The week has 5 blocks for lead-agent; today has 2.
  api.rules.mockImplementation(async (_f: string, q: { fromDay: string; toDay: string }) => (isToday(q)
    ? { fleetId: 'f1', totals: counts(2), byAgent: { 'lead-agent': counts(2) } }
    : { fleetId: 'f1', totals: counts(5), byAgent: { 'lead-agent': counts(5) } }));
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = (refreshSignal: number) => act(async () => { root.render(h(HomeContent, { fleetId: 'f1', authKey: 'k', refreshSignal })); });
  await render(0);
  await flush();
  const text = () => (el.textContent ?? '').replace(/\s+/g, ' ');
  const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await flush(); };
  return { root, render, text, advance };
}

describe('Home polls', () => {
  it('rereads today’s rule activity every minute, and the week only every 5 minutes', async () => {
    const m = await mount();
    expect([dayReads(), weekRuleReads(), api.audit.mock.calls.length]).toEqual([1, 1, 1]);
    await m.advance(60_000);
    expect([dayReads(), weekRuleReads(), api.audit.mock.calls.length]).toEqual([2, 1, 1]);
    await m.advance(4 * 60_000);
    expect(weekRuleReads()).toBe(2);
    expect(api.audit).toHaveBeenCalledTimes(2);
    expect(api.hourly.mock.calls.length).toBeGreaterThanOrEqual(2);
    m.root.unmount();
  });

  it('rereads both on the header’s Refresh', async () => {
    const m = await mount();
    const before = [dayReads(), weekRuleReads(), api.audit.mock.calls.length];
    await m.render(1);
    await flush();
    expect([dayReads(), weekRuleReads(), api.audit.mock.calls.length]).toEqual(before.map((n) => n + 1));
    m.root.unmount();
  });

  it('a failed today read clears today’s rule activity and keeps the week', async () => {
    const m = await mount();
    expect(m.text()).toContain('Rule activity2');
    expect(m.text()).toContain('Last 7 days: 1K tokens · 5 blocked');
    api.rules.mockImplementation(async (_f: string, q: { fromDay: string; toDay: string }) => {
      if (isToday(q)) throw new Error('down');
      return { fleetId: 'f1', totals: counts(5), byAgent: { 'lead-agent': counts(5) } };
    });
    await m.advance(60_000);
    expect(m.text()).toContain('Rule activity—not available yet');
    expect(m.text()).toContain('Last 7 days: 1K tokens · 5 blocked');
    m.root.unmount();
  });
});
