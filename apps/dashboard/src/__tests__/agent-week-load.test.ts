// @vitest-environment happy-dom
// Agent page › Last 7 days, read from the engine: the same 7 days as Home,
// the agent found whatever its case, 0 for a quiet agent, and a failed
// refresh keeps the figures it had.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { agentWeekFrom } from '@/lib/home-agents';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ audit: vi.fn(), scores: vi.fn(), rules: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  auditSummary: api.audit, performanceAgentScores: api.scores, ruleActions: api.rules,
}));
const { AgentWeekCard } = await import('@/components/agent/AgentWeekCard');

const AUDIT = { fleetId: 'f', savingsBuckets: [{ day: '2026-10-26', agent: 'Lead-Agent', used: 1000, tasks: 1, handovers: 0, handoverSaved: 0, offloadSaved: 3000 }], governance: { blocks: 0, wouldBlocks: 0, byAgent: {}, byRule: {} } };
const SCORES = { fleetId: 'f', period: { start: '', end: '' }, agents: [{ agentId: 'lead-agent', calls: 3, completeRate: 100, costDiligence: null, speedScore: 90, score: 10 }] };
const RULES = { fleetId: 'f', totals: { blocked: 1, paused: 0, stopped: 0, toldYou: 0, wouldAct: 2 }, byAgent: { 'LEAD-agent': { blocked: 1, paused: 0, stopped: 0, toldYou: 0, wouldAct: 2 } } };
const QUIET_RULES = { fleetId: 'f', totals: { blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 }, byAgent: {} };
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

afterEach(() => { vi.useRealTimers(); for (const f of Object.values(api)) f.mockReset(); });

describe('agentWeekFrom', () => {
  it('reads the agent whatever its case, and a quiet agent as 0, not unknown', () => {
    expect(agentWeekFrom(undefined, 'lead-agent', AUDIT as never, SCORES as never, RULES as never)).toMatchObject({ used: 1000, saved: 3000, rules: { blocks: 1, wouldBlocks: 2 }, score: { score: 10 } });
    const quiet = agentWeekFrom(undefined, 'writer', AUDIT as never, SCORES as never, QUIET_RULES as never);
    expect(quiet).toEqual({ used: 0, saved: 0, rules: { blocks: 0, wouldBlocks: 0 } });
  });

  it('keeps what it had for a read that failed, and leaves unknown absent', () => {
    const prev = agentWeekFrom(undefined, 'lead-agent', AUDIT as never, SCORES as never, RULES as never);
    expect(agentWeekFrom(prev, 'lead-agent', null, null, null)).toEqual(prev);
    expect(agentWeekFrom(prev, 'lead-agent', null, { error: 'x' } as never, { unsupported: true })).toEqual(prev);
    expect(agentWeekFrom(undefined, 'lead-agent', null, null, null)).toEqual({});
  });
});

describe('Last 7 days card, loading', () => {
  it('asks for the same 7 days as Home, shows 0 for a quiet agent, and keeps figures through a failed refresh', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    api.audit.mockResolvedValue(AUDIT);
    api.scores.mockResolvedValue(SCORES);
    api.rules.mockResolvedValue(QUIET_RULES);
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(AgentWeekCard, { fleetId: 'f', authKey: 'k', agentId: 'Lead-Agent' })); });
    await flush();
    // From local midnight six days ago; scores over whole hours back to it.
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 6);
    expect(api.audit.mock.calls[0][1].getTime()).toBe(start.getTime());
    const hours = api.scores.mock.calls[0][1];
    expect(hours).toBeGreaterThanOrEqual(6 * 24);
    expect(hours).toBeLessThanOrEqual(7 * 24 + 2);
    // Rule activity for this agent only, not the whole fleet.
    expect(api.rules.mock.calls[0][1]).toMatchObject({ agentId: 'Lead-Agent' });
    const text = () => (el.textContent ?? '').replace(/\s+/g, ' ');
    expect(text()).toContain('Tokens without WhiteRoom, est.4K');
    expect(text()).toContain('Rule activity0');
    // Every read fails on the next refresh: the figures stay.
    api.audit.mockRejectedValue(new Error('down'));
    api.scores.mockRejectedValue(new Error('down'));
    api.rules.mockRejectedValue(new Error('down'));
    // The week is reread every 5 minutes, not every minute.
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(api.audit).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(4 * 60_000); });
    await flush();
    expect(api.audit).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Tokens without WhiteRoom, est.4K');
    expect(text()).toContain('How is the score worked out?');
    root.unmount();
  });
});
