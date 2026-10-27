import { describe, expect, it } from 'vitest';
import { MODE_LABEL, modeWords } from '@/lib/vocab';

describe('rule mode words', () => {
  it('labels the modes Off · Record only · Block', () => {
    expect([MODE_LABEL.off, MODE_LABEL.watch, MODE_LABEL.enforce]).toEqual(['Off', 'Record only', 'Block']);
  });

  it('shows engine history text in today’s words', () => {
    expect(modeWords('Off → Watch')).toBe('Off → Record only');
    expect(modeWords('Watch → Enforce')).toBe('Record only → Block');
    expect(modeWords('Loop breaker: Enforce → Off')).toBe('Loop breaker: Block → Off');
    expect(modeWords('Added Model allowlist in Watch only (suggested)')).toBe('Added Model allowlist in Record only (suggested)');
  });

  it('leaves text that already uses the new words, and other words, alone', () => {
    expect(modeWords('Record only → Block')).toBe('Record only → Block');
    expect(modeWords('Then → Pause')).toBe('Then → Pause');
    expect(modeWords('Watchlist updated')).toBe('Watchlist updated');
  });
});
