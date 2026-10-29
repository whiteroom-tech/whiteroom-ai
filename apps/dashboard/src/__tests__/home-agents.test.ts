import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';

const textOf = (html: string) => { const el = new Window().document.createElement('div'); el.innerHTML = html; return el.textContent ?? ''; };

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { HomeView } from '@/components/home/HomeContent';
import { homeWeek, keepLastGood, shownAgents, TABLE_FROM } from '@/lib/home-agents';
import type { AgentInfo, FleetReport } from '@/lib/whiteroom/types';

const agent = (agentId: string, status: string, x: Partial<AgentInfo> = {}): AgentInfo =>
  ({ agentId, status, watchNumber: 1, tasksCompleted: 0, minutesWorked: 0, ...x } as AgentInfo);
const REPORT = (n: number): FleetReport => ({
  fleetId: 'acme', agentCount: n,
  status: { working: [], resting: [], idle: [], handover_out: [] },
  totals: { workMinutes: 0, tokens: 0, tasks: 0, handovers: 0 },
  energySavings: { compressionRatio: 0, estimatedTokensSaved: 0, estimatedCostSaved: '$0', estimatedEnergySaved: '0 kWh', formula: '' },
  compliance: { allAgentsWithinLimits: true, restingAgentsCount: 0, laborScore: '100%' },
});
const tally = (x: Partial<{ blocks: number; wouldBlocks: number }>) => ({ blocks: 0, wouldBlocks: 0, paused: 0, stopped: 0, toldYou: 0, ...x });

describe('Home agents: one list', () => {
  it('finds by name, and sorts by input or savings from the last 7 days', () => {
    const agents = [agent('lead-agent', 'working'), agent('writer', 'idle'), agent('code-reviewer', 'idle')];
    const weeks = { 'lead-agent': { used: 900, input: 100, saved: 5 }, writer: { used: 100, input: 900, saved: 1 }, 'code-reviewer': { used: 500, input: 500, saved: 50 } };
    expect(shownAgents(agents, weeks, 'WRI', 'attention').map((a) => a.agentId)).toEqual(['writer']);
    expect(shownAgents(agents, weeks, '', 'input').map((a) => a.agentId)).toEqual(['writer', 'code-reviewer', 'lead-agent']);
    expect(shownAgents(agents, weeks, '', 'saved').map((a) => a.agentId)).toEqual(['code-reviewer', 'lead-agent', 'writer']);
    expect(shownAgents(agents, weeks, '', 'name').map((a) => a.agentId)).toEqual(['code-reviewer', 'lead-agent', 'writer']);
  });

  it('builds each agent’s week from what came back, and leaves out what failed', () => {
    const w = homeWeek(
      { fleetId: 'f', savingsBuckets: [{ day: '2026-10-26', agent: 'Lead-Agent', used: 1000, tasks: 1, handovers: 0, handoverSaved: 0, offloadSaved: 400 }], savingsByAgent: { 'lead-agent': { tokens: 400, usdMicros: 1_200_000 } }, governance: { blocks: 0, wouldBlocks: 0, byAgent: {}, byRule: {} } },
      { agents: [{ agentId: 'lead-agent', calls: 3, completeRate: 100, costDiligence: null, speedScore: 90, score: 10 }] } as never,
      { fleetId: 'f', totals: { blocked: 1, paused: 0, stopped: 0, toldYou: 0, wouldAct: 2 }, byAgent: { 'lead-agent': { blocked: 1, paused: 0, stopped: 0, toldYou: 0, wouldAct: 2 } } } as never,
      null,
    );
    expect(w.agents['lead-agent']).toMatchObject({ used: 1000, saved: 400, savedUsd: 1.2, rules: { blocks: 1, wouldBlocks: 2 }, score: { score: 10 } });
    // The hourly read failed: no week totals, never zeros.
    expect(w.calls).toBeNull();
    expect(w.costUsd).toBeNull();
    expect(homeWeek(null, null, { unsupported: true }, null)).toEqual({ agents: {}, calls: null, costUsd: null, partial: false, rules: null });
    // Week totals count only hours from the week's start, the same 7 days as the rest.
    const h = (hour: string, calls: number) => ({ hour, calls, costMicros: calls * 10_000 });
    const since = Date.parse('2026-10-20T04:00:00Z');
    expect(homeWeek(null, null, null, { hourly: [h('2026-10-20T03:00:00Z', 9), h('2026-10-20T04:00:00Z', 2), h('2026-10-26T12:00:00Z', 3)] } as never, since)).toMatchObject({ calls: 5, costUsd: 0.05 });
    // The audit read failed but rules came back: tokens are unknown (–), never 0.
    const noAudit = homeWeek(null, null, { fleetId: 'f', totals: { blocked: 1, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 }, byAgent: { writer: { blocked: 1, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 } } } as never, null);
    expect(noAudit.agents.writer.used).toBeUndefined();
    // Ids that differ only in case are one agent: counts add up.
    const mixed = homeWeek(null, null, { fleetId: 'f', totals: { blocked: 3, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 }, byAgent: { 'Lead-Agent': { blocked: 1, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 }, 'lead-agent': { blocked: 2, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 } } } as never, null);
    expect(mixed.agents['lead-agent'].rules?.blocks).toBe(3);
  });
});

