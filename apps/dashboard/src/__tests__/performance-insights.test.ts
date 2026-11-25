import { describe, expect, it } from 'vitest';
import { showRecAgentFilter, pendingHealthRow, agentSignals, recTitle, unusualRow, DEFAULT_REC_STATUS, recCountSuffix, recFeedback, recStatusLabel, recEmptyText, recRowActions, untrackedSignals } from '@/lib/performance-insights';
import { ControlDeniedError, WhiteRoomApiError, feedbackErrorText } from '@/lib/whiteroom/client';
import { flaggedRunCount } from '@/components/performance/UnusualBehaviour';
import { UNUSUAL_SIGNALS } from '@/lib/runs';


describe('unusual behaviour quiet state', () => {
  it('lists the signals not tracked yet', () => {
    expect(untrackedSignals()).toEqual(UNUSUAL_SIGNALS.filter((s) => !s.measured).map((s) => s.label));
    // Ended badly is measured now, so it isn't listed as not tracked.
    expect(untrackedSignals()).not.toContain('Ended on a failed or blocked call');
    expect(untrackedSignals()).toEqual(['A tool it hasn’t used before', 'A burst of tokens']);
  });
  it('names the ended-badly signal in an agent’s summary', () => {
    const days = ['2026-10-21'];
    const runs = [{ agentId: 'a', startedAt: '2026-10-21T12:00:00', flags: [{ signal: 'ended_badly', how: 'failed' }] }] as never;
    expect(agentSignals(runs, days)).toEqual({ a: 'ended on a failed or blocked call' });
  });
  it('flagged runs are counted only inside the window, and unknown while loading', () => {
    const days = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
    const run = (startedAt: string) => ({ agentId: 'lead-agent', startedAt, flags: [{ signal: 'repeating_call' }] }) as never;
    expect(flaggedRunCount({ runs: null, truncated: false, failed: false, loading: true, days })).toBeNull();
    // An engine without run flags: unknown, so the table shows no flag columns.
    expect(flaggedRunCount({ runs: null, truncated: false, failed: false, loading: false, days })).toBeNull();
    expect(flaggedRunCount({ runs: [], truncated: false, failed: false, loading: false, days })).toBe(0);
    expect(flaggedRunCount({ runs: [run('2026-10-19T12:00:00'), run('2026-10-20T12:00:00'), run('2026-10-01T12:00:00')], truncated: false, failed: false, loading: false, days })).toBe(2);
  });
});

describe('recommendations list', () => {
  it('opens on Open', () => {
    expect(DEFAULT_REC_STATUS).toBe('open');
  });
  it('says what an empty list means for each status', () => {
    expect(recEmptyText('open', true)).toBe('Nothing to review right now.');
    expect(recEmptyText('open', true, true)).toBe('No open recommendations for this agent.');
    expect(recEmptyText('open', false)).toBe('No open recommendations. Collection coverage: no data.');
    expect(recEmptyText('all', false)).toBe('No recommendations. Collection coverage: no data.');
    expect(recEmptyText('reported_implemented', true)).toBe('No recommendations with status "implemented". Collection coverage: active.');
  });
  it('keeps Mark as fixed, Snooze and Dismiss behind More on open rows', () => {
    expect(recRowActions(true, false)).toEqual(['evidence', 'toggle']);
    expect(recRowActions(true, true)).toEqual(['evidence', 'toggle', 'fixed', 'snooze', 'dismiss']);
    expect(recRowActions(true, true, false)).toEqual(['evidence']);
    expect(recRowActions(false, true)).toEqual(['evidence']);
  });
  it('sends implemented for Mark as fixed, and a reason with Dismiss', () => {
    expect(recFeedback('fixed')).toEqual({ action: 'implemented' });
    expect(recFeedback('snooze')).toEqual({ action: 'snooze' });
    expect(recFeedback('dismiss')).toEqual({ action: 'dismiss', reason: 'not_worth_it' });
  });
  it('titles older recommendations from their detector', () => {
    expect(recTitle('review_cache_behavior')).toBe('Cache behavior');
    expect(recTitle('compression_cost')).toBe('Compression cost');
    expect(recTitle('')).toBe('Recommendation');
  });
  it('labels statuses the same in the heading, the filters and the empty line', () => {
    expect(recStatusLabel('reported_implemented')).toBe('implemented');
    expect(recStatusLabel('snoozed')).toBe('snoozed');
    expect(recCountSuffix('open')).toBe(' open');
    expect(recCountSuffix('reported_implemented')).toBe(' implemented');
    expect(recCountSuffix('all')).toBe('');
  });
});

