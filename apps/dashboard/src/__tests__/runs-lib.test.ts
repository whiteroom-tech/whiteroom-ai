import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectRuns, fmtLength, fmtStarted, parseRunId, runHref, runMeta, runsCount, runsDays, standOut, timelineRow } from '@/lib/runs';

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
    expect(runMeta({ startedAt: '2026-09-30T20:52:00Z', endedAt: '2026-09-30T21:15:00Z', shift: 8 }, Date.parse('2026-09-30T21:00:00Z')))
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
