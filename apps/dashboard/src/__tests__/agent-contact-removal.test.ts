// A removed agent's contact goes with it (gap-closing spec A5): which
// accepted control actions count as removing an agent.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: () => ({ query: vi.fn() }) }));
vi.mock('@/lib/control-auth', () => ({ fleetOwners: vi.fn() }));

import { afterControlAccepted, removedAgentOf } from '@/lib/agent-contacts';

const body = (o: Record<string, unknown>) => JSON.stringify({ action: 'deregister_agent', fleet_id: 'f1', agent_id: 'a1', ...o });

describe('removedAgentOf', () => {
  it('names the agent a successful removal took out', () => {
    expect(removedAgentOf('deregister_agent', body({}), JSON.stringify({ success: true }))).toEqual({ fleetId: 'f1', agentId: 'a1' });
  });

  it('is null for a refusal, another action, or a body it can’t read', () => {
    expect(removedAgentOf('deregister_agent', body({}), JSON.stringify({ error: 'No such agent.' }))).toBeNull();
    expect(removedAgentOf('deregister_agent', body({}), JSON.stringify({ success: false }))).toBeNull();
    expect(removedAgentOf('pause_agent', body({}), JSON.stringify({ success: true }))).toBeNull();
    expect(removedAgentOf('deregister_agent', 'not json', JSON.stringify({ success: true }))).toBeNull();
    expect(removedAgentOf('deregister_agent', body({ agent_id: 'not an id!' }), JSON.stringify({ success: true }))).toBeNull();
    expect(removedAgentOf('deregister_agent', body({ agent_id: 'x'.repeat(129) }), JSON.stringify({ success: true }))).toBeNull();
    // What an id may be is the engine's to say: any id it accepted is cleaned up.
    expect(removedAgentOf('deregister_agent', body({ agent_id: 'team/agent#7' }), JSON.stringify({ success: true }))).toEqual({ fleetId: 'f1', agentId: 'team/agent#7' });
  });
});

describe('afterControlAccepted', () => {
  const ok = JSON.stringify({ success: true });
  it('forgets the removed agent’s contact for the fleet the action was allowed on', async () => {
    const forget = vi.fn(async () => {});
    await afterControlAccepted({ action: 'deregister_agent', fleetId: 'f1' }, body({}), ok, forget);
    expect(forget).toHaveBeenCalledWith('f1', 'a1');
  });

  it('touches nothing for another fleet’s id in the body, a refusal, or another action', async () => {
    const forget = vi.fn(async () => {});
    await afterControlAccepted({ action: 'deregister_agent', fleetId: 'f2' }, body({}), ok, forget);
    await afterControlAccepted({ action: 'deregister_agent', fleetId: 'f1' }, body({}), JSON.stringify({ error: 'no' }), forget);
    await afterControlAccepted({ action: 'pause_agent', fleetId: 'f1' }, body({}), ok, forget);
    expect(forget).not.toHaveBeenCalled();
  });

  it('never throws when the delete fails: the removal already happened', async () => {
    await expect(afterControlAccepted({ action: 'deregister_agent', fleetId: 'f1' }, body({}), ok, async () => { throw new Error('db down'); })).resolves.toBeUndefined();
  });
});
