import { describe, expect, it } from 'vitest';
import { DEFAULT_REC_STATUS, fmtCount, insightsVerdict, latestOnly, listGivesOpenCount, quietUnusualLine, recEmptyText, recRowActions, untrackedSignals } from '@/lib/performance-insights';
import { flaggedRunCount } from '@/components/performance/UnusualBehaviour';
import { UNUSUAL_SIGNALS } from '@/lib/runs';

const base = { flaggedRuns: 0, flaggedAtLeast: false, flagsPending: false, problems: 0, problemAgent: null, openRecs: 0 };

describe('performance verdict', () => {
  it('stays hidden until the flags or the health check are known', () => {
    expect(insightsVerdict({ ...base, flaggedRuns: null, problems: null, openRecs: 3 })).toBeNull();
  });
  it('says fine when nothing is flagged and nothing is wrong, even with recommendations to review', () => {
    expect(insightsVerdict({ ...base, openRecs: 2 })).toEqual({ tone: 'ok', title: 'Your agents look fine' });
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
  });
});

describe('unusual behaviour quiet state', () => {
  it('counts the patterns watched and the ones still to come', () => {
    const measured = UNUSUAL_SIGNALS.filter((s) => s.measured).length;
    expect(quietUnusualLine()).toBe(`watching ${measured} patterns, ${UNUSUAL_SIGNALS.length - measured} more coming`);
    expect(untrackedSignals()).toEqual(UNUSUAL_SIGNALS.filter((s) => !s.measured).map((s) => s.label));
  });
  it('flagged runs are counted only inside the window, and unknown while loading', () => {
    const days = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
    const run = (startedAt: string) => ({ agentId: 'lead-agent', startedAt, flags: [{ signal: 'repeating_call' }] }) as never;
    expect(flaggedRunCount({ runs: null, truncated: false, failed: false, loading: true, days })).toBeNull();
    expect(flaggedRunCount({ runs: [run('2026-10-19T12:00:00'), run('2026-10-20T12:00:00'), run('2026-10-01T12:00:00')], truncated: false, failed: false, loading: false, days })).toBe(2);
  });
});

describe('recommendations list', () => {
  it('opens on Open', () => {
    expect(DEFAULT_REC_STATUS).toBe('open');
  });
  it('takes the open count from the list only on its first, unfiltered Open page', () => {
    expect(listGivesOpenCount('open', '')).toBe(true);
    expect(listGivesOpenCount('open', '  ')).toBe(true);
    expect(listGivesOpenCount('open', 'lead')).toBe(false);
    expect(listGivesOpenCount('open', '', 'cursor-2')).toBe(false);
    expect(listGivesOpenCount('all', '')).toBe(false);
  });
  it('ignores an older response that lands after a newer request', () => {
    const gate = latestOnly();
    const first = gate.start();
    const second = gate.start();
    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);
  });
  it('says what an empty list means for each status', () => {
    expect(recEmptyText('open', true)).toBe('Nothing to review right now.');
    expect(recEmptyText('all', false)).toBe('No recommendations. Collection coverage: no data.');
    expect(recEmptyText('reported_implemented', true)).toBe('No recommendations with status "implemented". Collection coverage: active.');
  });
  it('keeps Mark as fixed, Snooze and Dismiss behind More on open rows', () => {
    expect(recRowActions(true, false)).toEqual(['View evidence', 'More']);
    expect(recRowActions(true, true)).toEqual(['View evidence', 'Less', 'Mark as fixed', 'Snooze', 'Dismiss']);
    expect(recRowActions(false, true)).toEqual(['View evidence']);
  });
});
