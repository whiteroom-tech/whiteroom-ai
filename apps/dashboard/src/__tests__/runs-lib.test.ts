import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, flagText, ignoresFlagged, ignoresRuleActivity, unusualSummary, collectRuns, dayLabel, eventFeedSheets, localDay, runsWindow, stripDays, validDay, TIME_ZONE_NAME, clampSpan, oldestKept, stripEndFor, MAX_SPAN_DAYS, fmtLength, fmtStarted, loadRunPage, parseRunId, runHref, runsTitle, runsExportHeader, runsDays, runsExportRow, standOut, timelineRow, timelineRows, runSummary, ruleActivityRow, ruleActivityFooter, ruleActivityLink, runSheets, collectRunEvents, flagsNote, fmtClockLength, spanLabel, exportDays, runName, type RunPageQuery } from '@/lib/runs';
import { startsNewGroup } from '@whiteroom/ui';
import type { AuditEntry, RunEventsResult, RunFlag, RunSummary } from '@/lib/whiteroom/types';

afterEach(() => { vi.unstubAllEnvs(); });

describe('runs days, in the viewer’s time zone', () => {
  const now = Date.parse('2026-10-01T03:00:00Z'); // still Sep 30 in California
  it('counts the viewer’s own days, not UTC’s', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(localDay(now)).toBe('2026-09-30');
    expect(runsDays('today', now)).toEqual({ fromDay: '2026-09-30', toDay: '2026-09-30' });
    expect(runsDays('7d', now)).toEqual({ fromDay: '2026-09-24', toDay: '2026-09-30' });
    expect(runsDays('30d', now)).toEqual({ fromDay: '2026-09-01', toDay: '2026-09-30' });
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(runsDays('today', now)).toEqual({ fromDay: '2026-10-01', toDay: '2026-10-01' });
  });

  it('steps calendar days across months and DST changes', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // the 25-hour day
    expect(addDays('2026-03-08', -1)).toBe('2026-03-07'); // the 23-hour day
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('shows one picked day, else the range', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(runsWindow({ range: '30d', day: '2026-09-14' }, now)).toEqual({ fromDay: '2026-09-14', toDay: '2026-09-14' });
    expect(runsWindow({ range: 'today', day: null }, now)).toEqual({ fromDay: '2026-09-30', toDay: '2026-09-30' });
  });

  it('labels days, naming today and yesterday', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(dayLabel('2026-09-30', now)).toBe('Today · Wed, Sep 30');
    expect(dayLabel('2026-09-29', now)).toBe('Yesterday · Tue, Sep 29');
    expect(dayLabel('2026-09-14', now)).toBe('Mon, Sep 14');
    expect(dayLabel('2026-09-29', now, false)).toBe('Tue, Sep 29');
  });

  it('fills the strip’s empty days with zero, oldest first, ending today', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const strip = stripDays([{ day: '2026-09-28', runs: 3 }, { day: '2026-08-01', runs: 9 }], 5, '2026-09-30');
    expect(strip).toEqual([
      { day: '2026-09-26', runs: 0 }, { day: '2026-09-27', runs: 0 }, { day: '2026-09-28', runs: 3 },
      { day: '2026-09-29', runs: 0 }, { day: '2026-09-30', runs: 0 },
    ]);
  });
});

