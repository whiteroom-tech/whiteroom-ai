// Agent detail › Goal talks to the engine through these three calls.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ControlDeniedError, agentNewRun, goalGet, goalSetOwner } from '@/lib/whiteroom/client';

const fetchMock = vi.fn();
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sentBody = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body);

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('goal client', () => {
  it('reads the owner goal, including an unreadable one and none', async () => {
    const owner = { goal: 'Qualify 50 clinics', revision: 3, set_by: 'user:clx9k2abc', updated_at: '2026-10-07T00:00:00Z' };
    fetchMock.mockResolvedValue(jsonResponse({ owner }));
    await expect(goalGet('f', 'a')).resolves.toEqual({ owner });
    expect(sentBody()).toMatchObject({ action: 'goal_get', fleet_id: 'f', agent_id: 'a' });
    fetchMock.mockResolvedValue(jsonResponse({ owner: { ...owner, goal: null, unreadable: true } }));
    await expect(goalGet('f', 'a')).resolves.toMatchObject({ owner: { goal: null, unreadable: true } });
    fetchMock.mockResolvedValue(jsonResponse({ owner: null }));
    await expect(goalGet('f', 'a')).resolves.toEqual({ owner: null });
  });

  it('returns null from an engine without goals, so the panel hides', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unknown action: goal_get' }, 400));
    await expect(goalGet('f', 'a')).resolves.toBeNull();
  });

  it('sets or clears the goal, and rejects a refused change', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ owner: { goal: 'x', revision: 1, set_by: 'dashboard', updated_at: '' } }));
    await goalSetOwner('f', 'a', 'x');
    expect(sentBody()).toMatchObject({ action: 'goal_set_owner', goal: 'x' });
    await goalSetOwner('f', 'a', null);
    expect(sentBody()).toMatchObject({ action: 'goal_set_owner', goal: null });
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Only the fleet owner can change this.', code: 'control_denied' }, 403));
    await expect(goalSetOwner('f', 'a', 'y')).rejects.toBeInstanceOf(ControlDeniedError);
  });

  it('starts a new task, and rejects one the engine refused', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await expect(agentNewRun('f', 'a')).resolves.toEqual({ success: true });
    expect(sentBody()).toMatchObject({ action: 'agent_new_run', fleet_id: 'f', agent_id: 'a' });
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'Agent not found.' }));
    await expect(agentNewRun('f', 'a')).rejects.toThrow('Agent not found.');
  });
});
