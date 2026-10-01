import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, collectRuns, dayLabel, eventFeedSheets, localDay, runsWindow, stripDays, validDay, TIME_ZONE_NAME, clampSpan, oldestKept, stripEndFor, MAX_SPAN_DAYS, fmtLength, fmtStarted, loadRunPage, parseRunId, runHref, runMeta, RUNS_EXPORT_HEADER, runsCount, runsDays, runsExportRow, standOut, timelineRow, type RunPageQuery } from '@/lib/runs';
import { startsNewGroup } from '@whiteroom/ui';
import type { AuditEntry, RunEventsResult, RunSummary } from '@/lib/whiteroom/types';

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
  it('counts in the range’s words and links by run id', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const now = Date.parse('2026-10-01T03:00:00Z');
    expect(runsCount(6, { range: '7d', day: null }, now)).toBe('6 in the last 7 days');
    expect(runsCount(2, { range: 'today', day: null }, now)).toBe('2 today');
    expect(runsCount(8, { range: '7d', day: '2026-09-29' }, now)).toBe('8 on Tue, Sep 29');
    expect(runsCount(1, { range: '7d', day: '2026-09-30' }, now)).toBe('1 today');
    expect(runHref('lead-agent~8')).toBe('/runs/lead-agent~8');
  });
});

describe('what stood out', () => {
  const run = (x: Partial<{ calls: number; failedCalls: number; blockedCalls: number; checked: number }>) => ({
    calls: x.calls ?? 6, failedCalls: x.failedCalls ?? 0, blockedCalls: x.blockedCalls ?? 0, coverage: { calls: x.calls ?? 6, checked: x.checked ?? x.calls ?? 6 },
  });
  it('leads with a rule block, then failures', () => {
    expect(standOut(run({ blockedCalls: 1, failedCalls: 2 }))).toEqual({ tone: 'rule', text: 'A rule blocked 1 call' });
    expect(standOut(run({ failedCalls: 2 }))).toEqual({ tone: 'failed', text: '2 calls failed' });
  });
  it('never reports a clean result for calls that weren’t read', () => {
    expect(standOut(run({ checked: 4 })).text).toBe('Partly checked: 4 of 6 calls could be read');
    expect(standOut(run({ checked: 0 })).text).toBe('Not assessed: none of its calls could be read');
    expect(standOut(run({}))).toEqual({ tone: 'clean', text: 'Nothing unusual' });
  });
});

describe('run detail rows', () => {
  it('describes a call by model and tools, tagging a non-complete outcome', () => {
    const row = timelineRow({ id: 'call:1', kind: 'call', at: '2026-10-01T14:00:00Z', type: 'upstream_error', model: 'claude-haiku-4-5', tools: ['search', 'read_file'] });
    expect(row.text).toBe('Model call · claude-haiku-4-5 · used search, read_file');
    expect(row.tag).toEqual({ label: 'Failed', tone: 'warn' });
    expect(timelineRow({ id: 'call:2', kind: 'call', at: '2026-10-01T14:00:00Z', type: 'complete' }).tag).toBeUndefined();
    expect(timelineRow({ id: 'call:3', kind: 'call', at: '2026-10-01T14:00:00Z', type: 'complete', tools: ['persist_lead', 'persist_lead', 'persist_lead', 'notify'] }).text)
      .toBe('Model call · used persist_lead ×3, notify');
  });
  it('reads an event with the activity feed’s words and a kind icon', () => {
    const row = timelineRow({ id: 'e1', kind: 'event', at: '2026-10-01T14:00:00Z', type: 'self_handover', detail: { agentId: 'lead-agent' } });
    expect(row.text).toContain('lead-agent');
    expect(row.icon).toBe('swap');
    expect(timelineRow({ id: 'e2', kind: 'event', at: '2026-10-01T14:00:00Z', type: 'governance_block', detail: { agentId: 'a', ruleType: 'spend_cap' } }).icon).toBe('lock');
  });
  it('writes the meta line with the shift', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(runMeta({ startedAt: '2026-09-30T20:52:00Z', endedAt: '2026-09-30T21:15:00Z', shift: 8 }))
      .toBe('Sep 30 · started 1:52 pm PDT · 23 min · shift 8');
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
    const row = runsExportRow(r);
    expect(row).toHaveLength(RUNS_EXPORT_HEADER.length);
    expect(row[RUNS_EXPORT_HEADER.indexOf('Spend (USD)')]).toBe(1.234567);
    expect(row[RUNS_EXPORT_HEADER.indexOf('Unpriced calls')]).toBe(2);
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
    expect(runsCount(5, { range: 'custom', day: null, from: '2026-06-01', to: '2026-06-30' }, now)).toBe('5 from Mon, Jun 1 to Tue, Jun 30');
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