describe('run formatting', () => {
  it('formats lengths', () => {
    expect([fmtLength(45), fmtLength(23 * 60), fmtLength(65 * 60), fmtLength(-3)]).toEqual(['45 s', '23 min', '1 h 05 min', '0 s']);
  });
  it('always shows the date with the start time, in the viewer’s zone', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(fmtStarted('2026-09-30T20:52:00Z')).toBe('Sep 30, 1:52 pm');
  });
  it('titles the table as the mockup does, and links by run id', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const now = Date.parse('2026-10-01T03:00:00Z');
    const t = (shown: number, total: number, view: Parameters<typeof runsTitle>[0]['view'], show: 'all' | 'flagged' | 'rules' = 'all', hour: number | null = null) => runsTitle({ shown, total, view, show, hour }, now);
    expect(t(12, 60, { range: '7d', day: null })).toBe('Showing 12 of 60 runs · last 7 days');
    expect(t(6, 6, { range: 'today', day: null })).toBe('6 runs · today');
    expect(t(1, 1, { range: '30d', day: null }, 'flagged')).toBe('1 flagged run · last 30 days');
    expect(t(3, 3, { range: '7d', day: null }, 'rules')).toBe('3 runs with rule activity · last 7 days');
    expect(t(25, 47, { range: '7d', day: '2026-09-29' })).toBe('Tue, Sep 29 · Showing 25 of 47 runs');
    expect(t(2, 2, { range: '7d', day: '2026-09-29' }, 'all', 21)).toBe('9 pm · Tue, Sep 29 · 2 runs');
    expect(spanLabel({ range: 'custom', day: null, from: '2026-09-01', to: '2026-09-20' }, now)).toBe('Sep 1 – Sep 20');
    expect(runHref('lead-agent~8')).toBe('/runs/lead-agent~8');
    expect(runName({ agentId: 'lead-agent', shift: 115 })).toBe('lead-agent #115');
  });
  it('writes a run’s length as a clock', () => {
    expect(fmtClockLength(24)).toBe('0:24');
    expect(fmtClockLength(60)).toBe('1:00');
    expect(fmtClockLength(3729)).toBe('1:02:09');
  });
});

describe('what stood out', () => {
  const run = (x: Partial<{ calls: number; failedCalls: number; blockedCalls: number; checked: number }>) => ({
    calls: x.calls ?? 6, failedCalls: x.failedCalls ?? 0, blockedCalls: x.blockedCalls ?? 0, coverage: { calls: x.calls ?? 6, checked: x.checked ?? x.calls ?? 6 },
  });
  it('leads with a rule block, then would-have-blocked, then failures', () => {
    expect(standOut(run({ blockedCalls: 1, failedCalls: 2 }))).toEqual({ tone: 'blocked', text: 'Blocked 1 call' });
    expect(standOut(run({ failedCalls: 2 }))).toEqual({ tone: 'failed', text: '2 calls failed' });
    // A Record only rule's would-acts are evidence too, and never read as a block.
    expect(standOut({ ...run({}), wouldActCalls: 6 })).toEqual({ tone: 'rule', text: 'Would have blocked 6 calls' });
    expect(standOut({ ...run({}), wouldActCalls: 1 }).text).toBe('Would have blocked 1 call');
    expect(standOut({ ...run({ blockedCalls: 2 }), wouldActCalls: 1 }).text).toBe('Blocked 2 calls · would have blocked 1 more');
    // An engine that doesn't count them (no field) can't be filtered by them.
    expect(ignoresRuleActivity([{}, {}])).toBe(true);
    expect(ignoresRuleActivity([{ wouldActCalls: 0 }])).toBe(false);
    expect(ignoresRuleActivity([])).toBe(false);
  });
  it('never reports a clean result for calls that weren’t read', () => {
    expect(standOut(run({ checked: 4 })).text).toBe('Partly checked: 4 of 6 calls could be read');
    expect(standOut(run({ checked: 0 })).text).toBe('Not assessed: none of its calls could be read');
    expect(standOut(run({}))).toEqual({ tone: 'clean', text: 'Nothing unusual' });
  });
});

