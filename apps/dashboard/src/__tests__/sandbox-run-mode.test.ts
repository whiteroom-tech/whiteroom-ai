import { describe, it, expect } from 'vitest';
import { withRunMode, type RunStatusResult } from '../lib/sandbox/api';

const empty: RunStatusResult = {};

// A demo relabelled as a live test presents synthetic evidence as real, so
// the mode must survive every status refresh.
describe('withRunMode', () => {
  it('keeps an explicit mode', () => {
    expect(withRunMode({ mode: 'connected', isTrial: true }).mode).toBe('connected');
  });

  it('derives the mode from the engine trial flag', () => {
    expect(withRunMode({ isTrial: true }).mode).toBe('demo');
    expect(withRunMode({ isTrial: false }, 'demo').mode).toBe('connected');
  });

  it('keeps the created mode when the engine reports neither', () => {
    expect(withRunMode(empty, 'demo').mode).toBe('demo');
    expect(withRunMode(empty).mode).toBeUndefined();
  });
});
