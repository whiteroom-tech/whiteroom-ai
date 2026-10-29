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

const calls = (inputTokens: number) => ({ fleetId: 'f1', agentId: 'lead-agent', period: { start: '', end: '' }, hourly: [], totals: { calls: 1, costMicros: 0, inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const counts = (blocked: number) => ({ blocked, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 });
const api = vi.hoisted(() => ({ audit: vi.fn(), scores: vi.fn(), rules: vi.fn(), hourly: vi.fn(), log: vi.fn(), runs: vi.fn(), days: vi.fn(), agent: vi.fn(), ids: ['lead-agent'] as string[] }));
vi.mock('@/lib/control-actors', async (orig) => ({ ...(await orig<typeof import('@/lib/control-actors')>()), fetchControlActors: async () => [] }));
// The ⋯ stand-in reports an act straight away, as a successful Pause would.
vi.mock('@/components/home/AgentActions', () => ({ AgentActions: ({ onChanged }: { onChanged: () => void }) => h('button', { type: 'button', onClick: onChanged }, 'acted') }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  fleetReport: async () => ({
    fleetId: 'f1', agentCount: api.ids.length, agentDetails: api.ids.map((agentId) => ({ agentId, status: 'idle', watchNumber: 1, tasksCompleted: 0, minutesWorked: 0 })),
    status: { working: [], resting: [], idle: ['lead-agent'], handover_out: [] },
    totals: { workMinutes: 0, tokens: 0, tasks: 0, handovers: 0 },
    energySavings: { compressionRatio: 0, estimatedTokensSaved: 0, estimatedCostSaved: '$0', estimatedEnergySaved: '0 kWh', formula: '' },
    compliance: { allAgentsWithinLimits: true, restingAgentsCount: 0, laborScore: '100%' },
    holds: {}, govV1: true,
  }),
  auditLog: api.log,
  listRuns: api.runs,
  runDays: api.days,
  auditSummary: api.audit,
  performanceAgentScores: api.scores,
  performanceFleetHourly: api.hourly,
  ruleActions: api.rules,
  performanceAgent: api.agent,
}));
const { HomeContent } = await import('@/components/home/HomeContent');

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const isToday = (q: { fromDay: string; toDay: string }) => q.fromDay === q.toDay;
const dayReads = () => api.rules.mock.calls.filter(([, q]) => isToday(q)).length;
const weekRuleReads = () => api.rules.mock.calls.filter(([, q]) => !isToday(q)).length;

afterEach(() => { vi.useRealTimers(); for (const f of Object.values(api)) if (typeof f === 'function') f.mockReset(); api.ids = ['lead-agent']; });

async function mount() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  api.hourly.mockResolvedValue({ hourly: [] });
  return mountWith();
}

/** Mounts Home with the engine mocks in place; a test may set api.hourly first. */
async function mountWith() {
  api.audit.mockResolvedValue({ fleetId: 'f1', savingsBuckets: [{ day: '2026-10-26', agent: 'lead-agent', used: 1000, tasks: 1, handovers: 0, handoverSaved: 0, offloadSaved: 0 }], governance: { blocks: 0, wouldBlocks: 0, byAgent: {}, byRule: {} } });
  api.scores.mockResolvedValue({ fleetId: 'f1', agents: [] });
  api.agent.mockResolvedValue(calls(1000));
  if (!api.log.getMockImplementation()) api.log.mockImplementation(async ({ type }: { type?: string }) => ({ entries: type === 'governance_rule_changed' ? [{ id: 'g1', type, timestamp: new Date().toISOString(), ruleId: 'gr_1', ruleType: 'spend_cap', message: 'Spend cap: Added new Spend cap rule', by: 'api' }] : [] }));
  if (!api.runs.getMockImplementation()) api.runs.mockResolvedValue({ fleetId: 'f1', runs: [{ runId: 'lead-agent~1', flags: [] }], total: 3, cursor: null });
  if (!api.days.getMockImplementation()) api.days.mockResolvedValue({ fleetId: 'f1', days: [{ day: '2026-10-24', runs: 47 }] });
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
    // Each agent's input with the week, not on its own clock.
    expect(api.agent).toHaveBeenCalledTimes(2);
    expect(api.agent.mock.calls[0].slice(0, 2)).toEqual(['f1', 'lead-agent']);
    expect(api.hourly.mock.calls.length).toBeGreaterThanOrEqual(2);
    m.root.unmount();
  });

  it('reads the week once the agents are known, with their input, and again when an agent is added', async () => {
    const m = await mount();
    // One week read on load, asking about the agent the report listed.
    expect(api.audit).toHaveBeenCalledTimes(1);
    expect(api.agent.mock.calls.map((c) => c[1])).toEqual(['lead-agent']);
    api.ids = ['lead-agent', 'writer'];
    await m.render(1);
    await flush();
    // The new agent rereads the week (the Refresh rereads it too), asking about both.
    expect(api.agent.mock.calls.slice(-2).map((c) => c[1]).sort()).toEqual(['lead-agent', 'writer']);
    const reads = api.audit.mock.calls.length;
    // A report with the same agents doesn't.
    await m.advance(60_000);
    expect(api.audit.mock.calls.length).toBe(reads);
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

  it('a failed today read keeps today’s rule activity; an engine without rule actions clears it', async () => {
    const m = await mount();
    expect(m.text()).toContain('Rule activity2');
    expect(m.text()).toContain('1K input sent · 5 blocked');
    api.rules.mockImplementation(async (_f: string, q: { fromDay: string; toDay: string }) => {
      if (isToday(q)) throw new Error('down');
      return { fleetId: 'f1', totals: counts(5), byAgent: { 'lead-agent': counts(5) } };
    });
    await m.advance(60_000);
    expect(m.text()).toContain('Rule activity2');
    api.rules.mockImplementation(async (_f: string, q: { fromDay: string; toDay: string }) => (isToday(q)
      ? { unsupported: true }
      : { fleetId: 'f1', totals: counts(5), byAgent: { 'lead-agent': counts(5) } }));
    await m.advance(60_000);
    expect(m.text()).toContain('Rule activity—not available yet');
    expect(m.text()).toContain('1K input sent · 5 blocked');
    m.root.unmount();
  });

  it('a failed week read keeps its own figures and lets the others refresh', async () => {
    const m = await mount();
    expect(m.text()).toContain('1K input sent · 5 blocked');
    // Rules fail; input moves on.
    api.rules.mockImplementation(async (_f: string, q: { fromDay: string; toDay: string }) => {
      if (!isToday(q)) throw new Error('down');
      return { fleetId: 'f1', totals: counts(2), byAgent: { 'lead-agent': counts(2) } };
    });
    api.audit.mockResolvedValue({ fleetId: 'f1', savingsBuckets: [{ day: '2026-10-26', agent: 'lead-agent', used: 3000, tasks: 1, handovers: 0, handoverSaved: 0, offloadSaved: 0 }], governance: { blocks: 0, wouldBlocks: 0, byAgent: {}, byRule: {} } });
    api.agent.mockResolvedValue(calls(3000));
    await m.advance(5 * 60_000);
    expect(m.text()).toContain('3K input sent · 5 blocked');
    // The input read fails: the last input stays, beside the saved figure from the same read.
    api.agent.mockRejectedValue(new Error('down'));
    await m.advance(5 * 60_000);
    expect(m.text()).toContain('3K input sent · 5 blocked');
    m.root.unmount();
  });
});