describe('run detail rows', () => {
  it('describes a call by model and tools, tagging a non-complete outcome', () => {
    const row = timelineRow({ id: 'call:1', kind: 'call', at: '2026-10-01T14:00:00Z', type: 'upstream_error', model: 'claude-haiku-4-5', requestedTools: ['search', 'read_file'] });
    expect(row.text).toBe('Model call · claude-haiku-4-5 · asked for search, read_file');
    expect(row.tag).toEqual({ label: 'Failed', tone: 'warn' });
    expect(timelineRow({ id: 'call:2', kind: 'call', at: '2026-10-01T14:00:00Z', type: 'complete' }).tag).toBeUndefined();
    // A rule event's ×N can include the run before's repeats; Rule actions has this run's exact count.
    const rule = timelineRow({ id: 'ev:1', kind: 'event', at: '2026-10-01T14:00:00Z', type: 'governance_would_block', detail: { ruleType: 'spend_cap', reason: 'budget_exceeded', occurrences: 10, agentId: 'lead-agent' } } as Parameters<typeof timelineRow>[0]);
    expect(rule.text).toBe('lead-agent would have been blocked by the spend cap (budget exceeded) (Record only)');
    expect(timelineRow({ id: 'call:3', kind: 'call', at: '2026-10-01T14:00:00Z', type: 'complete', requestedTools: ['persist_lead', 'persist_lead', 'persist_lead', 'notify'] }).text)
      .toBe('Model call · asked for persist_lead ×3, notify');
  });

  it('names only the tools the reply asked for, never the ones offered (M18)', () => {
    const offered = ['search_places', 'fetch_page', 'persist_lead', 'get_lead_list'];
    const base = { id: 'call:4', kind: 'call' as const, at: '2026-10-01T14:00:00Z', type: 'complete' };
    expect(timelineRow({ ...base, availableTools: offered, requestedTools: ['get_lead_list'] }).text).toBe('Model call · asked for get_lead_list');
    expect(timelineRow({ ...base, availableTools: offered, requestedTools: null }).text).toBe('Model call'); // streamed: unknown
    expect(timelineRow({ ...base, tools: offered }).text).toBe('Model call'); // older engine: offered only
  });
  it('marks rows ▶ started, ◇ call, ✓ finished, ✕ blocked or failed', () => {
    const at = '2026-10-01T14:00:00Z';
    expect(timelineRow({ id: 'e0', kind: 'event', at, type: 'watch_start', detail: { agentId: 'a' } })).toMatchObject({ glyph: 'start', text: 'Run started' });
    expect(timelineRow({ id: 'c0', kind: 'call', at, type: 'complete' }).glyph).toBe('call');
    expect(timelineRow({ id: 'c1', kind: 'call', at, type: 'upstream_error' }).glyph).toBe('bad');
    expect(timelineRow({ id: 'e1', kind: 'event', at, type: 'watch_end', detail: { agentId: 'a' } }).glyph).toBe('done');
    // A finished task is part of the run, not its end.
    expect(timelineRow({ id: 'e3', kind: 'event', at, type: 'task_complete', detail: { agentId: 'a' } }).glyph).toBe('event');
    // A Record only rule's would-block, or a stop that isn't a rule's, is no ✕.
    expect(timelineRow({ id: 'e4', kind: 'event', at, type: 'governance_would_block', detail: { agentId: 'a', ruleType: 'spend_cap' } }).glyph).toBe('event');
    expect(timelineRow({ id: 'e5', kind: 'event', at, type: 'agent_stopped', detail: { agentId: 'a' } }).glyph).toBe('event');
    expect(timelineRow({ id: 'e2', kind: 'event', at, type: 'governance_block', detail: { agentId: 'a', ruleType: 'spend_cap' } }).glyph).toBe('bad');
  });
  it('shows the model only when it changes, and quiets a repeated time', () => {
    const at = '2026-10-01T14:00:00Z';
    const rows = timelineRows([
      { id: 'c1', kind: 'call', at, type: 'complete', model: 'm1' },
      { id: 'c2', kind: 'call', at, type: 'complete', model: 'm1' },
      { id: 'c3', kind: 'call', at: '2026-10-01T14:05:00Z', type: 'complete', model: 'm2' },
    ], 'm1');
    expect(rows.map((r) => r.text)).toEqual(['Model call', 'Model call', 'Model call · m2']);
    expect(rows.map((r) => r.sameTime)).toEqual([false, true, false]);
    // Without the run's models (older engines), the first call names its model.
    expect(timelineRows([{ id: 'c1', kind: 'call', at, type: 'complete', model: 'm1' }])[0].text).toBe('Model call · m1');
  });
  it('shades a call a rule acted on, with what it did and the mode', () => {
    const row = timelineRow({ id: 'c1', kind: 'call', at: '2026-10-01T14:00:00Z', type: 'complete', ruleActions: [{ ruleId: 'r', ruleType: 'model_allowlist', mode: 'watch', response: 'block', outcome: 'would_block', reason: 'model_not_allowed' }] });
    expect(row.rule).toEqual({ text: 'would have been blocked: model not on the allowlist', mode: 'watch' });
    const blocked = timelineRow({ id: 'c2', kind: 'call', at: '2026-10-01T14:00:00Z', type: 'governance_blocked', ruleActions: [{ ruleId: 'r', ruleType: 'spend_cap', mode: 'enforce', response: 'block', outcome: 'blocked', reason: 'budget_exceeded' }] });
    expect(blocked.rule).toEqual({ text: 'blocked: over the spend cap', mode: 'enforce' });
    expect(blocked.tag).toBeUndefined();
  });
  it('writes the summary line, from the run or else from the runs list', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const head = { runId: 'a~4', agentId: 'a', shift: 4, startedAt: '2026-10-25T00:45:00Z', endedAt: '2026-10-25T00:45:24Z' };
    expect(runSummary({ ...head, calls: 6, spendMicros: 50_000, failedCalls: 0, blockedCalls: 0, wouldBlockCalls: 6, models: ['claude-sonnet-4-5'] }))
      .toEqual({ started: 'Oct 24, 8:45 pm EDT', length: '24 s', calls: 6, spend: '$0.05', failed: 0, blocked: 0, wouldBlock: 6, models: ['claude-sonnet-4-5'] });
    const old = runSummary(head, { calls: 6, failedCalls: 1, blockedCalls: 0, spendMicros: 50_000, unpricedAttempts: 1, wouldActCalls: 2 });
    expect(old).toMatchObject({ calls: 6, failed: 1, spend: '$0.05+', wouldBlock: 2, models: [] });
    expect(runSummary(head)).toMatchObject({ calls: undefined, spend: undefined });
  });
  it('never says nothing was blocked when a rule blocked', () => {
    const act = (x: Partial<Parameters<typeof flagsNote>[0] extends (infer A)[] | undefined ? A : never>) => ({ at: '2026-10-27T09:04:00Z', ruleId: 'r1', ruleType: 'model_allowlist' as const, response: 'block' as const, mode: 'enforce' as const, occurrences: 1, ...x });
    expect(flagsNote([act({})])).toBe('Flags only point things out. Blocks are listed under Rule activity.');
    expect(flagsNote([act({ response: 'notify' })])).toBe('Flags only point things out. What rules did is listed under Rule activity.');
    expect(flagsNote([act({ mode: 'watch' })])).toBe('Flags only point things out; they don’t block anything.');
    expect(flagsNote(undefined)).toBe('Flags only point things out; they don’t block anything.');
  });
  it('words Rule activity rows, footer and header link', () => {
    const a = { at: '2026-10-25T00:45:00Z', ruleId: 'gr_1', ruleType: 'model_allowlist' as const, response: 'block' as const, mode: 'watch' as const, occurrences: 5, reason: 'model_not_allowed' };
    expect(ruleActivityRow(a)).toEqual({ lead: 'Model allowlist would have blocked', count: 5, tail: 'calls: model not on the allowlist' });
    expect(ruleActivityRow({ ...a, occurrences: 1, reason: undefined })).toEqual({ lead: 'Model allowlist would have blocked', count: 1, tail: 'call' });
    expect(ruleActivityRow({ ...a, ruleType: 'spend_cap', response: 'pause', mode: 'enforce', occurrences: 1, reason: null }).lead).toBe('Spend cap paused the agent');
    expect(ruleActivityFooter([a])).toBe('These rules are Record only, so the calls went through.');
    expect(ruleActivityFooter([a, { ...a, mode: 'enforce' }])).toBe('Record only rules let their calls through; rules set to Block acted.');
    expect(ruleActivityLink([a, a])).toEqual({ href: '/controls?rule=gr_1', text: 'Open Model allowlist in Controls' });
    expect(ruleActivityLink([a, { ...a, ruleId: 'gr_2' }]).href).toBe('/controls');
  });
  it('collects a run’s events page by page, and stops at the cap', async () => {
    const get = vi.fn(async (cursor: string | null) => ({ fleetId: 'f', run: { runId: 'a~1', agentId: 'a', shift: 1, startedAt: '', endedAt: '' }, events: [{ id: `e${cursor ?? 0}`, kind: 'event' as const, at: '', type: 'x' }], page: Number(cursor ?? 0), pages: 3, total: 3, eventFound: null }));
    const all = await collectRunEvents(get);
    expect(all.events.map((e) => e.id)).toEqual(['e0', 'e1', 'e2']);
    expect(all.truncated).toBe(false);
    expect(get.mock.calls.map((c) => c[0])).toEqual([null, '1', '2']);
    const capped = await collectRunEvents(get, 2);
    expect(capped.events).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });
  it('never says blocked for a rule outcome it doesn’t know, and marks only real finish events', () => {
    const odd = timelineRow({ id: 'c', kind: 'call', at: '2026-10-01T14:00:00Z', type: 'complete', ruleActions: [{ ruleId: 'r', ruleType: 'keyword', mode: 'enforce', response: 'redact', outcome: 'redacted' as never, reason: 'keyword_found' }] });
    expect(odd.rule?.text).toBe('a rule acted: a keyword was found');
    expect(timelineRow({ id: 'e', kind: 'event', at: '2026-10-01T14:00:00Z', type: 'subtask_complete', detail: { agentId: 'a' } }).glyph).toBe('event');
  });
  it('exports a run as its summary and every row', () => {
    const head = { runId: 'a~4', agentId: 'a', shift: 4, startedAt: '2026-10-25T00:45:00Z', endedAt: '2026-10-25T00:45:24Z', calls: 1, models: ['m1'] };
    const [summary, events] = runSheets(head, [{ id: 'c1', kind: 'call', at: '2026-10-25T00:45:01Z', type: 'complete', model: 'm1' }]);
    expect(summary.rows).toContainEqual(['Run', 'a #4']);
    expect(summary.rows).toContainEqual(['Models', 'm1']);
    // Spend is a number that sums, with unpriced calls on their own row.
    const priced = runSheets({ ...head, spendMicros: 52_000, unpricedAttempts: 1 }, [])[0].rows;
    expect(priced).toContainEqual(['Spend (USD)', 0.052]);
    expect(priced).toContainEqual(['Unpriced calls', 1]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0][2]).toBe('Model call · m1');
  });
});

