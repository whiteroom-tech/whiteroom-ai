// Sandbox first-run steps (first-run UX spec §6.1): which step is current.
import { describe, expect, it } from 'vitest';
import { SANDBOX_STEPS, sandboxStepOf } from '@/lib/sandbox/steps';
import type { CheckState } from '@/lib/sandbox/checks';

const checks = (endedAt: string | null, open = true): CheckState => ({
  window: open ? { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', endedAt, stage: endedAt ? 'done' : 'observe', injectErrors: true, calls: 4 } : null,
  checks: [], rules: [],
});

describe('sandboxStepOf', () => {
  it('Connect until there is a key, and while connecting a different one', () => {
    expect(sandboxStepOf({ connected: false, replacing: false, checks: null })).toBe('connect');
    expect(sandboxStepOf({ connected: true, replacing: true, checks: checks('2026-10-29T10:06:00.000Z') })).toBe('connect');
  });

  it('Run your agent while waiting for a first call or during a check; Results once it ended', () => {
    expect(sandboxStepOf({ connected: true, replacing: false, checks: null })).toBe('run');
    expect(sandboxStepOf({ connected: true, replacing: false, checks: checks(null, false) })).toBe('run');
    expect(sandboxStepOf({ connected: true, replacing: false, checks: checks(null) })).toBe('run');
    expect(sandboxStepOf({ connected: true, replacing: false, checks: checks('2026-10-29T10:06:00.000Z') })).toBe('results');
  });

  it('three steps, in order', () => {
    expect(SANDBOX_STEPS.map((x) => x.title)).toEqual(['Connect', 'Run your agent', 'Results']);
  });
});
