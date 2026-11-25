// Agent names, how agents connect, and One key per agent (gap-closing spec
// 2c, 2e, 2f): the client calls, what each piece renders, and what a save
// says. Rendered statically, like the other component tests here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentKeyReadiness, agentKeyRuleGet, agentKeyRuleSet, agentNamesGet, agentRename, agentRetire, changeFailureText, ControlDeniedError, identityMix, WhiteRoomApiError } from '@/lib/whiteroom/client';
import { AgentIdentityView, readIdentityMix, RunIdentityLine, runIdentityText } from '@/components/identity/IdentityMix';
import { AgentNamePanel, namesDiffer, saveAgentName } from '@/components/identity/AgentNamePanel';
import { blockerText, changeAgentKeyMode, OneKeyPerAgentView, retireAgent } from '@/app/(citadel)/controls/_components/OneKeyPerAgent';
import { AgentTitle } from '@/components/agent/AgentTitle';
import { identityLines, type AgentKeyReadiness, type AgentKeyRuleResult } from '@/lib/agent-identity';

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

  it('identityMix reads an unknown credential as Other and leaves out a malformed row', async () => {
    fetchMock.mockResolvedValue(reply({ rows: [
      { credential: 'quantum_key', nameSource: 'explicit', calls: 2, lastAt: null },
      { credential: 'bound_key', nameSource: 'explicit', calls: 'many' },
      null,
      { credential: 'fleet_key', nameSource: 'guessed', calls: 1, lastAt: null },
    ] }));
    const rows = await identityMix('f1', { agentId: 'a1' }, 'k');
    expect(rows.map((r) => identityLines([r])[0].words)).toEqual(['Other', 'Not known']);
  });

  it('agentKeyRuleGet shows an unbound credential it doesn’t know as Other, once', async () => {
    fetchMock.mockResolvedValue(reply({ applies: true, mode: 'watch', since: null, summary: { recorded: true, unboundCalls: 3, byCredential: {}, agents: [
      { agentId: 'a1', boundCalls: 0, unboundCalls: 3, unboundCredentials: ['signature_invalid', 'quantum_key', 'fleet_key', 'warp_key'], lastUnboundAt: null },
    ], truncated: false } }));
    const res = await agentKeyRuleGet('f1', 'k');
    expect(res.summary!.agents[0].unboundCredentials).toEqual(['signature_invalid', 'other', 'fleet_key']);
  });

  it('agentKeyRuleGet refuses a reply it can’t read, so the card stays hidden', async () => {
    fetchMock.mockResolvedValue(reply({ applies: true, mode: 'strict', since: null, summary: null }));
    await expect(agentKeyRuleGet('f1', 'k')).rejects.toThrow();
    fetchMock.mockResolvedValue(reply({ applies: true, mode: 'enforce', since: null, summary: null }));
    await expect(agentKeyRuleGet('f1', 'k')).resolves.toMatchObject({ mode: 'enforce' });
    fetchMock.mockResolvedValue(reply({ applies: true, mode: 'watch', since: null, summary: { unboundCalls: 1, byCredential: {}, agents: [{ agentId: 'a1' }] } }));
    await expect(agentKeyRuleGet('f1', 'k')).rejects.toThrow();
    // No recorded flag: malformed, not "calls aren't recorded yet".
    fetchMock.mockResolvedValue(reply({ applies: true, mode: 'watch', since: null, summary: { unboundCalls: 0, byCredential: {}, agents: [] } }));
    await expect(agentKeyRuleGet('f1', 'k')).rejects.toThrow();
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
    fetchMock.mockResolvedValue(reply({ success: true, mode: 'enforce' }));
    await agentKeyRuleSet('f1', 'enforce', 'k', 'tok1');
    expect(sent()).toEqual({ action: 'agent_key_rule_set', fleet_id: 'f1', mode: 'enforce', readiness_token: 'tok1' });
  });

  it('agentRetire sends the agent and whether it is retired', async () => {
    fetchMock.mockResolvedValue(reply({ success: true, retired: true }));
    await agentRetire('f1', 'a1', true, 'k');
    expect(sent()).toEqual({ action: 'agent_retire', fleet_id: 'f1', agent_id: 'a1', retired: true });
  });

  it('agentKeyReadiness reads blockers it knows, keeps Enforce closed for one it doesn’t, and refuses a malformed reply', async () => {
    const base = { ready: true, mode: 'watch', from: null, to: 'x', observationDays: 7, agents: [], retired: [], truncated: false, token: 't' };
    fetchMock.mockResolvedValue(reply({ ...base, blockers: [] }));
    await expect(agentKeyReadiness('f1', 'k')).resolves.toMatchObject({ ready: true, token: 't' });
    expect(sent()).toEqual({ action: 'agent_key_readiness', fleet_id: 'f1' });
    fetchMock.mockResolvedValue(reply({ ...base, ready: true, blockers: [{ kind: 'quantum' }] }));
    await expect(agentKeyReadiness('f1', 'k')).resolves.toMatchObject({ ready: false, blockers: [] });
    fetchMock.mockResolvedValue(reply({ ...base, ready: false, blockers: [{ kind: 'unbound_calls', calls: 'lots' }, { kind: 'not_watching' }] }));
    await expect(agentKeyReadiness('f1', 'k')).resolves.toMatchObject({ ready: false, blockers: [{ kind: 'not_watching' }] });
    fetchMock.mockResolvedValue(reply({ ...base, token: undefined, blockers: [] }));
    await expect(agentKeyReadiness('f1', 'k')).rejects.toThrow();
  });
});

