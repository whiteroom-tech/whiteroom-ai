import { describe, expect, it } from 'vitest';
import {
  activityRow, agentState, clock, hasUnknownAgents, hoursSinceUtcMidnight, kindOf, lastEventByAgent, latestActivity, liveRow, matchesFilter,
  overlayStatuses, pageWindow, parseUsd, progressLine, sortAgents, stateSummary, todayTotals, usd,
} from '@/lib/home';
import type { AgentInfo, AuditEntry, FleetHourlyDataPoint } from '@/lib/whiteroom/types';

const agent = (id: string, status: string, x: Partial<AgentInfo> = {}): AgentInfo => ({ agentId: id, status, ...x });

describe('agents', () => {
  it('maps engine statuses onto the pill states', () => {
    expect(agentState(agent('a', 'working', { minutesRemaining: 5 }))).toBe('working');
    expect(agentState(agent('a', 'working', { minutesRemaining: 0 }))).toBe('idle');
    expect(agentState(agent('a', 'handover_out'))).toBe('handover');
    expect(agentState({ ...agent('a', 'working'), stale: true })).toBe('stale');
    expect(agentState({ ...agent('a', 'working'), disconnected: true })).toBe('disconnected');
    expect(agentState(agent('a', 'something-new'))).toBe('idle');
  });

  it('writes the progress line in shifts, never "watch"', () => {
    expect(progressLine(agent('a', 'working', { watchNumber: 8, tasksCompleted: 62, minutesWorked: 9.44, minutesRemaining: 3 }))).toBe('Shift 8 · 62 tasks · 9.4 min worked');
    expect(progressLine(agent('a', 'resting', { watchNumber: 5, tasksCompleted: 1 }))).toBe('Rest after shift 5 · 1 task');
    expect(progressLine(agent('a', 'idle', { tasksCompleted: 0 }))).toBe('Shift 1 · 0 tasks · waiting for work');
  });

  it('sorts problems first, then working, resting, idle, then by id', () => {
    const order = sortAgents([
      agent('z-idle', 'idle'),
      agent('b-rest', 'resting'),
      agent('a-work', 'working', { minutesRemaining: 4 }),
      { ...agent('c-stale', 'working'), stale: true },
      agent('a-rest', 'resting'),
    ]).map((a) => a.agentId);
    expect(order).toEqual(['c-stale', 'a-work', 'a-rest', 'b-rest', 'z-idle']);
  });

  it('summarises the non-working states for the strip', () => {
    expect(stateSummary([agent('a', 'resting'), agent('b', 'idle'), agent('c', 'resting'), agent('d', 'working', { minutesRemaining: 1 })])).toBe('2 resting · 1 idle');
    expect(stateSummary([agent('d', 'working', { minutesRemaining: 1 })])).toBe('');
  });
});

describe('activity', () => {
  const now = Date.parse('2026-09-30T14:16:00Z');
  const e = (type: string, ts: string, x: Partial<AuditEntry> = {}): AuditEntry => ({ id: `${type}-${ts}`, type, timestamp: ts, agentId: 'lead-agent', ...x });

  it('keeps agent ids exactly as stored', () => {
    expect(activityRow(e('watch_start', '2026-09-30T14:00:00Z'), now).text).toBe('lead-agent started a shift');
  });

  it('tags handovers, pauses and blocks', () => {
    expect(activityRow(e('self_handover', '2026-09-30T14:00:00Z'), now).tag).toEqual({ label: 'Handover', tone: 'ho' });
    expect(activityRow(e('agent_paused', '2026-09-30T14:00:00Z'), now).tag).toEqual({ label: 'Paused', tone: 'warn' });
    expect(activityRow(e('governance_block', '2026-09-30T14:00:00Z', { ruleType: 'spend_cap' }), now).tag?.label).toBe('Blocked');
    expect(activityRow(e('task_complete', '2026-09-30T14:00:00Z', { taskName: 'x' }), now).tag).toBeUndefined();
  });

  it('names Controls for rule changes', () => {
    expect(activityRow(e('governance_rule_changed', '2026-09-30T14:00:00Z', { agentId: undefined, message: 'Spend cap: Off → Watch' }), now).text).toBe('Controls: Spend cap: Off → Watch');
  });

  it('shows the newest four, newest first', () => {
    const rows = latestActivity([1, 5, 3, 4, 2].map((m) => e('watch_start', `2026-09-30T14:0${m}:00Z`)), 4, now);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.key)).toEqual(['watch_start-2026-09-30T14:05:00Z', 'watch_start-2026-09-30T14:04:00Z', 'watch_start-2026-09-30T14:03:00Z', 'watch_start-2026-09-30T14:02:00Z']);
  });

  it('keeps the latest event per agent', () => {
    const last = lastEventByAgent([e('watch_start', '2026-09-30T14:01:00Z'), e('rest_start', '2026-09-30T14:09:00Z'), e('watch_end', '2026-09-30T14:05:00Z')]);
    expect(last['lead-agent'].text).toBe('went on break');
  });
});

