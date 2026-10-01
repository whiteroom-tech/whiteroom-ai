import { describe, expect, it } from 'vitest';
import { SANDBOX_STEPS, sandboxStep } from '@/components/sandbox/TestRunFlow';

// The steps rail follows what the test has actually seen.
describe('sandbox steps rail', () => {
  const base = { stage: 0, allPassed: false, expired: false, demo: false };
  it('starts on "Start a test" until a test exists', () => {
    expect(sandboxStep('start', base)).toBe(0);
    expect(sandboxStep('setup', base)).toBe(0);
  });
  it('waits on "Point your agent" until the first call goes through', () => {
    expect(sandboxStep('workspace', { ...base, stage: 1 })).toBe(1);
    expect(sandboxStep('workspace', { ...base, stage: 2 })).toBe(1);
  });
  it('moves to "Run one task" once a call went through, and to Results when done', () => {
    expect(sandboxStep('workspace', { ...base, stage: 3 })).toBe(2);
    expect(sandboxStep('workspace', { ...base, stage: 4, allPassed: true })).toBe(3);
    expect(sandboxStep('workspace', { ...base, expired: true })).toBe(3);
    expect(sandboxStep('workspace', { ...base, demo: true })).toBe(3);
  });
  it('has the four steps', () => {
    expect(SANDBOX_STEPS.map((x) => x.title)).toEqual(['Start a test', 'Point your agent', 'Run one task', 'Results']);
  });
});