describe('Home agents: input', () => {
  const week = (agents: Record<string, object>) => ({ agents, calls: null, costUsd: null, partial: false, rules: null });
  const ok = { audit: false, scores: false, rules: false, hourly: false, inputs: [] as string[] };

  it('puts each agent’s input beside its week, by lower-case id', () => {
    const w = homeWeek(null, null, null, null, 0, { byAgent: { 'lead-agent': 1_364_000 } });
    expect(w.agents['lead-agent']).toEqual({ input: 1_364_000 });
  });

  it('keeps saved and input from the same refresh when either read fails, agent by agent', () => {
    const prev = week({ a: { used: 1, saved: 10, input: 100 }, b: { used: 1, saved: 1, input: 1 } });
    const next = week({ a: { used: 2, saved: 20, input: 200 }, b: { used: 2, saved: 2, input: 2 } });
    const noInput = week({ a: { used: 2, saved: 20 }, b: { used: 2, saved: 2, input: 2 } });
    expect(keepLastGood(prev, next, ok).agents.a).toMatchObject({ saved: 20, input: 200 });
    // a's input read failed: its last pair stays; b's worked, so b moves on.
    const one = keepLastGood(prev, noInput, { ...ok, inputs: ['a'] }).agents;
    expect(one.a).toEqual({ used: 2, saved: 10, input: 100 });
    expect(one.b).toEqual({ used: 2, saved: 2, input: 2 });
    expect(keepLastGood(prev, next, { ...ok, audit: true }).agents.a).toEqual({ used: 1, saved: 10, input: 100 });
    // No pair yet: each moves on alone, so a failed audit read doesn't hide fresh input.
    expect(keepLastGood(week({ a: { saved: 10 } }), noInput, { ...ok, inputs: ['a'] }).agents.a).toMatchObject({ saved: 20 });
    expect(keepLastGood(week({ a: { saved: 10 } }), week({ a: { input: 200 } }), { ...ok, audit: true }).agents.a).toEqual({ saved: 10, input: 200 });
    expect(keepLastGood(week({}), week({ b: { input: 50 } }), { ...ok, audit: true }).agents.b).toEqual({ input: 50 });
  });
});

describe('rule activity, short', () => {
  it('fits a card line, whatever the tally holds', async () => {
    const { tallyShort } = await import('@/lib/governance');
    expect(tallyShort(tally({ blocks: 2, wouldBlocks: 47 }))).toBe('2 blocked · 47 would have acted');
    expect(tallyShort(tally({ wouldBlocks: 3 }))).toBe('3 would have acted');
    expect(tallyShort({ blocks: 1, wouldBlocks: 0, paused: 2, stopped: 1, toldYou: 4 })).toBe('1 stopped · 2 paused · 1 blocked · 4 alerted you');
    expect(tallyShort(tally({}))).toBe('');
  });
});