describe('Home fact line, last active day and latest changes', () => {
  it('reads changes by type, the flagged count and the last active day', async () => {
    const m = await mount();
    const types = api.log.mock.calls.map(([q]) => q.type).sort();
    expect(types).toEqual(['agent_paused', 'agent_resumed', 'agent_stopped', 'deregister', 'governance_rule_changed', 'register']);
    expect(m.text()).toContain('Spend cap rule added through the API');
    expect(m.text()).toContain('3 flagged runs today');
    expect(m.text()).toContain('Last activity Sat, Oct 24: 47 runs.');
    m.root.unmount();
  });

  it('keeps the last list and says so when one type fails to read', async () => {
    const m = await mount();
    api.log.mockImplementation(async ({ type }: { type?: string }) => { if (type === 'register') throw new Error('down'); return { entries: [] }; });
    await m.advance(60_000);
    expect(m.text()).toContain('Spend cap rule added through the API');
    expect(m.text()).toContain('Couldn’t refresh changes.');
    api.log.mockReset();
    m.root.unmount();
  });

  it('hides the flagged count for engines that don’t flag runs', async () => {
    api.runs.mockResolvedValue({ fleetId: 'f1', runs: [{ runId: 'lead-agent~1' }], total: 1, cursor: null });
    const m = await mount();
    expect(m.text()).not.toContain('flagged');
    api.runs.mockReset();
    m.root.unmount();
  });

  it('rereads latest changes after a Pause, Stop or Resume', async () => {
    const m = await mount();
    const before = api.log.mock.calls.length;
    const acted = [...document.querySelectorAll('button')].find((b) => b.textContent === 'acted')!;
    await act(async () => { acted.click(); });
    await flush();
    expect(api.log.mock.calls.length).toBe(before + 6);
    m.root.unmount();
  });
});

