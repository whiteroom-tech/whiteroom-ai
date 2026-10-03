import { describe, expect, it } from 'vitest';
import { activeHold, activeHolds } from '@/lib/holds';

const at = '2026-10-02T20:00:00Z';

describe('holds from the engine', () => {
  it('keeps paused and stopped, and reads a resume tombstone as no hold', () => {
    expect(activeHold({ state: 'paused', by: 'dashboard', reason: null, at })?.state).toBe('paused');
    expect(activeHold({ state: 'stopped', by: 'rule:r1', reason: null, at })?.state).toBe('stopped');
    expect(activeHold({ state: 'none' })).toBeNull();
    expect(activeHold(null)).toBeNull();
    expect(activeHold(undefined)).toBeNull();
  });

  it('filters a fleet report\'s holds the same way', () => {
    const holds = {
      a: { state: 'stopped', by: 'dashboard', reason: null, at },
      b: { state: 'none', by: 'dashboard', reason: null, at },
    } as unknown as Parameters<typeof activeHolds>[0];
    expect(Object.keys(activeHolds(holds)!)).toEqual(['a']);
    expect(activeHolds(undefined)).toBeUndefined();
  });
});