describe('Home view', () => {
  const view = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(HomeView, {
    report: REPORT(2), agents: [agent('lead-agent', 'idle'), agent('a-very-long-agent-name-that-must-not-be-cut-off', 'idle')], changes: [], today: { calls: 0, costUsd: 0 }, failing: false, view: null, onViewChange: () => {}, liveFeed: null, ...props,
  } as never));

  it('says the day starts at the viewer’s midnight, and leads a quiet day with the week', () => {
    const html = view({ week: { agents: {}, calls: 1234, costUsd: 3.17, partial: false, rules: tally({ wouldBlocks: 120 }) } });
    expect(html).toMatch(/Today.*since 12:00 am/);
    expect(textOf(html)).toContain('Quiet so far today. This week: $3.17 spent, rules would have acted 120 times. View runs');
    // A lower bound says so.
    expect(view({ week: { agents: {}, calls: 3, costUsd: 1, partial: true, rules: null } })).toContain('$1.00+ spent');
  });

  it('shows today’s rule activity, linking to those runs', () => {
    const html = view({ today: { calls: 5, costUsd: 0.1 }, todayRules: tally({ blocks: 2, wouldBlocks: 3 }) });
    expect(html).toContain('Rule activity');
    expect(html).toContain('2 blocked · 3 would have acted');
    expect(html).toContain('/runs?show=rules&amp;day=');
    expect(html).not.toContain('Quiet so far today');
    expect(html).not.toContain('Smaller context');
  });

  it('says when today’s rule activity is unknown or nothing, never a made-up 0', () => {
    const unknown = view({ today: { calls: 5, costUsd: 0.1 }, todayRules: null });
    expect(unknown).toContain('not available yet');
    const none = view({ today: { calls: 5, costUsd: 0.1 }, todayRules: tally({}) });
    expect(none).toContain('0 blocked · 0 would have acted');
    expect(none).not.toContain('/runs?show=rules');
  });

  it('never cuts a name off, and shows each agent’s last 7 days', () => {
    const html = view({ week: { agents: { 'lead-agent': { used: 120_000, input: 120_000, saved: 40_000, savedUsd: 1.2, rules: tally({ blocks: 2 }) } }, calls: null, costUsd: null, partial: false, rules: null } });
    expect(html).toContain('a-very-long-agent-name-that-must-not-be-cut-off');
    expect(html).toContain('class="wr-agent-card__name"');
    expect(textOf(html)).toContain('120K input sent · 40K input saved · 2 blocked');
    // The dollar estimate is kept as the saved figure's tooltip.
    expect(html).toContain('title="40K input tokens saved, about $1.20 at this agent&#x27;s prices (est.)"');
  });

  it('opens on the table for a big fleet unless the viewer picked cards, with search and sort', () => {
    const many = Array.from({ length: TABLE_FROM + 1 }, (_, i) => agent(`agent-${i}`, 'idle'));
    const big = view({ report: REPORT(many.length), agents: many });
    expect(big).toContain('class="wr-home-table"');
    expect(big).toContain('aria-label="Find an agent"');
    expect(big).toContain('Agents needing attention first.');
    expect(view({ report: REPORT(many.length), agents: many, view: 'cards' })).not.toContain('class="wr-home-table"');
    expect(view({})).not.toContain('aria-label="Find an agent"');
  });

  it('shows – for tokens it couldn’t read, never 0', () => {
    const html = view({ view: 'table', week: { agents: { 'lead-agent': { rules: tally({ blocks: 1 }) } }, calls: null, costUsd: null, partial: false, rules: null } });
    expect(html).not.toMatch(/>0 tokens/);
    expect(html).toContain('1 blocked');
  });

  it('names both table columns as input: what was sent, and what was saved', () => {
    const html = view({ view: 'table', week: { agents: { 'lead-agent': { used: 81_800, input: 1_364_000, saved: 1_876_000 } }, calls: null, costUsd: null, partial: false, rules: null } });
    expect(textOf(html)).toContain('Input sent');
    expect(textOf(html)).toContain('Input saved, est.');
    expect(textOf(html)).toContain('1.36M');
    // Not the 81.8K its tasks reported: that mixes in output.
    expect(textOf(html)).not.toContain('81.8K');
  });
});
