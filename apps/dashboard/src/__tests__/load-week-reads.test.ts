// The 7-day reads Home and the agent page share: the fleet's hourly read only
// when asked, the agent's id passed to rule_actions as given, and that agent
// found in what comes back whatever its capitals.
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ audit: vi.fn(), scores: vi.fn(), rules: vi.fn(), hourly: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  auditSummary: api.audit, performanceAgentScores: api.scores, ruleActions: api.rules, performanceFleetHourly: api.hourly,
}));
const { agentWeekFrom, loadWeekReads } = await import('@/lib/home-agents');

const counts = (blocked: number) => ({ blocked, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 });

afterEach(() => { for (const f of Object.values(api)) f.mockReset(); });

describe('loadWeekReads', () => {
  it('reads the fleet’s hourly figures only when asked', async () => {
    for (const f of Object.values(api)) f.mockResolvedValue({});
    expect((await loadWeekReads('f1', 'k')).hourly).toBeNull();
    expect(api.hourly).not.toHaveBeenCalled();
    api.hourly.mockResolvedValue({ hourly: [] });
    expect((await loadWeekReads('f1', 'k', { hourly: true })).hourly).toEqual({ hourly: [] });
    expect(api.hourly).toHaveBeenCalledTimes(1);
  });

  it('passes the agent id to rule_actions as given, and finds that agent whatever its capitals', async () => {
    api.audit.mockResolvedValue({ fleetId: 'f1', savingsBuckets: [], governance: { blocks: 0, wouldBlocks: 0, byAgent: {}, byRule: {} } });
    api.scores.mockResolvedValue({ fleetId: 'f1', agents: [] });
    // The engine answers for the exact id it was given.
    api.rules.mockResolvedValue({ fleetId: 'f1', totals: counts(3), byAgent: { 'Lead-Agent': counts(3) } });
    const r = await loadWeekReads('f1', 'k', { agentId: 'Lead-Agent' });
    expect(api.rules.mock.calls[0][1]).toMatchObject({ agentId: 'Lead-Agent' });
    expect(agentWeekFrom(undefined, 'Lead-Agent', r.audit, r.scores, r.rules).rules).toMatchObject({ blocks: 3 });
  });

  it('comes back null for a read that failed, never zero', async () => {
    for (const f of Object.values(api)) f.mockRejectedValue(new Error('down'));
    const r = await loadWeekReads('f1', 'k', { hourly: true });
    expect([r.audit, r.scores, r.rules, r.hourly]).toEqual([null, null, null, null]);
  });
});