describe('live feed rows', () => {
  const base = { id: 'x', type: 'task_complete', timestamp: '2026-09-30T14:16:00Z', agentId: 'lead-agent' } as AuditEntry;

  it('reads replies from the engine\'s "reply:" task name', () => {
    const r = liveRow({ ...base, taskName: 'reply: Here is the Q3 claims summary.' });
    expect(r.kind).toBe('reply');
    expect(r.summary).toBe('“Here is the Q3 claims summary.”');
  });

  it('classifies web, file and other tool calls, with the raw call underneath', () => {
    expect(liveRow({ ...base, details: [{ name: 'web_fetch', args: '{"url":"https://content.naic.org/model-laws"}' }] }).kind).toBe('web');
    const file = liveRow({ ...base, details: [{ name: 'read_file', args: '{"path":"/data/policies/meridian.md"}' }] });
    expect(file.kind).toBe('file');
    expect(file.detail).toBe('read_file({"path":"/data/policies/meridian.md"})');
    const tool = liveRow({ ...base, details: [{ name: 'persist_lead', args: '{"name":"Acme"}' }, { name: 'x', args: '' }] });
    expect(tool.kind).toBe('tool');
    expect(tool.summary).toBe('persist lead: Acme · +1 more');
  });

  it('says what happened without repeating the tool name', () => {
    expect(liveRow({ ...base, details: [{ name: 'web_fetch', args: '{"url":"https://a.example/x"}' }] }).summary).toBe('Opened https://a.example/x');
    expect(liveRow({ ...base, details: [{ name: 'read_file', args: '{"path":"/data/m.md"}' }] }).summary).toBe('Read /data/m.md');
    expect(liveRow({ ...base, details: [{ name: 'search_files', args: '{"query":"hartwell"}' }] }).summary).toBe('Searched hartwell');
  });

  it('filters by kind; Tools covers files', () => {
    const file = liveRow({ ...base, details: [{ name: 'read_file', args: '' }] });
    expect(matchesFilter(file, 'tools')).toBe(true);
    expect(matchesFilter(file, 'web')).toBe(false);
    expect(matchesFilter(file, 'all')).toBe(true);
  });
});

describe('today (UTC)', () => {
  const now = Date.parse('2026-09-30T14:20:00Z');

  it('asks for enough hours to reach 00:00 UTC', () => {
    expect(hoursSinceUtcMidnight(now)).toBe(15);
    expect(hoursSinceUtcMidnight(Date.parse('2026-09-30T00:05:00Z'))).toBe(1);
  });

  it('adds up only today\'s hours', () => {
    const h = (hour: string, calls: number, costMicros: number) => ({ hour, calls, costMicros } as FleetHourlyDataPoint);
    expect(todayTotals([h('2026-09-29T23:00:00.000Z', 50, 9_000_000), h('2026-09-30T00:00:00.000Z', 10, 1_500_000), h('2026-09-30T13:00:00.000Z', 5, 870_000)], now))
      .toEqual({ calls: 15, costUsd: 2.37 });
  });
});