describe('run ids', () => {
  it('parses agent and shift, and refuses malformed ids instead of guessing', () => {
    expect(parseRunId('lead-agent~8')).toEqual({ agentId: 'lead-agent', shift: 8 });
    expect(parseRunId('team.a:w~12')).toEqual({ agentId: 'team.a:w', shift: 12 });
    for (const bad of ['foo', '~8', 'foo~', 'foo~x']) expect(parseRunId(bad)).toBeNull();
  });
});

describe('export paging', () => {
  const run = (id: string) => ({ runId: id }) as Parameters<typeof standOut>[0] & { runId: string };
  it('collects every page until the cursor runs out', async () => {
    const pages = [{ runs: [run('a'), run('b')], cursor: '2' }, { runs: [run('c')], cursor: null }];
    let i = 0;
    const got = await collectRuns(async () => pages[i++] as never, 10);
    expect(got).toEqual({ runs: [run('a'), run('b'), run('c')], truncated: false });
  });
  it('stops at the page cap and says it was truncated', async () => {
    const got = await collectRuns(async (c) => ({ runs: [run(String(c))], cursor: 'more' }) as never, 3);
    expect('truncated' in got && got.truncated).toBe(true);
    expect('runs' in got && got.runs).toHaveLength(3);
  });
  it('reports an engine without list_runs, and lets errors through', async () => {
    expect(await collectRuns(async () => ({ unsupported: true }), 3)).toEqual({ unsupported: true });
    await expect(collectRuns(async () => { throw new Error('HTTP 500'); }, 3)).rejects.toThrow('HTTP 500');
  });
});

