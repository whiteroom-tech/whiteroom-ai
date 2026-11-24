// A removed agent's contact goes with it (gap-closing spec A5): which
// accepted control actions count as removing an agent.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: () => ({ query: vi.fn() }) }));
vi.mock('@/lib/control-auth', () => ({ fleetOwners: vi.fn() }));

import { removedAgentOf } from '@/lib/agent-contacts';

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
  });
});
