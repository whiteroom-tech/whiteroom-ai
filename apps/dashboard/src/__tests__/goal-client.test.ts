// Agent detail › Goal talks to the engine through these three calls.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ControlDeniedError, agentNewRun, goalGet, goalSetOwner } from '@/lib/whiteroom/client';
import { changedElsewhere } from '@/lib/settings-flow';

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

  it('sets or clears the goal over the revision on screen, and rejects a refused change', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ owner: { goal: 'x', revision: 1, set_by: 'dashboard', updated_at: '' } }));
    await goalSetOwner('f', 'a', 'x', 0);
    expect(sentBody()).toMatchObject({ action: 'goal_set_owner', goal: 'x', base_revision: 0 });
    await goalSetOwner('f', 'a', null, 1);
    expect(sentBody()).toMatchObject({ action: 'goal_set_owner', goal: null, base_revision: 1 });
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Only the fleet owner can change this.', code: 'control_denied' }, 403));
    await expect(goalSetOwner('f', 'a', 'y', 1)).rejects.toBeInstanceOf(ControlDeniedError);
  });

  it('rejects a change made over an outdated goal with the engine’s words, so the panel re-reads it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'This goal was changed elsewhere. Reload and try again.' }, 409));
    const err = await goalSetOwner('f', 'a', 'y', 0).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(changedElsewhere((err as Error).message)).toBe(true);
    expect(changedElsewhere('Only the fleet owner can change this.')).toBe(false);
  });

  it('starts a new task, and rejects one the engine refused', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await expect(agentNewRun('f', 'a')).resolves.toEqual({ success: true });
    expect(sentBody()).toMatchObject({ action: 'agent_new_run', fleet_id: 'f', agent_id: 'a' });
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'Agent not found.' }));
    await expect(agentNewRun('f', 'a')).rejects.toThrow('Agent not found.');
  });
});