describe('agent health rows', () => {
  const f = { count: 0, atLeast: false, failed: false, loading: false };
  it('unusual behaviour: loading, failed, hidden without flags, quiet, flagged', () => {
    expect(unusualRow({ ...f, count: null, loading: true })).toEqual({ tone: 'muted', text: 'Loading\u2026' });
    expect(unusualRow({ ...f, count: null, failed: true })!.tone).toBe('muted');
    expect(unusualRow({ ...f, count: null })).toBeNull();
    expect(unusualRow(f)).toEqual({ tone: 'ok', text: 'Nothing unusual in the last 7 days' });
    expect(unusualRow({ ...f, count: 1 })).toEqual({ tone: 'warn', text: '1 run flagged in the last 7 days' });
    expect(unusualRow({ ...f, count: 1000, atLeast: true })!.text).toBe('1,000+ runs flagged in the last 7 days');
  });
  it('health check before a stored result: short row; the header keeps the full status and its button', () => {
    expect(pendingHealthRow(null)).toBeNull();
    expect(pendingHealthRow({ busy: true, error: false })).toEqual({ tone: 'muted', text: 'Checking\u2026' });
    expect(pendingHealthRow({ busy: false, error: true })).toEqual({ tone: 'warn', text: 'The last check didn\u2019t finish' });
    expect(pendingHealthRow({ busy: false, error: false })).toEqual({ tone: 'muted', text: 'Not checked yet' });
  });
  it('unusual behaviour: what kind each agent’s flagged runs were, most frequent first', () => {
    const days = ['2026-10-20', '2026-10-21'];
    const run = (agentId: string, startedAt: string, signals: string[]) => ({ agentId, startedAt, flags: signals.map((signal) => ({ signal })) }) as never;
    expect(agentSignals([
      run('lead-agent', '2026-10-20T12:00:00', ['repeating_call']),
      run('lead-agent', '2026-10-21T12:00:00', ['repeating_call', 'error_streak']),
      run('scout-agent', '2026-10-21T12:00:00', ['error_streak']),
      run('old-agent', '2026-09-01T12:00:00', ['error_streak']),
    ], days)).toEqual({ 'lead-agent': 'repeating the same call, failed calls in a row', 'scout-agent': 'failed calls in a row' });
  });
});

describe('recommendations agent filter', () => {
  it('shows when the rows come from more than one agent, even if only one had traffic in the range', () => {
    expect(showRecAgentFilter([{ agentId: 'a' }, { agentId: 'b' }], ['a'], '', 5)).toBe(true);
  });
  it('hides with one agent everywhere; shows with traffic from several, unknown traffic, or a typed filter', () => {
    expect(showRecAgentFilter([{ agentId: 'a' }], ['a'], '', 5)).toBe(false);
    expect(showRecAgentFilter([], ['a', 'b'], '', 5)).toBe(true);
    expect(showRecAgentFilter([], null, '', 5)).toBe(true);
    expect(showRecAgentFilter([{ agentId: 'a' }], ['a'], 'x', 0)).toBe(true);
  });
  it('hides below 5 listed, whatever the agents: they all fit at a glance', () => {
    expect(showRecAgentFilter([{ agentId: 'a' }, { agentId: 'b' }], ['a', 'b'], '', 4)).toBe(false);
  });
});

describe('feedback refusals', () => {
  it('a teammate refused snooze or dismiss is told why; anything else asks to try again', () => {
    expect(feedbackErrorText(new ControlDeniedError('Only the fleet’s owner can change this.'))).toBe('Only the fleet’s owner can change this.');
    expect(feedbackErrorText(new WhiteRoomApiError('HTTP 500', 500))).toBe('Failed to submit feedback. Try again.');
    expect(feedbackErrorText(new Error('network'))).toBe('Failed to submit feedback. Try again.');
  });
});
