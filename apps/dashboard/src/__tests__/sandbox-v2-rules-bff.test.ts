// Sandbox rules' BFF (app/api/sandbox/rules/[action]): same-origin, the
// signed-in owner of the production fleet only, the Sandbox pin passed on,
// only known fields forwarded, and only Sandbox rule actions ever called —
// never a production rule write. Placeholder keys only.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.fn();
const access = vi.fn();
const cookie = vi.fn();
const sameOrigin = vi.fn();
vi.mock('@/auth', () => ({ auth: () => auth() }));
vi.mock('@/lib/control-auth', () => ({ CONTROL_SECRET_HEADER: 'x-wr-dashboard-secret', CONTROL_USER_HEADER: 'x-wr-dashboard-user', controlAccessError: (...a: unknown[]) => access(...a) }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: () => cookie(), tokenFromUserFleets: async () => null }));
vi.mock('@/lib/origin-check', () => ({ checkSameOrigin: () => sameOrigin() }));

const { POST } = await import('@/app/api/sandbox/rules/[action]/route');
const { SANDBOX_RULES_ACTIONS, SANDBOX_RULES_ENGINE_ACTION } = await import('@/lib/sandbox/rules');

const FLEET_TOKEN = 'wr_placeholder_fleet_token';
const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
const RULE = {
  id: 'gr_placeholder_1', fleetId: SANDBOX_ID, ruleType: 'spend_cap', params: { dailyCap: 0.02, scope: 'run', unit: 'dollars' },
  mode: 'watch', response: 'block', alsoNotify: false, appliesTo: 'all', version: 1, changedBy: 'u1', changedAt: '2026-10-29T10:00:00.000Z',
  sourceRecommendationId: 'rec_x', internal: 'nope',
};
const LIST = { success: true, sandboxFleetId: SANDBOX_ID, rules: [RULE], source: 'ready_made', productionChanged: 0, extra: 'dropped' };