describe('loadRunPage', () => {
  const page = (p: Partial<RunEventsResult>): RunEventsResult => ({
    fleetId: 'f', run: { runId: 'a~1', agentId: 'a', shift: 1, startedAt: '', endedAt: '' },
    events: [], page: 0, pages: 1, total: 0, eventFound: null, ...p,
  });

  it('loads the current page when there is no deep link', async () => {
    const get = vi.fn(async (_q: RunPageQuery) => page({ page: 2 }));
    const got = await loadRunPage(get, { target: null, kind: 'events', cursor: '2' });
    expect(get).toHaveBeenCalledWith({ cursor: '2', kind: 'events' });
    expect(got).toMatchObject({ kind: 'events', cursor: '2', highlight: null });
  });

  it('keeps the page the server picked for a deep link, so polls stay on it', async () => {
    const get = vi.fn(async (_q: RunPageQuery) => page({ page: 3, pages: 5, eventFound: true }));
    const got = await loadRunPage(get, { target: 'e9', kind: 'all', cursor: null });
    expect(get).toHaveBeenCalledWith({ eventId: 'e9', kind: 'all' });
    expect(got).toMatchObject({ kind: 'all', cursor: '3', highlight: 'e9' });
  });

  it('switches to Everything when the linked event is a call', async () => {
    const get = vi.fn(async (q: RunPageQuery) => (q.kind === 'events' ? page({ eventFound: false }) : page({ page: 1, pages: 2, eventFound: true })));
    const got = await loadRunPage(get, { target: 'c4', kind: 'events', cursor: null });
    expect(get).toHaveBeenCalledTimes(2);
    expect(got).toMatchObject({ kind: 'all', cursor: '1', highlight: 'c4' });
  });

  it('shows the first page without a highlight when the event is gone', async () => {
    const got = await loadRunPage(async () => page({ eventFound: false }), { target: 'x', kind: 'all', cursor: null });
    expect(got).toMatchObject({ kind: 'all', cursor: null, highlight: null });
  });
});

