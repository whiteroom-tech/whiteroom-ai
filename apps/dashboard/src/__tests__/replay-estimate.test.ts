// Replay (gap-closing spec C3): the client calls, the words for an estimate,
// and the Estimate button under "Allow only certain models".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { replayGet, replayStart, WhiteRoomApiError } from '@/lib/whiteroom/client';
import { partialLine, replayLine, type ReplayResult } from '@/lib/replay';
import { ReplayEstimate, runEstimate, startErrorText } from '@/app/(citadel)/controls/_components/ReplayEstimate';

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sent = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
const result = (over: Partial<ReplayResult> = {}): ReplayResult => ({ supported: true, records: 10, evaluated: 9, matched: 3, partial: null, ...over });
const run = (over: Record<string, unknown> = {}) => ({ id: 'rp_1', status: 'done', from: 'a', to: 'b', result: result(), ...over });
const rule = { ruleType: 'model_allowlist', params: { allowedModels: ['claude-haiku-4-5'] }, appliesTo: 'all' };

describe('client calls', () => {
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('replayStart sends the draft rule and the window, and reads the id', async () => {
    fetchMock.mockResolvedValue(reply({ success: true, supported: true, replay_id: 'rp_1' }));
    await expect(replayStart('f1', rule, 7, 'k')).resolves.toBe('rp_1');
    expect(sent()).toEqual({ action: 'replay_start', fleet_id: 'f1', rule_type: 'model_allowlist', params: { allowedModels: ['claude-haiku-4-5'] }, applies_to: 'all', days: 7 });
  });

  it('replayStart gives null for a rule type the engine can’t estimate, and throws on an odd reply', async () => {
    fetchMock.mockResolvedValue(reply({ supported: false, rule_type: 'call_rate' }));
    await expect(replayStart('f1', rule, 7, 'k')).resolves.toBeNull();
    fetchMock.mockResolvedValue(reply({ success: true }));
    await expect(replayStart('f1', rule, 7, 'k')).rejects.toBeInstanceOf(WhiteRoomApiError);
  });

  it('replayGet reads a run and refuses one it can’t read', async () => {
    fetchMock.mockResolvedValue(reply({ replay: run() }));
    await expect(replayGet('f1', 'rp_1', 'k')).resolves.toMatchObject({ status: 'done', result: { matched: 3 } });
    expect(sent()).toEqual({ action: 'replay_get', fleet_id: 'f1', replay_id: 'rp_1' });
    for (const bad of [{ replay: null }, { replay: run({ status: 'odd' }) }, { replay: run({ result: null }) }, { replay: run({ result: { matched: 'x' } }) },
      { replay: run({ from: undefined }) }, { replay: run({ to: 5 }) },
      { replay: run({ result: result({ records: 'x' as never }) }) }, { replay: run({ result: { ...result(), supported: undefined } }) },
      { replay: run({ result: result({ partial: [null as never] }) }) }, { replay: run({ result: result({ partial: [{ calls: 1 } as never] }) }) }]) {
      fetchMock.mockResolvedValue(reply(bad));
      await expect(replayGet('f1', 'rp_1', 'k')).rejects.toBeInstanceOf(WhiteRoomApiError);
    }
  });
});

describe('words', () => {
  it('says the estimate in one line', () => {
    expect(replayLine(result())).toBe('In the last 7 days, 3 of 9 calls used a model not on this list.');
    expect(replayLine(result({ matched: 0, evaluated: 1 }))).toBe('In the last 7 days, all 1 call used a model on this list.');
    expect(replayLine(result({ matched: 0, evaluated: 0 }))).toBe('No calls in the last 7 days to check.');
    expect(replayLine(result({ matched: 1200, evaluated: 4500 }))).toBe('In the last 7 days, 1,200 of 4,500 calls used a model not on this list.');
  });

  it('says why an estimate is partial, and still says Partial for a reason it doesn’t know', () => {
    expect(partialLine(null)).toBeNull();
    expect(partialLine([])).toBeNull();
    expect(partialLine([{ kind: 'dropped', calls: 4 }, { kind: 'not_recorded', gaps: 1, calls: 2 }])).toBe('Partial: 4 calls weren’t stored; 2 calls weren’t recorded.');
    expect(partialLine([{ kind: 'not_recorded', gaps: 1, calls: 0 }, { kind: 'record_limit', limit: 500000 }, { kind: 'time_limit', minutes: 10 }]))
      .toBe('Partial: some calls weren’t recorded; only the first 500,000 calls were checked; it ran out of time.');
    expect(partialLine([{ kind: 'newer' } as never])).toBe('Partial.');
  });

  it('says why a start was refused', () => {
    expect(startErrorText(new WhiteRoomApiError('x', 404))).toBe('Estimates aren’t on for this fleet yet.');
    expect(startErrorText(new WhiteRoomApiError('x', 403))).toBe('Only the fleet owner can run an estimate.');
    expect(startErrorText(new WhiteRoomApiError('x', 409))).toMatch(/already running/);
    expect(startErrorText(new WhiteRoomApiError('x', 400, 'days must be a whole number from 1 to 30.'))).toBe('days must be a whole number from 1 to 30.');
    expect(startErrorText(new Error('net'))).toBe('The estimate couldn’t run. Try again in a minute.');
  });
});

