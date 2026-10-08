import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), access: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ db: () => ({ query: mocks.query }) }));
vi.mock('@/lib/origin-check', () => ({ checkSameOrigin: async () => null }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: async () => 'wr_tok', setFleetAuthCookie: vi.fn(), tokenFromUserFleets: async () => null }));
vi.mock('@/lib/control-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/control-auth')>()),
  controlAccessError: mocks.access,
}));

import { recordControlAction, holdsFleet } from '@/lib/control-actions';
import { POST } from '@/app/api/fleet/engine/route';
import { GET } from '@/app/api/fleet/control-actions/route';

const inserts = () => mocks.query.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO control_actions'));

beforeEach(() => { mocks.query.mockReset().mockResolvedValue({ rows: [] }); mocks.auth.mockReset(); mocks.access.mockReset().mockResolvedValue(null); });
afterEach(() => vi.unstubAllGlobals());

describe('recordControlAction', () => {
  it('records the person, agent and rule for a control change', async () => {
    await recordControlAction('u1', 'f1', 'pause_agent', '{"agent_id":"a1"}', '{}');
    expect(inserts()[0][1]).toEqual(['f1', 'pause_agent', 'a1', null, 'u1']);
  });

  it('prunes the fleet\'s rows older than 45 days as it writes', async () => {
    await recordControlAction('u1', 'f1', 'stop_agent', '{"agent_id":"a1"}', '{}');
    const prune = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith('DELETE FROM control_actions'));
    expect(prune?.[1]).toEqual(['f1', 45]);
  });

  it('records an owner goal change, so the goal can name who set it', async () => {
    await recordControlAction('u1', 'f1', 'goal_set_owner', '{"agent_id":"a1","goal":"x"}', '{}');
    expect(inserts()[0][1]).toEqual(['f1', 'goal_set_owner', 'a1', null, 'u1']);
  });

  it('records only holds, rule changes and goals, and swallows a failed write', async () => {
    for (const a of ['alerts_test', 'alerts_set_slack', 'resume_agent', 'goal_get', 'agent_new_run']) await recordControlAction('u1', 'f1', a, '{}', '{}');
    expect(inserts()).toHaveLength(0);
    mocks.query.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordControlAction('u1', 'f1', 'stop_agent', '{"agent_id":"a1"}', '{}')).resolves.toBeUndefined();
  });

  it('holdsFleet checks both the account\'s own fleet and linked fleets', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await holdsFleet('u1', 'f1')).toBe(true);
    expect(mocks.query.mock.calls[0][1]).toEqual(['u1', 'f1']);
    expect(await holdsFleet('u1', 'f2')).toBe(false);
  });
});

describe('engine route records accepted control changes', () => {
  const engine = (status: number, reply = '{"success":true}') => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(reply, { status, headers: { 'content-type': 'application/json' } })));
  const call = (b: Record<string, unknown>) => POST(new Request('http://localhost/api/fleet/engine', { method: 'POST', body: JSON.stringify(b) }));

  it('passes the reply through and records who made the change', async () => {
    engine(200, '{"rule":{"id":"r9"}}');
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    const res = await call({ action: 'governance_create_rule', fleet_id: 'f1' });
    expect(await res.json()).toEqual({ rule: { id: 'r9' } });
    expect(inserts()[0][1]).toEqual(['f1', 'governance_create_rule', null, 'r9', 'u1']);
  });

  it('records nothing when the engine refuses, or for ordinary reads', async () => {
    engine(409);
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    expect((await call({ action: 'pause_agent', fleet_id: 'f1', agent_id: 'a' })).status).toBe(409);
    engine(200);
    await call({ action: 'fleet_report', fleet_id: 'f1' });
    expect(inserts()).toHaveLength(0);
  });

  it('still answers success when finding the person fails after the change', async () => {
    engine(200);
    mocks.auth.mockRejectedValue(new Error('session store down'));
    const res = await call({ action: 'stop_agent', fleet_id: 'f1', agent_id: 'a' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});

describe('GET /api/fleet/control-actions', () => {
  const get = (q: string) => GET(new Request(`http://localhost/api/fleet/control-actions${q}`));

  it('needs a signed-in account and a fleet id', async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await get('?fleet_id=f1')).status).toBe(401);
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    expect((await get('')).status).toBe(400);
  });

  it('refuses an account that doesn\'t hold the fleet, and says so when the check fails', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    expect((await get('?fleet_id=f1')).status).toBe(403);
    mocks.query.mockRejectedValueOnce(new Error('db down'));
    expect((await get('?fleet_id=f1')).status).toBe(503);
  });

  it('returns names, never emails, and an empty list if the table is missing', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u1' } });
    mocks.query.mockResolvedValueOnce({ rows: [1] }).mockResolvedValueOnce({ rows: [{ action: 'pause_agent', agentId: 'a', ruleId: null, by: 'R Haque', at: '2026-10-02T20:00:00Z' }] });
    const res = await get('?fleet_id=f1&since=2026-10-01T00:00:00Z');
    expect((await res.json()).actions[0].by).toBe('R Haque');
    expect(String(mocks.query.mock.calls[1][0])).not.toMatch(/email/);
    mocks.query.mockResolvedValueOnce({ rows: [1] }).mockRejectedValueOnce(new Error('relation "control_actions" does not exist'));
    expect(await (await get('?fleet_id=f1')).json()).toEqual({ actions: [] });
  });
});