describe('exports', () => {
  it('marks spend as a lower bound with an unpriced calls column', () => {
    const r: RunSummary = {
      runId: 'a~2', agentId: 'a', shift: 2, startedAt: '2026-09-30T20:00:00Z', endedAt: '2026-09-30T20:10:00Z', lengthSeconds: 600,
      calls: 4, failedCalls: 0, blockedCalls: 0, spendMicros: 1_234_567, unpricedAttempts: 2, coverage: { calls: 4, checked: 4 },
    };
    vi.stubEnv('TZ', 'America/New_York');
    const header = runsExportHeader();
    const row = runsExportRow(r, 'https://app.example');
    expect(row).toHaveLength(header.length);
    expect(row[header.indexOf('Spend (USD)')]).toBe(1.234567);
    expect(row[header.indexOf('Unpriced calls')]).toBe(2);
    // A run name and a link replace the raw id; the start is in the viewer's zone, named in the header.
    expect(row[header.indexOf('Run')]).toBe('a #2');
    expect(row[header.indexOf('Started (America/New_York)')]).toBe('2026-09-30 16:00');
    expect(row[header.indexOf('Link')]).toBe('https://app.example/runs/a~2');
    expect(row[header.indexOf('What stood out')]).toBe('');
    expect(header).not.toContain('Started (UTC)');
  });

  it('writes every event, and finished tasks alone on a second sheet', () => {
    const entries = [
      { timestamp: '2026-09-30T20:00:00Z', agentId: 'a', type: 'task_complete', taskName: 'triage', watchNumber: 3, tokensUsed: 10, details: [{ name: 'lookup', args: 'id=1' }, { name: 'save' }] },
      { timestamp: '2026-09-30T20:01:00Z', agentId: 'a', type: 'handover', taskName: 'ignored' },
    ] as unknown as AuditEntry[];
    const [all, tasks] = eventFeedSheets(entries);
    expect(all.rows).toHaveLength(2);
    expect(tasks.rows).toHaveLength(1);
    const t = tasks.rows[0];
    expect(t.slice(1, 6)).toEqual(['a', 3, 'task_complete', 'triage', 10]);
    expect(t[8]).toBe('lookup(id=1)  |  save');
    expect(all.rows[1][4]).toBe('');
    expect(all.rows[1][2]).toBeUndefined();
  });
});

