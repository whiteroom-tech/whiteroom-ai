// Agent names, how agents connect, and One key per agent (gap-closing spec
// 2c, 2e, 2f): the client calls, what each piece renders, and what a save
// says. Rendered statically, like the other component tests here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentKeyRuleGet, agentKeyRuleSet, agentNamesGet, agentRename, identityMix, WhiteRoomApiError } from '@/lib/whiteroom/client';
import { AgentIdentityView, runIdentityText } from '@/components/identity/IdentityMix';
import { saveAgentName } from '@/components/identity/AgentNamePanel';
import { changeAgentKeyMode, OneKeyPerAgentView } from '@/app/(citadel)/controls/_components/OneKeyPerAgent';
import { identityLines, type AgentKeyRuleResult } from '@/lib/agent-identity';

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sent = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body);

describe('client calls', () => {
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('agentNamesGet keeps text names only, and is null on an engine without names or an odd reply', async () => {
    fetchMock.mockResolvedValue(reply({ names: { a1: 'Billing bot', a2: 7, a3: null } }));
    await expect(agentNamesGet('f1', 'k')).resolves.toEqual({ a1: 'Billing bot' });
    expect(sent()).toEqual({ action: 'agent_names_get', fleet_id: 'f1' });
    fetchMock.mockResolvedValue(reply({ error: 'Unknown action.' }, 400));
    await expect(agentNamesGet('f1', 'k')).resolves.toBeNull();
    fetchMock.mockResolvedValue(reply({ names: 'x' }));
    await expect(agentNamesGet('f1', 'k')).resolves.toBeNull();
    fetchMock.mockResolvedValue(reply({ error: 'boom' }, 500));
    await expect(agentNamesGet('f1', 'k')).resolves.toBeNull();
  });

  it('agentNamesGet still signs out on an auth failure', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'Invalid credentials.' }, 401));
    await expect(agentNamesGet('f1', 'k')).rejects.toThrow();
  });

  it('agentRename sends the name (null clears) and returns what was saved, or the engine’s reason', async () => {
    fetchMock.mockResolvedValue(reply({ success: true, name: 'Billing bot' }));
    await expect(agentRename('f1', 'a1', 'Billing bot', 'k')).resolves.toBe('Billing bot');
    expect(sent()).toEqual({ action: 'agent_rename', fleet_id: 'f1', agent_id: 'a1', name: 'Billing bot' });
    fetchMock.mockResolvedValue(reply({ success: true, name: null }));
    await expect(agentRename('f1', 'a1', null, 'k')).resolves.toBeNull();
    fetchMock.mockResolvedValue(reply({ error: 'Another agent in this fleet (a2) is already called that.' }, 409));
    await expect(agentRename('f1', 'a1', 'Taken', 'k')).rejects.toMatchObject({ reason: 'Another agent in this fleet (a2) is already called that.' });
    fetchMock.mockResolvedValue(reply({ success: false, error: 'No.' }));
    await expect(agentRename('f1', 'a1', 'x', 'k')).rejects.toThrow('No.');
  });

  it('identityMix asks for a run or an agent, and reads an odd reply as no rows', async () => {
    fetchMock.mockResolvedValue(reply({ rows: [{ credential: 'bound_key', nameSource: 'explicit', calls: 2, lastAt: null }] }));
    await expect(identityMix('f1', { runId: 'a1~3' }, 'k')).resolves.toHaveLength(1);
    expect(sent()).toEqual({ action: 'identity_mix', fleet_id: 'f1', run_id: 'a1~3' });
    fetchMock.mockResolvedValue(reply({ rows: 'x' }));
    await expect(identityMix('f1', { agentId: 'a1' }, 'k')).resolves.toEqual([]);
    expect(sent()).toEqual({ action: 'identity_mix', fleet_id: 'f1', agent_id: 'a1' });
  });

  it('agentKeyRuleGet and agentKeyRuleSet ask for the rule and refuse an unsaved change', async () => {
    fetchMock.mockResolvedValue(reply({ applies: true, mode: 'off', since: null, summary: null }));
    await expect(agentKeyRuleGet('f1', 'k')).resolves.toMatchObject({ mode: 'off' });
    expect(sent()).toEqual({ action: 'agent_key_rule_get', fleet_id: 'f1' });
    fetchMock.mockResolvedValue(reply({ success: true, mode: 'watch' }));
    await expect(agentKeyRuleSet('f1', 'watch', 'k')).resolves.toBeUndefined();
    expect(sent()).toEqual({ action: 'agent_key_rule_set', fleet_id: 'f1', mode: 'watch' });
    fetchMock.mockResolvedValue(reply({ success: false, error: 'Not saved.' }));
    await expect(agentKeyRuleSet('f1', 'watch', 'k')).rejects.toThrow('Not saved.');
  });
});