describe('Agent page title', () => {
  it('shows the name with the id beside it, or the id alone', () => {
    const named = renderToStaticMarkup(h(AgentTitle, { agentId: 'claims-7', name: 'Claims bot' }));
    expect(named).toContain('Claims bot');
    expect(named).toContain('<span class="wr-agent-title__id">claims-7</span>');
    expect(renderToStaticMarkup(h(AgentTitle, { agentId: 'claims-7', name: null }))).not.toContain('wr-agent-title__id');
    expect(renderToStaticMarkup(h(AgentTitle, { agentId: 'claims-7', name: 'claims-7' }))).not.toContain('wr-agent-title__id');
  });
});

describe('change failure text', () => {
  it('uses the engine’s reason, then the owner refusal, then the fallback', () => {
    expect(changeFailureText(new WhiteRoomApiError('HTTP 409', 409, 'Taken.'), 'x')).toBe('Taken.');
    expect(changeFailureText(new ControlDeniedError('Only the owner.'), 'x')).toBe('Only the owner.');
    expect(changeFailureText(new Error('net'), 'Try again.')).toBe('Try again.');
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

describe('Name panel', () => {
  it('counts a draft as changed only when it would save as something else', () => {
    expect(namesDiffer('Billing  bot ', 'Billing bot')).toBe(false);
    expect(namesDiffer('Billing bot 2', 'Billing bot')).toBe(true);
    expect(namesDiffer('   ', 'Billing bot')).toBe(true);
    expect(namesDiffer('   ', null)).toBe(false);
    // An invalid draft is a change, so Save can say what's wrong.
    expect(namesDiffer('x'.repeat(61), null)).toBe(true);
  });

  it('starts with the stored name, Save off, and Clear only when there is a name', () => {
    const named = renderToStaticMarkup(h(AgentNamePanel, { fleetId: 'f1', agentId: 'a1', name: 'Billing bot', onSaved: () => {} }));
    expect(named).toContain('value="Billing bot"');
    expect(named).toMatch(/<button[^>]*disabled[^>]*>Save<\/button>/);
    expect(named).toContain('>Clear<');
    expect(renderToStaticMarkup(h(AgentNamePanel, { fleetId: 'f1', agentId: 'a1', name: null, onSaved: () => {} }))).not.toContain('>Clear<');
  });
});

describe('identity reads', () => {
  const rows = [{ credential: 'bound_key' as const, nameSource: 'explicit' as const, calls: 2, lastAt: null }];

  it('set the lines, for the run or agent asked about', async () => {
    const set = vi.fn();
    const read = vi.fn(async () => rows);
    await readIdentityMix('f1', { runId: 'a1~3' }, 'k', () => true, set, undefined, read);
    expect(read).toHaveBeenCalledWith('f1', { runId: 'a1~3' }, 'k');
    expect(set).toHaveBeenCalledWith({ kind: 'ok', lines: [{ words: 'Own key', calls: 2, percent: 100 }] });
  });

  it('drop a reply that lands after the run or agent changed', async () => {
    const set = vi.fn();
    const onAuthError = vi.fn();
    await readIdentityMix('f1', { agentId: 'a1' }, 'k', () => false, set, onAuthError, async () => rows);
    await readIdentityMix('f1', { agentId: 'a1' }, 'k', () => false, set, onAuthError, async () => { throw new WhiteRoomApiError('HTTP 401', 401); });
    expect(set).not.toHaveBeenCalled();
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('fail on an error, and sign out only on an expired session', async () => {
    const set = vi.fn();
    const onAuthError = vi.fn();
    await readIdentityMix('f1', { agentId: 'a1' }, 'k', () => true, set, onAuthError, async () => { throw new WhiteRoomApiError('HTTP 500', 500); });
    expect(set).toHaveBeenLastCalledWith({ kind: 'failed' });
    expect(onAuthError).not.toHaveBeenCalled();
    await readIdentityMix('f1', { agentId: 'a1' }, 'k', () => true, set, onAuthError, async () => { throw new WhiteRoomApiError('HTTP 401', 401); });
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('the run line shows nothing until its read lands', () => {
    expect(renderToStaticMarkup(h(RunIdentityLine, { fleetId: 'f1', runId: 'a1~3' }))).toBe('');
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
  const render = (d: AgentKeyRuleResult | null, names: Record<string, string> = {}, readiness: AgentKeyReadiness | null = null) => renderToStaticMarkup(h(OneKeyPerAgentView, { data: d, names, note: null, readiness, onChange: () => {} }));
  const ready = (over: Partial<AgentKeyReadiness> = {}): AgentKeyReadiness => ({
    ready: false, mode: 'watch', from: null, to: '2026-11-24T10:00:00.000Z', observationDays: 7, agents: [], retired: [], truncated: false, token: 't', blockers: [], ...over,
  });
  const enforceButton = (html: string) => html.match(/<button[^>]*>Enforce<\/button>/)?.[0] ?? null;

  it('offers no Enforce on an engine without readiness', () => {
    expect(enforceButton(render(data()))).toBeNull();
  });

  it('names what keeps Enforce closed, with Mark retired on agents not seen on their own key', () => {
    const html = render(data(), { a2: 'Night job' }, ready({
      blockers: [
        { kind: 'watch_too_short', readyAt: '2026-11-27T10:00:00.000Z' },
        { kind: 'unbound_calls', calls: 4 },
        { kind: 'capture_gaps', gaps: 1, lastAt: '2026-11-22T10:00:00.000Z' },
        { kind: 'agents_not_seen', agentIds: ['a2'] },
      ],
      retired: [{ agentId: 'old-bot', retiredAt: 'x', retiredBy: 'dashboard' }],
    }));
    expect(enforceButton(html)).toMatch(/disabled/);
    expect(html).toContain('Not ready yet.');
    expect(html).toContain('Watch needs 7 days. Ready Nov 27 at the earliest.');
    expect(html).toContain('4 calls in the last 7 days came in without the agent’s own key.');
    expect(html).toContain('Some calls weren’t recorded in the last 7 days. Ready Nov 29 at the earliest.');
    expect(html).toContain('Night job');
    expect(html).toContain('Mark retired');
    expect(html).toMatch(/old-bot.*Retired.*Undo/);
  });

  it('leaves out a date it can’t read instead of a blank one', () => {
    expect(blockerText({ kind: 'capture_gaps', gaps: 1, lastAt: 'not a time' }, 7)).toBe('Some calls weren’t recorded in the last 7 days.');
    expect(blockerText({ kind: 'watch_too_short', readyAt: 'soon' }, 7)).toBe('Watch needs 7 days.');
  });

  it('opens Enforce once ready, and in Enforce says calls without a key are refused', () => {
    const html = render(data({ unboundCalls: 0, agents: [] }), {}, ready({ ready: true }));
    expect(enforceButton(html)).not.toMatch(/disabled/);
    expect(html).toContain('Ready. Calls without the agent’s own key will be refused.');
    const on = render({ ...data({ unboundCalls: 0, agents: [] }), mode: 'enforce' }, {}, null);
    expect(enforceButton(on)).not.toBeNull();
    expect(on).toContain('Each agent needs its own WhiteRoom key. Calls without one are refused.');
    expect(on).not.toContain('Not ready yet.');
  });

  it('lists agents with calls that came in without their own key, by name with the id beside it', () => {
    const html = render(data(), { a1: 'Billing bot' });
    expect(html).toMatch(/<strong>4<\/strong>.*calls came in without the agent’s own key/);
    expect(html).toContain('Each agent needs its own WhiteRoom key. In Watch, calls without one are counted, not blocked.');
    // Agent keys are made on Fleet key, and sharing a provider key is fine: said beside the link.
    expect(html).toContain('href="/fleet-key#provider-keys"');
    expect(html).toContain('Create agent keys on Fleet key');
    expect(html).toContain('You can use the same provider key for each.');
    expect(html).not.toContain('Create keys in Settings');
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

  it('shows no stray separator for an agent whose credentials this build doesn’t know', () => {
    const html = render(data({ agents: [{ agentId: 'a9', boundCalls: 0, unboundCalls: 2, unboundCredentials: [], lastUnboundAt: null }] }));
    // The row has no separator at all.
    expect(html).not.toContain(' · ');
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

  it('still offers the switch when the counts are missing', () => {
    const html = render({ applies: true, mode: 'off', since: null, summary: null });
    expect(html).toContain('One key per agent');
    expect(html).toContain('The counts aren’t available right now.');
  });

  it('a change that saved but couldn’t be re-read keeps the card, with the new mode and a note', async () => {
    const set = vi.fn(async () => {});
    await expect(changeAgentKeyMode('f1', 'watch', 'k', async () => true, set)).resolves.toEqual({ keepMode: false, note: null });
    const kept = await changeAgentKeyMode('f1', 'watch', 'k', async () => false, set);
    expect(kept).toMatchObject({ keepMode: true, note: { ok: true } });
    const refused = await changeAgentKeyMode('f1', 'watch', 'k', async () => true, async () => { throw new WhiteRoomApiError('HTTP 400', 400, 'One key per agent applies to production fleets only.'); });
    expect(refused).toEqual({ keepMode: false, note: { ok: false, text: 'One key per agent applies to production fleets only.' } });
  });

  it('marks an agent retired, reads the card again, and says what failed', async () => {
    const call = vi.fn(async () => {});
    const reload = vi.fn(async () => true);
    await expect(retireAgent('f1', 'a2', true, 'k', reload, call)).resolves.toBeNull();
    expect(call).toHaveBeenCalledWith('f1', 'a2', true, 'k');
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(retireAgent('f1', 'a2', false, 'k', async () => false, call)).resolves.toEqual({ ok: true, text: 'Saved. Reload the page to see it.' });
    const reloadAfterFail = vi.fn(async () => true);
    const refused = await retireAgent('f1', 'a2', true, 'k', reloadAfterFail, async () => { throw new WhiteRoomApiError('HTTP 409', 409, 'This fleet is closed.'); });
    expect(refused).toEqual({ ok: false, text: 'This fleet is closed.' });
    expect(reloadAfterFail).not.toHaveBeenCalled();
    await expect(retireAgent('f1', 'a2', true, 'k', reload, async () => { throw new Error('network'); })).resolves.toEqual({ ok: false, text: 'Couldn’t change it. Nothing changed. Try again.' });
  });

  it('switches Enforce on with the readiness token, and reads the card again when it is refused', async () => {
    const set = vi.fn(async () => {});
    await changeAgentKeyMode('f1', 'enforce', 'k', async () => true, set, 'tok');
    expect(set).toHaveBeenCalledWith('f1', 'enforce', 'k', 'tok');
    await changeAgentKeyMode('f1', 'watch', 'k', async () => true, set, 'tok');
    expect(set).toHaveBeenLastCalledWith('f1', 'watch', 'k', undefined);
    const reload = vi.fn(async () => true);
    const changed = await changeAgentKeyMode('f1', 'enforce', 'k', reload, async () => { throw new WhiteRoomApiError('HTTP 409', 409, 'Something changed since this page loaded. Check readiness again before turning on Enforce.'); }, 'tok');
    expect(changed.note).toEqual({ ok: false, text: 'Something changed since this page loaded. Check readiness again before turning on Enforce.' });
    expect(reload).toHaveBeenCalled();
  });
});