describe('picked day (?day=)', () => {
  const now = Date.parse('2026-10-01T03:00:00Z');
  it('accepts real past or current days only', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(validDay('2026-09-14', now)).toBe('2026-09-14');
    expect(validDay('2026-09-30', now)).toBe('2026-09-30'); // today in LA
    expect(validDay('2026-10-01', now)).toBeNull(); // tomorrow in LA
    for (const bad of ['2026-02-30', '2026-13-01', '2026-9-14', 'yesterday', '', null]) expect(validDay(bad, now)).toBeNull();
  });
});

describe('time zone names the engine accepts', () => {
  it('takes IANA names, single-word ones included, and refuses offsets', () => {
    for (const tz of ['UTC', 'GMT', 'America/New_York', 'America/Argentina/Salta', 'Etc/GMT+5']) expect(TIME_ZONE_NAME.test(tz)).toBe(true);
    for (const tz of ['+05:30', '-0400', 'EST5EDT', "UTC'--"]) expect(TIME_ZONE_NAME.test(tz)).toBe(false);
  });
});

describe('day groups in the table', () => {
  const key = (r: { d: string }) => ({ key: r.d });
  it('starts a group at the first row and at each change of day only', () => {
    const rows = [{ d: 'a' }, { d: 'a' }, { d: 'b' }, { d: 'b' }, { d: 'a' }];
    expect(rows.map((_, i) => startsNewGroup(rows, i, key))).toEqual([true, false, true, false, true]);
  });
});

describe('older records: custom ranges, plan history, strip paging', () => {
  const now = Date.parse('2026-10-01T15:00:00Z');
  const today = '2026-10-01';

  it('shows a custom from–to, or the last 30 days until both ends are set', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(runsWindow({ range: 'custom', day: null, from: '2026-06-01', to: '2026-06-30' }, now)).toEqual({ fromDay: '2026-06-01', toDay: '2026-06-30' });
    expect(runsWindow({ range: 'custom', day: null }, now)).toEqual({ fromDay: '2026-09-02', toDay: '2026-10-01' });
    expect(runsWindow({ range: 'custom', day: '2026-06-03', from: '2026-06-01', to: '2026-06-30' }, now)).toEqual({ fromDay: '2026-06-03', toDay: '2026-06-03' });
    expect(spanLabel({ range: 'custom', day: null, from: '2026-06-01', to: '2026-06-30' }, now)).toBe('Jun 1 – Jun 30');
    expect(exportDays('yesterday', now)).toEqual({ fromDay: '2026-09-30', toDay: '2026-09-30' });
    expect(exportDays('7d', now)).toEqual({ fromDay: '2026-09-25', toDay: '2026-10-01' });
  });

  it('keeps a custom range to what the engine takes', () => {
    expect(clampSpan('2026-06-30', '2026-06-01', { today })).toEqual({ from: '2026-06-01', to: '2026-06-30' }); // reversed
    expect(clampSpan('2026-09-20', '2026-10-09', { today })).toEqual({ from: '2026-09-20', to: today }); // no future
    expect(clampSpan('2025-01-01', '2026-09-01', { today, oldest: '2026-07-01' }).from).toBe('2026-07-01'); // plan history
    // Over 92 days: the end just moved wins.
    expect(clampSpan('2026-01-01', '2026-09-30', { today, moved: 'from' })).toEqual({ from: '2026-01-01', to: '2026-04-02' });
    expect(clampSpan('2026-01-01', '2026-09-30', { today, moved: 'to' })).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    const { from, to } = clampSpan('2025-01-01', today, { today });
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1).toBe(MAX_SPAN_DAYS);
  });

  it('knows the first day the plan keeps', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(oldestKept(30, now)).toBe('2026-09-02');
    expect(oldestKept(undefined, now)).toBeNull();
  });

  it('moves the strip only when the shown days are off it', () => {
    expect(stripEndFor({ fromDay: '2026-09-28', toDay: '2026-09-28' }, today, 30)).toBe(today); // on the strip: stays
    expect(stripEndFor({ fromDay: '2026-06-03', toDay: '2026-06-03' }, today, 30)).toBe('2026-06-03'); // older: jumps
    expect(stripEndFor({ fromDay: '2026-09-25', toDay: today }, '2026-06-03', 30)).toBe(today); // back to the range
  });
});