describe('How it connects', () => {
  it('lists each way with its share, says when there were no calls, and hides when it can’t be read', () => {
    const lines = identityLines([{ credential: 'bound_key', nameSource: 'explicit', calls: 3, lastAt: null }, { credential: 'fleet_key', nameSource: 'inferred', calls: 1, lastAt: null }]);
    const html = renderToStaticMarkup(h(AgentIdentityView, { state: { kind: 'ok', lines } }));
    expect(html).toContain('Own key');
    expect(html).toContain('75%');
    expect(html).toContain('Shared key, name worked out by WhiteRoom');
    expect(renderToStaticMarkup(h(AgentIdentityView, { state: { kind: 'ok', lines: [] } }))).toContain('No calls in the last 7 days.');
    expect(renderToStaticMarkup(h(AgentIdentityView, { state: { kind: 'failed' } }))).toBe('');
  });

  it('a run says one way plainly, or each with its share', () => {
    expect(runIdentityText(identityLines([{ credential: 'bound_key', nameSource: 'explicit', calls: 3, lastAt: null }]))).toBe('Own key');
    expect(runIdentityText(identityLines([
      { credential: 'bound_key', nameSource: 'explicit', calls: 1, lastAt: null },
      { credential: 'none', nameSource: 'explicit', calls: 1, lastAt: null },
    ]))).toBe('Own key 50% · Provider key, name sent by the agent 50%');
    expect(runIdentityText([])).toBeNull();
  });
});

describe('saving a name', () => {
  it('cleans it, clears on empty, and refuses a bad one without asking the engine', async () => {
    const rename = vi.fn(async (_f: string, _a: string, name: string | null) => name);
    await expect(saveAgentName('f1', 'a1', '  Billing   bot ', 'k', rename)).resolves.toEqual({ ok: true, name: 'Billing bot', note: { ok: true, text: 'Saved.' } });
    expect(rename).toHaveBeenLastCalledWith('f1', 'a1', 'Billing bot', 'k');
    await expect(saveAgentName('f1', 'a1', '   ', 'k', rename)).resolves.toEqual({ ok: true, name: null, note: { ok: true, text: 'Name cleared.' } });
    rename.mockClear();
    expect((await saveAgentName('f1', 'a1', 'x'.repeat(61), 'k', rename)).ok).toBe(false);
    expect(rename).not.toHaveBeenCalled();
  });

  it('shows the engine’s reason for a refusal', async () => {
    const rename = vi.fn(async () => { throw new WhiteRoomApiError('HTTP 409', 409, 'Another agent in this fleet (a2) is already called that.'); });
    await expect(saveAgentName('f1', 'a1', 'Taken', 'k', rename)).resolves.toEqual({ ok: false, note: { ok: false, text: 'Another agent in this fleet (a2) is already called that.' } });
  });
});

describe('One key per agent card', () => {
  const data = (over: Partial<AgentKeyRuleResult['summary'] & object> = {}, mode: 'off' | 'watch' = 'watch'): AgentKeyRuleResult => ({
    applies: true, mode, since: '2026-11-20T10:00:00.000Z',
    summary: {
      from: '2026-11-20T10:00:00.000Z', to: '2026-11-24T10:00:00.000Z', recorded: true, unboundCalls: 4,
      byCredential: { fleet_key: 3, none: 1, session: 0, not_recorded: 0 },
      agents: [
        { agentId: 'a1', boundCalls: 0, unboundCalls: 3, unboundCredentials: ['fleet_key'], lastUnboundAt: null },
        { agentId: 'a2', boundCalls: 5, unboundCalls: 1, unboundCredentials: ['none'], lastUnboundAt: null },
        { agentId: 'a3', boundCalls: 9, unboundCalls: 0, unboundCredentials: [], lastUnboundAt: null },
      ],
      truncated: false, ...over,
    },
  });
  const render = (d: AgentKeyRuleResult | null, names: Record<string, string> = {}) => renderToStaticMarkup(h(OneKeyPerAgentView, { data: d, names, note: null, onChange: () => {} }));

  it('lists agents with calls that came in without their own key, by name with the id beside it', () => {
    const html = render(data(), { a1: 'Billing bot' });
    expect(html).toMatch(/<strong>4<\/strong>.*calls came in without the agent’s own key/);
    expect(html).toContain('Billing bot');
    expect(html).toContain('Shared key');
    expect(html).toContain('Provider key');
    expect(html).not.toContain('>a3<');
  });

  it('says so when every call used its own key, when calls aren’t recorded yet, and while Off', () => {
    expect(render(data({ unboundCalls: 0, agents: [] }))).toContain('every call came in on the agent’s own key');
    expect(render(data({ recorded: false }))).toContain('Calls aren’t recorded with their key yet.');
    expect(render(data({}, 'off'))).toContain('In the last 7 days');
  });

  it('counts the agents it can’t list', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ agentId: `a${i}`, boundCalls: 0, unboundCalls: 1, unboundCredentials: ['fleet_key' as const], lastUnboundAt: null }));
    expect(render(data({ agents: many }))).toContain('3 more agents not shown.');
    expect(render(data({ agents: many, truncated: true }))).toContain('More agents not shown.');
  });

  it('is hidden outside the rule or before it’s read', () => {
    expect(render(null)).toBe('');
    expect(render({ ...data(), applies: false })).toBe('');
  });

  it('a change that saved but couldn’t be re-read keeps the card, with the new mode and a note', async () => {
    const set = vi.fn(async () => {});
    await expect(changeAgentKeyMode('f1', 'watch', 'k', async () => true, set)).resolves.toEqual({ keepMode: false, note: null });
    const kept = await changeAgentKeyMode('f1', 'watch', 'k', async () => false, set);
    expect(kept).toMatchObject({ keepMode: true, note: { ok: true } });
    const refused = await changeAgentKeyMode('f1', 'watch', 'k', async () => true, async () => { throw new WhiteRoomApiError('HTTP 400', 400, 'One key per agent applies to production fleets only.'); });
    expect(refused).toEqual({ keepMode: false, note: { ok: false, text: 'One key per agent applies to production fleets only.' } });
  });
});
