import { describe, expect, it } from 'vitest';
import { insightsVerdict, quietUnusualLine, untrackedSignals } from '@/lib/performance-insights';
import { flaggedRunCount } from '@/components/performance/UnusualBehaviour';
import { UNUSUAL_SIGNALS } from '@/lib/runs';

const base = { flaggedRuns: 0, problems: 0, problemAgent: null, openRecs: 0 };

describe('performance verdict', () => {
  it('stays hidden until the flags or the health check are known', () => {
    expect(insightsVerdict({ ...base, flaggedRuns: null, problems: null, openRecs: 3 })).toBeNull();
  });
  it('says fine when nothing is flagged and nothing is wrong, even with recommendations to review', () => {
    expect(insightsVerdict({ ...base, openRecs: 2 })).toEqual({ tone: 'ok', title: 'Your agents look fine' });
    expect(insightsVerdict({ ...base, problems: null })).toEqual({ tone: 'ok', title: 'Your agents look fine' });
  });
  it('names the one agent with a problem', () => {
    expect(insightsVerdict({ ...base, problems: 1, problemAgent: 'lead-agent' })).toEqual({ tone: 'warn', title: 'lead-agent needs a look' });
    expect(insightsVerdict({ ...base, problems: 3 })).toEqual({ tone: 'warn', title: 'Some agents need a look' });
  });
  it('counts unusual runs when the health check is clear', () => {
    expect(insightsVerdict({ ...base, flaggedRuns: 1 })!.title).toBe('1 run looked unusual');
    expect(insightsVerdict({ ...base, flaggedRuns: 6, problems: null })!.title).toBe('6 runs looked unusual');
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
    expect(flaggedRunCount({ runs: null, truncated: false, failed: false, days })).toBeNull();
    expect(flaggedRunCount({ runs: [run('2026-10-19T12:00:00'), run('2026-10-20T12:00:00'), run('2026-10-01T12:00:00')], truncated: false, failed: false, days })).toBe(2);
  });
});
