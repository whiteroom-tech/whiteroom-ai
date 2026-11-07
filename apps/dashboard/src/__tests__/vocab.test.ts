import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENFORCE_TAG, MODE_LABEL, modeTagText, modeWords } from '@/lib/vocab';

describe('rule mode words', () => {
  it('labels the modes Off · Watch · Enforce', () => {
    expect([MODE_LABEL.off, MODE_LABEL.watch, MODE_LABEL.enforce]).toEqual(['Off', 'Watch', 'Enforce']);
  });

  it('tags an enforced rule by what it does: Enforce, the action when it isn’t Block, and Alert only for alerts', () => {
    expect(ENFORCE_TAG).toEqual({ block: 'Enforce', pause: 'Enforce · pauses', stop: 'Enforce · stops', notify: 'Alert only' });
    expect(modeTagText({ mode: 'watch', response: 'stop' })).toBe('Watch');
    expect(modeTagText({ mode: 'off' })).toBe('Off');
    expect(modeTagText({ mode: 'enforce' })).toBe('Enforce');
    expect(modeTagText({ mode: 'enforce', response: 'notify' })).toBe('Alert only');
  });

  it('shows engine history text, and entries written with the retired labels, in today’s words', () => {
    expect(modeWords('Off → Watch')).toBe('Off → Watch');
    expect(modeWords('Watch → Enforce')).toBe('Watch → Enforce');
    expect(modeWords('Loop breaker: Enforce → Off')).toBe('Loop breaker: Enforce → Off');
    expect(modeWords('Added Model allowlist in Watch only (suggested)')).toBe('Added Model allowlist in Watch (suggested)');
    expect(modeWords('Added Model allowlist in Record only (suggested)')).toBe('Added Model allowlist in Watch (suggested)');
    expect(modeWords('Mode: Record only → Block')).toBe('Mode: Watch → Enforce');
  });

  it('leaves other words alone', () => {
    expect(modeWords('Then → Pause')).toBe('Then → Pause');
    expect(modeWords('Block the call → Pause the agent')).toBe('Block the call → Pause the agent');
    expect(modeWords('Watchlist updated')).toBe('Watchlist updated');
    expect(modeWords('Added Watch rule for agent Watch')).toBe('Added Watch rule for agent Watch');
    expect(modeWords('Enforce the policy')).toBe('Enforce the policy');
  });
});

// "Record only" was the Watch mode's label until Oct 28 2026. Only vocab.ts
// still names it, to show old history entries in today's words.
describe('the retired "Record only" label', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === '__tests__' ? [] : files(p)) : /\.(tsx?|css)$/.test(f) ? [p] : [];
  });
  it('appears nowhere in src outside comments, except the history mapping', () => {
    const hits = files(root).filter((p) => !p.endsWith(join('lib', 'vocab.ts'))).filter((p) => {
      const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      return /record[ -]only/i.test(code);
    });
    expect(hits).toEqual([]);
  });
});
