import { describe, expect, it } from 'vitest';
import {
  activityRow, afterFanOut, agentState, fanOutDue, FANOUT_START, onRefreshSignal, clock, hasUnknownAgents, mergeFanOut, hoursSinceUtcMidnight, kindOf, lastEventByAgent, latestActivity, decodeEntities, liveExpandable, liveRow, readableArgs, matchesFilter,
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
    expect(file.calls).toEqual([{ label: 'Read', tool: 'read file', text: 'path: /data/policies/meridian.md', failed: false }]);
    expect(liveRow({ ...base, details: [{ name: 'web_fetch', args: '{"url":"https://a.example","depth":2}' }] }).calls[0])
      .toMatchObject({ label: 'Opened', text: 'url: https://a.example  ·  depth: 2' });
    const tool = liveRow({ ...base, details: [{ name: 'persist_lead', args: '{"name":"Acme"}' }, { name: 'x', args: '' }] });
    expect(tool.kind).toBe('tool');
    expect(tool.summary).toBe('persist lead: Acme · +1 more');
  });

  it('says what happened without repeating the tool name', () => {
    expect(liveRow({ ...base, details: [{ name: 'web_fetch', args: '{"url":"https://a.example/x"}' }] }).summary).toBe('Opened https://a.example/x');
    expect(liveRow({ ...base, details: [{ name: 'read_file', args: '{"path":"/data/m.md"}' }] }).summary).toBe('Read /data/m.md');
    expect(liveRow({ ...base, details: [{ name: 'search_files', args: '{"query":"hartwell"}' }] }).summary).toBe('Searched hartwell');
  });

  it('sums up the calls, not the earlier results listed before them, and keeps every result', () => {
    const r = liveRow({ ...base, tokensUsed: 1200, details: [
      { name: 'tool_result', args: 'Our Programs Family Folklore' },
      { name: 'tool_result', args: 'https://x.org/a  ·  [Blocked by robots.txt: https://x.org/a]' },
      { name: 'tool_result', args: '[Fetch error: nodename nor servname provided]' },
      { name: 'fetch_page', args: 'url: https://www.example.org/' },
      { name: 'fetch_page', args: 'url: https://www.example.org/about' },
    ] });
    expect(r.kind).toBe('web');
    expect(r.summary).toBe('Opened https://www.example.org/ · +1 more');
    expect(r.calls.map((c) => c.text)).toEqual(['url: https://www.example.org/', 'url: https://www.example.org/about']);
    expect(r.results.map((x) => x.failed)).toEqual([false, true, true]);
    expect(r.tokens).toBe(1200);
    expect(liveExpandable(r)).toBe(true);
  });

  it('reads arguments and unknown token counts safely', () => {
    expect(readableArgs('{}')).toBe('');
    expect(readableArgs('{not json')).toBe('{not json');
    expect(readableArgs('["a","b"]')).toBe('["a","b"]');
    expect(readableArgs('url: https://a.example')).toBe('url: https://a.example');
    expect(liveRow({ ...base, tokensUsed: null } as unknown as AuditEntry).tokens).toBeNull();
    expect(liveRow({ ...base, tokensUsed: '' } as unknown as AuditEntry).tokens).toBeNull();
    expect(liveRow({ ...base, details: [{ name: 'tool_result', args: 'Error: timed out' }] }).results[0].failed).toBe(true);
  });

  it('shows HTML-escaped page text as characters', () => {
    expect(decodeEntities('Bakery &amp; Cake &#8220;Sudamengue&#8221; &#x27;x&#x27; &lt;b&gt; &bogus; &#0;')).toBe('Bakery & Cake “Sudamengue” \'x\' <b> &bogus; &#0;');
    expect(liveRow({ ...base, details: [{ name: 'tool_result', args: 'Tuesday &amp; Thursday' }] }).results[0].text).toBe('Tuesday & Thursday');
    expect(liveRow({ ...base, details: [{ name: 'fetch_page', args: 'url: https://x.com/?a=1&amp;b=2' }] }).calls[0].text).toBe('url: https://x.com/?a=1&amp;b=2');
  });

  it('expands a long reply but not a short one or a bare model call', () => {
    expect(liveExpandable(liveRow({ ...base, taskName: 'reply: ok' }))).toBe(false);
    const long = liveRow({ ...base, taskName: `reply: ${'word '.repeat(40)}` });
    expect(long.reply.length).toBeGreaterThan(120);
    expect(liveExpandable(long)).toBe(true);
    expect(liveExpandable(liveRow({ ...base, taskName: 'think' }))).toBe(false);
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

describe('merging a fan-out', () => {
  const statuses = new Map([['lead-agent', 'working'], ['scout-agent', 'resting'], ['new-agent', 'idle']]);
  const previous: AgentInfo[] = [{ agentId: 'scout-agent', status: 'working', watchNumber: 3, tasksCompleted: 17 }];

  it('keeps the last good detail for a failed lookup, under the fresh status', () => {
    const { details, complete } = mergeFanOut(statuses, [{ agentId: 'x', status: 'working', watchNumber: 8 }, null, null], previous);
    expect(complete).toBe(false);
    expect(details[0]).toMatchObject({ agentId: 'lead-agent', watchNumber: 8 });
    expect(details[1]).toMatchObject({ agentId: 'scout-agent', status: 'resting', watchNumber: 3, tasksCompleted: 17 });
    expect(details[2]).toEqual({ agentId: 'new-agent', status: 'idle' });
  });

  it('is complete only when every lookup worked', () => {
    expect(mergeFanOut(statuses, [{ agentId: 'a', status: 'working' }, { agentId: 'b', status: 'resting' }, { agentId: 'c', status: 'idle' }], []).complete).toBe(true);
  });
});

describe('fan-out throttle', () => {
  it('runs at once, then waits a minute after a complete fan-out', () => {
    expect(fanOutDue(FANOUT_START, 1_000, false)).toBe(true);
    const c = afterFanOut(FANOUT_START, 1_000, true);
    expect(c).toEqual({ nextAt: 61_000, failures: 0 });
    expect(fanOutDue(c, 60_999, false)).toBe(false);
    expect(fanOutDue(c, 61_000, false)).toBe(true);
  });

  it('fetches a new agent at once after a complete fan-out', () => {
    expect(fanOutDue(afterFanOut(FANOUT_START, 0, true), 5_000, true)).toBe(true);
  });

  it('backs off when one lookup keeps failing, so polls every 10s do not all fan out', () => {
    let c = FANOUT_START;
    let now = 0;
    let runs = 0;
    // Ten minutes of 10s polls with one agent that always fails, including a
    // never-seen agent (failed lookups leave it unknown).
    for (; now < 600_000; now += 10_000) {
      if (fanOutDue(c, now, true)) { runs += 1; c = afterFanOut(c, now, false); }
    }
    expect(runs).toBeLessThanOrEqual(13); // 0,10,30,70 then once a minute
    expect(c.failures).toBe(runs);
  });

  it('steps the retry 10s, 20s, 40s, then a minute, and resets on success', () => {
    const gaps: number[] = [];
    let c = FANOUT_START;
    for (let i = 0; i < 5; i++) { const next = afterFanOut(c, 0, false); gaps.push(next.nextAt); c = next; }
    expect(gaps).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(afterFanOut(c, 0, true)).toEqual({ nextAt: 60_000, failures: 0 });
  });
});

describe('activity order', () => {
  it('puts events with unreadable timestamps last instead of scrambling the rest', () => {
    const e = (id: string, timestamp: string): AuditEntry => ({ id, type: 'task_complete', timestamp, agentId: id });
    const rows = latestActivity([e('a', '2026-10-01T10:00:00Z'), e('bad', 'not a date'), e('c', '2026-10-01T12:00:00Z'), e('b', '2026-10-01T11:00:00Z')], 4);
    expect(rows.map((r) => r.text.split(' ')[0])).toEqual(['c', 'b', 'a', 'bad']);
  });
});

describe('live feed refresh', () => {
  it('reloads on a new signal only while open', () => {
    expect(onRefreshSignal(true, 2, 1)).toEqual({ load: true, handled: 2 });
    expect(onRefreshSignal(false, 2, 1)).toEqual({ load: false, handled: 2 });
    expect(onRefreshSignal(true, 1, 1)).toEqual({ load: false, handled: 1 });
  });

  it('marks a Refresh made while hidden as handled, so reveal is the only load', () => {
    const hidden = onRefreshSignal(false, 1, 0);
    expect(onRefreshSignal(true, 1, hidden.handled).load).toBe(false);
  });
});

describe('live rows for handovers', () => {
  it('fill the agent from fromAgent when agentId is missing', () => {
    expect(liveRow({ id: 'h', type: 'task_complete', timestamp: '2026-09-30T14:00:00Z', fromAgent: 'lead-agent', taskName: 'reply: done' } as AuditEntry).agent).toBe('lead-agent');
  });
});
