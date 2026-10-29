// Home › each agent's input for the week: read a few at a time, ids that differ only in
// case added together, and any failed read flagged so the last figures stay.
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ agent: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), performanceAgent: api.agent }));
const { agentInputs } = await import('@/lib/home-agents');

const calls = (inputTokens: number, cached = 0) => ({ fleetId: 'f', agentId: 'a', period: { start: '', end: '' }, hourly: [], totals: { calls: 1, costMicros: 0, inputTokens, cacheReadTokens: cached, cacheWriteTokens: 0 } });

afterEach(() => api.agent.mockReset());

describe('agentInputs', () => {
  it('reads every agent over the hours given, at most 6 at a time, cached input included', async () => {
    let open = 0;
    let most = 0;
    api.agent.mockImplementation(async () => { open++; most = Math.max(most, open); await Promise.resolve(); open--; return calls(100, 50); });
    const ids = Array.from({ length: 14 }, (_, i) => `agent-${i}`);
    const out = await agentInputs('f', ids, 170, 'k');
    expect(api.agent).toHaveBeenCalledTimes(14);
    expect(api.agent.mock.calls[0]).toEqual(['f', 'agent-0', 170, 'k']);
    expect(most).toBe(6);
    expect(out.failed).toEqual([]);
    expect(Object.keys(out.byAgent)).toHaveLength(14);
    expect(out.byAgent['agent-13']).toBe(150);
  });

  it('keeps 6 reads going: a slow read doesn’t hold up the rest, and a repeated id is read once', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    api.agent.mockImplementation(async (_f: string, id: string) => { if (id === 'slow') await slow; return calls(1); });
    const ids = ['slow', ...Array.from({ length: 9 }, (_, i) => `a${i}`), 'a0'];
    const done = agentInputs('f', ids, 24);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // All but the slow one are read while it's still out.
    expect(api.agent).toHaveBeenCalledTimes(10);
    release();
    expect(Object.keys((await done).byAgent)).toHaveLength(10);
  });

  it('adds up ids that differ only in case, and names each agent whose read failed or was refused', async () => {
    api.agent.mockImplementation(async (_f: string, id: string) => {
      if (id === 'Down' || id === 'writer') throw new Error('down');
      if (id === 'refused') return { error: 'no' };
      return calls(id === 'Lead-Agent' ? 300 : 200);
    });
    const out = await agentInputs('f', ['lead-agent', 'Lead-Agent', 'Down', 'refused', 'writer', 'WRITER'], 24);
    // writer's other case read fine, but half a sum isn't its input: none, and it's named failed.
    expect(out.byAgent).toEqual({ 'lead-agent': 500 });
    expect(out.failed.sort()).toEqual(['down', 'refused', 'writer']);
  });

  it('leaves an agent out when the engine sends no input totals', async () => {
    api.agent.mockResolvedValue({ ...calls(0), totals: { calls: 1, costMicros: 0 } });
    expect(await agentInputs('f', ['a'], 24)).toEqual({ byAgent: {}, failed: [] });
  });
});
