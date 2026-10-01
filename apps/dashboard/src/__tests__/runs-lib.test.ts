import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectRuns, eventFeedSheets, fmtLength, fmtStarted, loadRunPage, parseRunId, runHref, runMeta, RUNS_EXPORT_HEADER, runsCount, runsDays, runsExportRow, standOut, timelineRow, type RunPageQuery } from '@/lib/runs';
import type { AuditEntry, RunEventsResult, RunSummary } from '@/lib/whiteroom/types';

afterEach(() => { vi.unstubAllEnvs(); });

describe('runs range', () => {
  const now = Date.parse('2026-10-01T03:00:00Z'); // still Sep 30 in California
  it('counts whole UTC days, like Model calls today', () => {
    expect(runsDays('today', now)).toEqual({ fromDay: '2026-10-01', toDay: '2026-10-01' });
    expect(runsDays('7d', now)).toEqual({ fromDay: '2026-09-25', toDay: '2026-10-01' });
    expect(runsDays('30d', now)).toEqual({ fromDay: '2026-09-02', toDay: '2026-10-01' });
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
    expect(runsCount(6, '7d')).toBe('6 in the last 7 days');
    expect(runsCount(2, 'today')).toBe('2 today');
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
