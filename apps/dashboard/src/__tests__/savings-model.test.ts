import { describe, expect, it } from 'vitest';
import { cacheFigures, savingsDollars } from '../lib/analytics-metrics';
import { burnCaption, remainingTasksNote } from '../lib/cost-tracking';

const bucket = (agent: string, b: Partial<{ tasks: number; handovers: number; handoverSaved: number; offloadSaved: number }>) =>
  ({ day: '2026-10-04', agent, used: 0, tasks: 0, handovers: 0, handoverSaved: 0, offloadSaved: 0, ...b });

describe('savings dollars (audit M07)', () => {
  it("uses the engine's per-agent priced figure when it sends one", () => {
    expect(savingsDollars([bucket('a', { handovers: 1, handoverSaved: 1_000 })], { tokens: 1_000, usdMicros: 190, unpricedTokens: 0, basis: 'cache_aware_input' }))
      .toEqual({ tokensSaved: 1_000, costSaved: 0.00019, partial: false });
  });

  it('marks dollars partial when some saved tokens had no price', () => {
    expect(savingsDollars([], { tokens: 10, usdMicros: 5, unpricedTokens: 4, basis: 'cache_aware_input' }).partial).toBe(true);
  });

  it("falls back to per-agent-day tokens at the input rate: one agent's tasks never amplify another's handovers", () => {
    // a: 2 tasks, one handover saving 1,000. b: 100 tasks, no handover. 1,000, not 51,000.
    const r = savingsDollars([bucket('a', { tasks: 2, handovers: 1, handoverSaved: 1_000 }), bucket('b', { tasks: 100 })]);
    expect(r).toEqual({ tokensSaved: 1_000, costSaved: 0.001, partial: false });
  });
});

describe('cache figures (audit M08)', () => {
  it('takes per-model savings net of the write premium, and a denominator counting each token once', () => {
    const c = cacheFigures({ freshInputTokens: 1_000, readTokens: 9_000, writeTokens: 0, readSavedMicros: 8_100, writePremiumMicros: 100, unpricedReadTokens: 0 }, []);
    expect(c).toMatchObject({ savedMicros: 8_000, hitRate: 0.9 });
  });

  it('never shows negative savings when writes cost more than reads saved', () => {
    expect(cacheFigures({ freshInputTokens: 0, readTokens: 0, writeTokens: 1_000, readSavedMicros: 0, writePremiumMicros: 250, unpricedReadTokens: 0 }, []).savedMicros).toBe(0);
  });

  it('with an older engine, shows tokens only, never a price inferred from total spend', () => {
    const c = cacheFigures(undefined, [{ inputTokens: 1_000, cacheReadTokens: 3_000, cacheWriteTokens: 0 }]);
    expect(c).toMatchObject({ savedMicros: 0, readTokens: 3_000, hitRate: 0.75 });
  });
});

describe('cost tracking captions (audit M10, M11)', () => {
  it('names the burn rate lookback', () => {
    expect(burnCaption({ burnLookbackHours: 336 })).toBe('per working hour, last 14 days');
    expect(burnCaption({})).toBe('spending per hour');
  });

  it('does not ask for a saved budget again when the task-cost data is what is missing', () => {
    expect(remainingTasksNote({ costUnavailable: false, remainingTasksReason: 'task_type_missing' })).toMatch(/task type/);
    expect(remainingTasksNote({ costUnavailable: false, remainingTasksReason: 'budget_missing' })).toBe('set a daily budget to see tasks left');
    expect(remainingTasksNote({ costUnavailable: true })).toBe('set a daily token budget to see tasks left');
  });
});