describe('what stood out: run flags', () => {
  const base = { calls: 10, failedCalls: 0, blockedCalls: 0, coverage: { calls: 10, checked: 10 } };
  it('puts a flag first, in words, and counts the rest', () => {
    expect(flagText({ signal: 'repeating_call', tool: 'fetch_page', calls: 6 })).toBe('Repeating the same call: fetch_page ×6');
    expect(flagText({ signal: 'error_streak', calls: 4 })).toBe('4 failed calls in a row');
    expect(standOut({ ...base, blockedCalls: 1, flags: [{ signal: 'error_streak', calls: 3 }] })).toEqual({ tone: 'flag', text: '3 failed calls in a row' });
    expect(standOut({ ...base, flags: [{ signal: 'repeating_call', tool: 'x', calls: 5 }, { signal: 'error_streak', calls: 3 }] }).text).toBe('Repeating the same call: x ×5 · 1 more flag');
  });
  it('falls back to rule blocks, failures and coverage without flags (or on older engines)', () => {
    expect(standOut({ ...base, flags: [] }).tone).toBe('clean');
    expect(standOut({ ...base, blockedCalls: 2 }).text).toBe('Blocked 2 calls');
  });
});

describe('older engines and the Flagged filter', () => {
  it('spots an engine that ignored `flagged` (no flags field at all)', () => {
    expect(ignoresFlagged([{}, {}])).toBe(true);
    expect(ignoresFlagged([{ flags: [] }])).toBe(false);
    expect(ignoresFlagged([])).toBe(false);
  });
});

describe('unusual behaviour (P2.5)', () => {
  it('counts runs per signal and flagged runs per agent per day, busiest first', () => {
    vi.stubEnv('TZ', 'UTC');
    const days = ['2026-09-29', '2026-09-30', '2026-10-01'];
    const run = (agentId: string, day: string, signals: string[]) => ({ agentId, startedAt: `${day}T12:00:00Z`, flags: signals.map((signal) => (signal === 'error_streak' ? { signal, calls: 3 } : { signal, tool: 't', calls: 5 })) as RunFlag[] });
    const s = unusualSummary([
      run('a', '2026-09-30', ['repeating_call', 'error_streak']), run('a', '2026-10-01', ['error_streak']),
      run('b', '2026-09-29', ['repeating_call']), run('c', '2026-10-01', []), run('d', '2026-08-01', ['repeating_call']),
    ], days);
    // The run from August is outside the shown days, so it counts nowhere.
    expect(s.byAgent).toEqual([{ agentId: 'a', perDay: [0, 1, 1], total: 2 }, { agentId: 'b', perDay: [1, 0, 0], total: 1 }]);
  });
});

describe('energy saved', () => {
  it('shows Wh under 1 kWh, kWh above, nothing when nothing was saved', async () => {
    const { fmtEnergy } = await import('@/lib/format');
    expect(fmtEnergy(0)).toBeNull();
    expect(fmtEnergy(1_225_000)).toBe('≈490 Wh');
    expect(fmtEnergy(10_000_000)).toBe('≈4.0 kWh');
    expect(fmtEnergy(10)).toBe('≈1 Wh');
  });
});

describe('runs by hour', () => {
  it('labels hours plainly, and spots an ignored hour filter', async () => {
    const { hourLabel, ignoresHour } = await import('@/lib/runs');
    const at = (h: number, m = 0) => { const d = new Date('2026-10-20T00:00:00'); d.setHours(h, m); return d.toISOString(); };
    expect([0, 9, 12, 23].map(hourLabel)).toEqual(['12 am', '9 am', '12 pm', '11 pm']);
    expect(ignoresHour([{ startedAt: at(9) }], 9)).toBe(false);
    expect(ignoresHour([{ startedAt: at(9) }, { startedAt: at(10) }], 9)).toBe(true);
  });
});