describe('formatting', () => {
  it('formats epoch ms and ISO strings the same way', () => {
    const iso = '2026-09-30T14:16:00Z';
    expect(clock(Date.parse(iso))).toBe(clock(iso));
    expect(clock('not a date')).toBe('');
  });
  it('shows cents, a floor for tiny amounts, and zero', () => {
    expect(usd(2.371)).toBe('$2.37');
    expect(usd(0.004)).toBe('<$0.01');
    expect(usd(0)).toBe('$0.00');
    expect(usd(1234.5)).toBe('$1,234.50');
  });
  it('reads the engine\'s savings string, null when nothing was saved', () => {
    expect(parseUsd('$1.7805')).toBeCloseTo(1.7805);
    expect(parseUsd('$0.0000')).toBeNull();
    expect(parseUsd(undefined)).toBeNull();
  });
});

describe('agent details between fan-outs', () => {
  const report = { status: { working: ['lead-agent', 'new-agent'], resting: ['scout-agent'], idle: [], handover_out: [] } };
  const cached: AgentInfo[] = [
    { agentId: 'lead-agent', status: 'resting', watchNumber: 8, tasksCompleted: 62 },
    { agentId: 'scout-agent', status: 'working', watchNumber: 3 },
    { agentId: 'gone-agent', status: 'working' },
  ];

  it('shows every agent in the report with its fresh status, keeping cached detail', () => {
    const out = overlayStatuses(report, cached);
    expect(out.map((a) => [a.agentId, a.status])).toEqual([['lead-agent', 'working'], ['new-agent', 'working'], ['scout-agent', 'resting']]);
    expect(out[0].watchNumber).toBe(8);
  });

  it('never comes back empty when the cache is empty', () => {
    expect(overlayStatuses(report, []).map((a) => a.agentId)).toEqual(['lead-agent', 'new-agent', 'scout-agent']);
  });

  it('notices agents the cache doesn\'t cover', () => {
    expect(hasUnknownAgents(report, cached)).toBe(true);
    expect(hasUnknownAgents(report, [...cached, { agentId: 'new-agent', status: 'working' }])).toBe(false);
  });
});

describe('tool kinds', () => {
  it('matches whole words, not fragments', () => {
    expect(kindOf('web_fetch')).toBe('web');
    expect(kindOf('fetch_page')).toBe('web');
    expect(kindOf('read_web_page')).toBe('web');
    expect(kindOf('read_file')).toBe('file');
    expect(kindOf('searchFiles')).toBe('file');
    for (const name of ['save_lead', 'open_ticket', 'spreadsheet_lookup', 'pagerduty_alert', 'update_page', 'persist_lead']) {
      expect(kindOf(name)).toBe('tool');
    }
  });
});

describe('paging', () => {
  const rows = Array.from({ length: 45 }, (_, i) => i);

  it('pages in fixed sizes', () => {
    expect(pageWindow(rows, 1, 20)).toMatchObject({ page: 1, from: 21, to: 40 });
    expect(pageWindow(rows, 2, 20)).toMatchObject({ page: 2, from: 41, to: 45 });
  });

  it('clamps a page that no longer exists after the data shrinks', () => {
    expect(pageWindow(rows.slice(0, 30), 2, 20)).toMatchObject({ page: 1, from: 21, to: 30 });
    expect(pageWindow([], 3, 20)).toMatchObject({ page: 0, from: 0, to: 0, rows: [] });
  });
});

describe('handover subjects', () => {
  it('names the agent from fromAgent / toAgent when agentId is missing', () => {
    const e = { id: 'h', type: 'handover_out', timestamp: '2026-09-30T14:00:00Z', fromAgent: 'lead-agent', toAgent: 'writer-agent' } as AuditEntry;
    expect(activityRow(e).text.startsWith('lead-agent ')).toBe(true);
    expect(lastEventByAgent([e])['lead-agent']).toBeDefined();
  });
});
