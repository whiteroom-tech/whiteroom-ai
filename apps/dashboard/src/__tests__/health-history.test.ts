// Health history (Agent Health item 9): the report's sheets, who acted, the
// days read, and reading every page.
import { describe, expect, it, vi } from 'vitest';
import { checkName, healthReportSheets, historyDays, readAllHistory, whoActed } from '@/lib/health-history';
import type { HealthHistoryEvent } from '@/lib/whiteroom/client';
import type { FleetDiagnosis } from '@/lib/whiteroom/types';

const ev = (p: Partial<HealthHistoryEvent>): HealthHistoryEvent => ({ agentId: 'a', detector: 'review_tool_loops', event: 'opened', actor: null, at: '2026-11-04T10:00:00Z', ...p });
const actions = [{ action: 'x', agentId: null, ruleId: null, userId: 'u1', by: 'R Haque', at: '2026-11-04T10:00:00Z' }];

describe('health history', () => {
  it('names who acted: a person, a teammate when unknown, or WhiteRoom', () => {
    expect(whoActed('user:u1', actions)).toBe('R Haque');
    expect(whoActed('user:u2', actions)).toBe('a teammate');
    expect(whoActed(null, actions)).toBe('WhiteRoom');
    // Only a person is ever "a teammate".
    expect(whoActed('api', actions)).toBe('WhiteRoom');
  });

  it('names checks, including ones this dashboard doesn’t know yet', () => {
    expect(checkName('review_bad_endings')).toBe('Runs ending badly');
    expect(checkName('review_something_new')).toBe('something new');
  });

  it('reads the UTC days, today included', () => {
    expect(historyDays(90, Date.parse('2026-11-11T12:00:00Z'))).toEqual({ fromDay: '2026-08-14', toDay: '2026-11-11' });
  });

  it('reads every page, stops at the limit, and is null on an engine without it', async () => {
    const pages = [{ events: [ev({})], cursor: 'c1' }, { events: [ev({ event: 'resolved' })], cursor: null }];
    const read = vi.fn(async (cursor: string | null) => pages[cursor ? 1 : 0]);
    expect(await readAllHistory(read)).toEqual({ events: [ev({}), ev({ event: 'resolved' })], truncated: false });
    expect(read).toHaveBeenLastCalledWith('c1');
    expect(await readAllHistory(async () => ({ events: [ev({})], cursor: 'more' }), 3)).toMatchObject({ truncated: true });
    expect(await readAllHistory(async () => null)).toBeNull();
    // A later page that can't be read leaves the rest out: truncated, not complete.
    let n = 0;
    expect(await readAllHistory(async () => (n++ === 0 ? { events: [ev({})], cursor: 'c1' } : null))).toEqual({ events: [ev({})], truncated: true });
  });

  it('the report: each check today, then the history', () => {
    const diagnosis = { reports: [{ agentId: 'a', findings: [{ detector: 'review_tool_loops', status: 'open' }], clear: [{ detector: 'review_bad_endings', note: null }], notMeasured: [{ detector: 'review_model_change', code: 'x', reason: 'x' }] }] } as unknown as FleetDiagnosis;
    const [today, history] = healthReportSheets(diagnosis, [ev({ event: 'snoozed', actor: 'user:u1' }), ev({ agentId: '=HYPERLINK("x")' })], actions, (iso) => iso.slice(0, 10));
    expect(today.rows).toEqual([['a', 'Repeating the same call', 'Problem'], ['a', 'Runs ending badly', 'Passed'], ['a', 'Model changed', 'Needs more data']]);
    const statuses = (status: string) => healthReportSheets({ reports: [{ agentId: 'a', findings: [{ detector: 'review_tool_loops', status }], clear: [], notMeasured: [] }] } as unknown as FleetDiagnosis, [], [], (x) => x)[0].rows[0][2];
    expect(['snoozed', 'dismissed', 'reported_implemented', 'resolved', 'some_new_state'].map(statuses)).toEqual(['Snoozed', 'Dismissed', 'Marked fixed', 'Stopped happening', 'some new state']);
    expect(history.header).toEqual(['When', 'Agent', 'Check', 'What happened', 'By']);
    expect(history.rows[0]).toEqual(['2026-11-04', 'a', 'Repeating the same call', 'Snoozed', 'R Haque']);
    // An agent id that looks like a formula stays text: the workbook writes text cells as text.
    expect(history.rows[1][1]).toBe('=HYPERLINK("x")');
  });
});
