import { describe, expect, it } from 'vitest';
import { pendingHealthRow, rowOpen, toggleChoice, agentSignals, recTitle, healthRow, unusualRow, DEFAULT_REC_STATUS, fmtCount, insightsVerdict, plural, recCountSuffix, recFeedback, recStatusLabel, recEmptyText, recRowActions, untrackedSignals } from '@/lib/performance-insights';
import { flaggedRunCount } from '@/components/performance/UnusualBehaviour';
import { UNUSUAL_SIGNALS } from '@/lib/runs';

const base = { flaggedRuns: 0, flaggedAtLeast: false, flagsPending: false, problems: 0, problemAgent: null };

describe('performance verdict', () => {
  it('stays hidden until the flags or the health check are known', () => {
    expect(insightsVerdict({ ...base, flaggedRuns: null, problems: null })).toBeNull();
  });
  it('says fine when nothing is flagged and nothing is wrong', () => {
    expect(insightsVerdict(base)).toEqual({ tone: 'ok', title: 'Your agents look fine' });
    expect(insightsVerdict({ ...base, problems: null })).toEqual({ tone: 'ok', title: 'Your agents look fine' });
  });
  it('never says fine while the flags are loading or failed to load', () => {
    expect(insightsVerdict({ ...base, flaggedRuns: null, flagsPending: true })).toBeNull();
    expect(insightsVerdict({ ...base, flaggedRuns: null, flagsPending: true, problems: 1, problemAgent: 'lead-agent' })!.tone).toBe('warn');
  });
  it('names the one agent with a problem', () => {
    expect(insightsVerdict({ ...base, problems: 1, problemAgent: 'lead-agent' })).toEqual({ tone: 'warn', title: 'lead-agent needs a look' });
    expect(insightsVerdict({ ...base, problems: 3 })).toEqual({ tone: 'warn', title: 'Some agents need a look' });
  });
  it('counts unusual runs when the health check is clear', () => {
    expect(insightsVerdict({ ...base, flaggedRuns: 1 })!.title).toBe('1 run looked unusual');
    expect(insightsVerdict({ ...base, flaggedRuns: 6, problems: null })!.title).toBe('6 runs looked unusual');
  });
  it('marks a capped count as a lower bound', () => {
    expect(insightsVerdict({ ...base, flaggedRuns: 1000, flaggedAtLeast: true })!.title).toBe('1,000+ runs looked unusual');
    expect(fmtCount(1000, true)).toBe('1,000+');
    expect(fmtCount(7)).toBe('7');
    expect(plural(1, false, 'run', 'runs')).toBe('run');
    expect(plural(1, true, 'run', 'runs')).toBe('runs');
    expect(plural(0, false, 'run', 'runs')).toBe('runs');
  });
});

describe('unusual behaviour quiet state', () => {
  it('lists the signals not tracked yet', () => {
    expect(untrackedSignals()).toEqual(UNUSUAL_SIGNALS.filter((s) => !s.measured).map((s) => s.label));
  });
  it('flagged runs are counted only inside the window, and unknown while loading', () => {
    const days = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
    const run = (startedAt: string) => ({ agentId: 'lead-agent', startedAt, flags: [{ signal: 'repeating_call' }] }) as never;
    expect(flaggedRunCount({ runs: null, truncated: false, failed: false, loading: true, days })).toBeNull();
    // An engine without run flags: unknown, and the verdict leans on the health check alone.
    expect(flaggedRunCount({ runs: null, truncated: false, failed: false, loading: false, days })).toBeNull();
    expect(insightsVerdict({ ...base, flaggedRuns: null })).toEqual({ tone: 'ok', title: 'Your agents look fine' });
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
    expect(unusualRow(f)).toEqual({ tone: 'ok', text: 'Nothing unusual this week' });
    expect(unusualRow({ ...f, count: 1 })).toEqual({ tone: 'warn', text: '1 run flagged this week' });
    expect(unusualRow({ ...f, count: 1000, atLeast: true })!.text).toBe('1,000+ runs flagged this week');
  });
  it('health check before a stored result: short row; the header keeps the full status and its button', () => {
    expect(pendingHealthRow(null)).toBeNull();
    expect(pendingHealthRow({ busy: true, error: false })).toEqual({ tone: 'muted', text: 'Checking\u2026' });
    expect(pendingHealthRow({ busy: false, error: true })).toEqual({ tone: 'warn', text: 'The last check didn\u2019t finish' });
    expect(pendingHealthRow({ busy: false, error: false })).toEqual({ tone: 'muted', text: 'Not checked yet' });
  });
  it('health check: the row is the summary line', () => {
    expect(healthRow(null)).toBeNull();
    expect(healthRow({ tone: 'warn', text: '1 problem · 3 passed', fine: 3, needsData: 0, openFindings: 1 })).toEqual({ tone: 'warn', text: '1 problem · 3 passed' });
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

describe('fold-out rows', () => {
  it('follow their default until someone opens or closes them', () => {
    expect(rowOpen(null, true)).toBe(true);
    expect(rowOpen(null, false)).toBe(false);
  });
  it('keep the person’s choice when new data flips the default', () => {
    // Closed a row that opened for a problem…
    const chosen = toggleChoice(null, true, false);
    expect(chosen).toBe(false);
    // …a refetch still has the problem, or a new one: it stays closed.
    expect(rowOpen(chosen, true)).toBe(false);
    // Opened a quiet row: it stays open when the default stays closed.
    expect(rowOpen(toggleChoice(null, false, true), false)).toBe(true);
  });
  it('ignore the toggle event the default itself causes', () => {
    expect(toggleChoice(null, true, true)).toBeNull();
    expect(toggleChoice(false, false, false)).toBe(false);
  });
});