describe('runEstimate', () => {
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const sleep = async () => {};

  it('starts, waits while it runs, and gives the result; a missed read is retried', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ success: true, supported: true, replay_id: 'rp_1' }))
      .mockResolvedValueOnce(reply({ replay: run({ status: 'running', result: null }) }))
      .mockResolvedValueOnce(reply({ error: 'boom' }, 500))
      .mockResolvedValueOnce(reply({ replay: run() }));
    await expect(runEstimate('f1', rule, 'k', { sleep })).resolves.toEqual({ result: result() });
  });

  it('says so when the run failed, the start was refused, the type isn’t supported, or it took too long', async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, supported: true, replay_id: 'rp_1' })).mockResolvedValueOnce(reply({ replay: run({ status: 'failed', result: null }) }));
    await expect(runEstimate('f1', rule, 'k', { sleep })).resolves.toEqual({ error: 'The estimate stopped before it finished. Try again.' });
    fetchMock.mockResolvedValueOnce(reply({ error: 'Replay isn’t on for this fleet yet.' }, 404));
    await expect(runEstimate('f1', rule, 'k', { sleep })).resolves.toEqual({ error: 'Estimates aren’t on for this fleet yet.' });
    fetchMock.mockResolvedValueOnce(reply({ supported: false }));
    await expect(runEstimate('f1', rule, 'k', { sleep })).resolves.toEqual({ error: 'This kind of rule can’t be estimated yet.' });
    let t = 0;
    fetchMock.mockResolvedValueOnce(reply({ success: true, supported: true, replay_id: 'rp_1' })).mockImplementation(async () => reply({ replay: run({ status: 'running', result: null }) }));
    await expect(runEstimate('f1', rule, 'k', { sleep, now: () => (t += 60_000) })).resolves.toEqual({ error: 'The estimate is taking too long. Try again later.' });
  });

  it('stops at once on a reply it can’t read, instead of asking again until it times out', async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, supported: true, replay_id: 'rp_1' })).mockResolvedValue(reply({ replay: run({ result: { matched: 1 } }) }));
    await expect(runEstimate('f1', rule, 'k', { sleep })).resolves.toEqual({ error: 'This page can’t read the estimate. Reload it and try again.' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops at once when the read is refused or the run is gone, and after a few missed reads in a row', async () => {
    const started = () => reply({ success: true, supported: true, replay_id: 'rp_1' });
    for (const [status, error] of [[401, 'You’re no longer signed in to this fleet. Reload the page.'], [403, 'You’re no longer signed in to this fleet. Reload the page.'], [404, 'The estimate is gone. Run it again.']] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(started()).mockImplementation(async () => reply({ error: 'no' }, status));
      await expect(runEstimate('f1', rule, 'k', { sleep })).resolves.toEqual({ error });
    }
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(started()).mockImplementation(async () => reply({ error: 'blip' }, 400));
    await expect(runEstimate('f1', rule, 'k', { sleep })).resolves.toEqual({ error: 'The estimate couldn’t be read. Try again in a minute.' });
    // A blip between good reads doesn't count against it.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(started());
    for (let i = 0; i < 4; i++) fetchMock.mockImplementationOnce(async () => reply({ error: 'blip' }, 400));
    fetchMock.mockImplementationOnce(async () => reply({ replay: run({ status: 'running', result: null }) }));
    for (let i = 0; i < 4; i++) fetchMock.mockImplementationOnce(async () => reply({ error: 'blip' }, 400));
    fetchMock.mockImplementation(async () => reply({ replay: run() }));
    await expect(runEstimate('f1', rule, 'k', { sleep })).resolves.toEqual({ result: result() });
  });

  it('stops quietly once the editor is closed', async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, supported: true, replay_id: 'rp_1' }));
    await expect(runEstimate('f1', rule, 'k', { sleep, cancelled: () => true })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayEstimate', () => {
  it('offers an estimate for Allow only certain models, and nothing for other rules', () => {
    const html = renderToStaticMarkup(h(ReplayEstimate, { fleetId: 'f1', authKey: 'k', ruleType: 'model_allowlist', params: rule.params, appliesTo: 'all', disabledReason: null }));
    expect(html).toContain('Estimate on the last 7 days');
    expect(html).not.toContain('disabled');
    expect(renderToStaticMarkup(h(ReplayEstimate, { fleetId: 'f1', authKey: 'k', ruleType: 'call_rate', params: {}, appliesTo: 'all', disabledReason: null }))).toBe('');
  });

  it('is off, with the reason, until the list has a model', () => {
    const html = renderToStaticMarkup(h(ReplayEstimate, { fleetId: 'f1', authKey: 'k', ruleType: 'model_allowlist', params: { allowedModels: [] }, appliesTo: 'all', disabledReason: 'Add a model first.' }));
    expect(html).toContain('disabled');
    expect(html).toContain('Add a model first.');
  });
});