describe('Home conditional polls', () => {
  it('reads the last active day only on a quiet day', async () => {
    api.hourly.mockResolvedValue({ hourly: [{ hour: new Date().toISOString().slice(0, 13) + ':00:00Z', calls: 7, costMicros: 0 }] });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const busy = await mountWith();
    expect(api.days).not.toHaveBeenCalled();
    // Not on the header's Refresh either.
    await busy.render(1);
    await flush();
    expect(api.days).not.toHaveBeenCalled();
    expect(busy.text()).not.toContain('Last activity');
    busy.root.unmount();
  });

  it('keeps the flagged count through a failed read, and drops it when the engine stops flagging runs', async () => {
    const m = await mount();
    expect(m.text()).toContain('3 flagged runs today');
    api.runs.mockRejectedValue(new Error('down'));
    await m.advance(60_000);
    expect(m.text()).toContain('3 flagged runs today');
    api.runs.mockResolvedValue({ fleetId: 'f1', runs: [{ runId: 'lead-agent~1' }], total: 1, cursor: null });
    await m.advance(60_000);
    expect(m.text()).not.toContain('flagged');
    m.root.unmount();
  });
});

describe('Home last active day', () => {
  it('keeps the last day through a failed read', async () => {
    const m = await mount();
    expect(m.text()).toContain('Last activity Sat, Oct 24: 47 runs.');
    api.days.mockRejectedValue(new Error('down'));
    await m.advance(5 * 60_000);
    expect(api.days.mock.calls.length).toBeGreaterThan(1);
    expect(m.text()).toContain('Last activity Sat, Oct 24: 47 runs.');
    m.root.unmount();
  });
});

describe('Home after midnight', () => {
  it('drops today’s figures read for yesterday until today’s arrive', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: new Date('2026-10-27T23:59:00') });
    api.hourly.mockResolvedValue({ hourly: [] });
    const m = await mountWith();
    expect(m.text()).toContain('Rule activity2');
    expect(m.text()).toContain('Model calls0');
    // Past midnight, before any poll: yesterday's figures aren't shown as today's.
    vi.setSystemTime(new Date('2026-10-28T00:00:30'));
    await m.render(0);
    expect(m.text()).toContain('Rule activity—');
    expect(m.text()).toContain('Model calls—');
    m.root.unmount();
  });
});