const engine = vi.fn();
const post = (action: string, body: unknown) =>
  POST(new Request(`https://app.example/api/sandbox/rules/${action}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ action }) });
const sentBodies = () => engine.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));

beforeEach(() => {
  vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'dash-secret');
  auth.mockResolvedValue({ user: { id: 'u1' } });
  access.mockReset().mockResolvedValue(null);
  cookie.mockResolvedValue(FLEET_TOKEN);
  sameOrigin.mockResolvedValue(null);
  engine.mockReset().mockImplementation(async (_url: string, init: RequestInit) => {
    const action = JSON.parse(String(init.body)).action as string;
    if (action === 'sandbox_rule_create' || action === 'sandbox_rule_update') return Response.json({ rule: RULE });
    if (action === 'sandbox_rule_delete') return Response.json({ success: true });
    return Response.json(LIST);
  });
  vi.stubGlobal('fetch', engine);
});

describe('Sandbox rules BFF: who may ask', () => {
  it('refuses cross-origin, signed-out, non-owners, Sandbox fleets and unknown actions without asking the engine', async () => {
    sameOrigin.mockResolvedValueOnce(Response.json({ error: 'Origin mismatch.' }, { status: 403 }));
    expect((await post('list', { fleet: 'prod-eu' })).status).toBe(403);
    auth.mockResolvedValueOnce(null);
    expect((await post('list', { fleet: 'prod-eu' })).status).toBe(401);
    // Signed out: refused before the body is even parsed.
    auth.mockResolvedValueOnce(null);
    expect((await post('list', 'not json')).status).toBe(401);
    // An update that changes nothing isn't sent.
    expect((await post('update', { fleet: 'prod-eu', ruleId: 'r1' })).status).toBe(400);
    access.mockResolvedValueOnce({ status: 403, error: 'Only this fleet’s owner can change its controls and settings.' });
    expect((await post('create', { fleet: 'prod-eu', ruleType: 'spend_cap' })).status).toBe(403);
    expect(access).toHaveBeenCalledWith('prod-eu', FLEET_TOKEN);
    expect((await post('list', { fleet: SANDBOX_ID })).status).toBe(400);
    expect((await post('governance_create_rule', { fleet: 'prod-eu' })).status).toBe(404);
    expect((await post('list', 'not json')).status).toBe(400);
    expect((await post('list', { fleet: 'prod-eu', pad: 'x'.repeat(17_000) })).status).toBe(413);
    expect(engine).not.toHaveBeenCalled();
  });

  it('passes the Sandbox pin, and refuses a malformed one', async () => {
    expect((await post('list', { fleet: 'prod-eu', sandboxFleetId: 'prod-eu' })).status).toBe(400);
    expect(engine).not.toHaveBeenCalled();
    await post('list', { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(sentBodies()[0]).toEqual({ action: 'sandbox_rules_list', fleet_id: 'prod-eu', sandbox_fleet_id: SANDBOX_ID });
    const headers = (engine.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-wr-dashboard-secret']).toBe('dash-secret');
    expect(headers['x-wr-dashboard-user']).toBe('u1');
  });

  it('passes a pin mismatch (409) and no Sandbox (404) through', async () => {
    engine.mockResolvedValueOnce(Response.json({ error: 'Your Sandbox changed. Reload the page.' }, { status: 409 }));
    const r = await post('update', { fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID, ruleId: 'gr_1', mode: 'enforce', ifVersion: 2 });
    expect(r.status).toBe(409);
    engine.mockResolvedValueOnce(Response.json({ error: 'No Sandbox for this fleet.' }, { status: 404 }));
    expect((await post('list', { fleet: 'prod-eu' })).status).toBe(404);
  });
});

describe('Sandbox rules BFF: only Sandbox rule actions', () => {
  it('maps every action to a sandbox_ engine action', () => {
    for (const a of SANDBOX_RULES_ACTIONS) expect(SANDBOX_RULES_ENGINE_ACTION[a]).toMatch(/^sandbox_rules?_/);
  });

  it('never calls a governance_* (production) action, whatever the body says', async () => {
    const extra = { action: 'governance_create_rule', fleet_id: 'other', rule_id: 'x' };
    await post('list', { fleet: 'prod-eu', ...extra });
    await post('ready-made', { fleet: 'prod-eu', ...extra });
    await post('copy-production', { fleet: 'prod-eu', ...extra });
    await post('create', { fleet: 'prod-eu', ruleType: 'keyword', ...extra });
    await post('update', { fleet: 'prod-eu', ruleId: 'gr_1', mode: 'watch', ...extra });
    await post('delete', { fleet: 'prod-eu', ruleId: 'gr_1', ...extra });
    const sent = sentBodies();
    expect(sent.map((b) => b.action)).toEqual([
      'sandbox_rules_list', 'sandbox_rules_apply_ready_made', 'sandbox_rules_copy_production', 'sandbox_rule_create', 'sandbox_rule_update', 'sandbox_rule_delete',
    ]);
    for (const b of sent) expect(b.fleet_id).toBe('prod-eu');
  });

  it('forwards known create/update/delete fields only, in the engine’s names', async () => {
    await post('create', { fleet: 'prod-eu', ruleType: 'spend_cap', mode: 'watch', response: 'pause', alsoNotify: true, params: { dailyCap: 1, scope: 'run', unit: 'dollars' }, appliesTo: ['a1'], description: 'Added', junk: 1 });
    await post('update', { fleet: 'prod-eu', ruleId: 'gr_1', ifVersion: 3, mode: 'enforce', response: 'block', alsoNotify: false });
    await post('delete', { fleet: 'prod-eu', ruleId: 'gr_1', mode: 'off' });
    expect(sentBodies()).toEqual([
      { action: 'sandbox_rule_create', fleet_id: 'prod-eu', rule_type: 'spend_cap', mode: 'watch', response: 'pause', also_notify: true, params: { dailyCap: 1, scope: 'run', unit: 'dollars' }, applies_to: ['a1'], description: 'Added' },
      { action: 'sandbox_rule_update', fleet_id: 'prod-eu', rule_id: 'gr_1', if_version: 3, mode: 'enforce', response: 'block', also_notify: false },
      { action: 'sandbox_rule_delete', fleet_id: 'prod-eu', rule_id: 'gr_1' },
    ]);
  });

  it('refuses bad rule fields before the engine', async () => {
    for (const body of [
      { ruleType: 'shell' }, { ruleType: 'spend_cap', mode: 'block' }, { ruleType: 'spend_cap', response: 'explode' },
      { ruleType: 'spend_cap', alsoNotify: 'yes' }, { ruleType: 'spend_cap', params: [1] }, { ruleType: 'spend_cap', appliesTo: 'some' },
    ]) expect((await post('create', { fleet: 'prod-eu', ...body })).status).toBe(400);
    expect((await post('update', { fleet: 'prod-eu', mode: 'watch' })).status).toBe(400);
    expect((await post('update', { fleet: 'prod-eu', ruleId: 'gr_1', ifVersion: -1 })).status).toBe(400);
    expect((await post('delete', { fleet: 'prod-eu', ruleId: '../x y' })).status).toBe(400);
    expect(engine).not.toHaveBeenCalled();
  });

  it('passes back only the rules state and rule fields', async () => {
    const list = await (await post('list', { fleet: 'prod-eu' })).json();
    expect(list).toEqual({
      success: true, sandboxFleetId: SANDBOX_ID, source: 'ready_made', productionChanged: 0,
      rules: [{ id: RULE.id, fleetId: SANDBOX_ID, ruleType: 'spend_cap', params: RULE.params, mode: 'watch', response: 'block', alsoNotify: false, appliesTo: 'all', version: 1, changedBy: 'u1', changedAt: RULE.changedAt }],
    });
    const created = await (await post('create', { fleet: 'prod-eu', ruleType: 'spend_cap' })).json();
    expect(created.rule).not.toHaveProperty('internal');
    expect(created.rule).not.toHaveProperty('sourceRecommendationId');
  });

  it('says so when the engine’s answer can’t be read', async () => {
    engine.mockResolvedValueOnce(Response.json({ success: true }));
    expect((await post('list', { fleet: 'prod-eu' })).status).toBe(502);
  });
});
