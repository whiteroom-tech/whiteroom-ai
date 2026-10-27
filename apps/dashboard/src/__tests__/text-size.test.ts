import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEXT_SIZE_BOOT, applyTextSize, chooseTextSize, parseTextSize, storedTextSize } from '@/lib/text-size';

// A stand-in for <html>: just the attribute calls the code uses.
function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (k: string, v: string) => { attrs.set(k, v); },
    removeAttribute: (k: string) => { attrs.delete(k); },
  };
}

function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('text size', () => {
  it('falls back to Default for missing or unknown values', () => {
    expect(parseTextSize(null)).toBe('md');
    expect(parseTextSize('huge')).toBe('md');
    expect(parseTextSize('md')).toBe('md');
    expect(parseTextSize('lg')).toBe('lg');
    expect(parseTextSize('xl')).toBe('xl');
  });

  it('sets data-wr-text for Large and Larger and clears it for Default', () => {
    const root = fakeRoot();
    applyTextSize('xl', root as unknown as Element);
    expect(root.attrs.get('data-wr-text')).toBe('xl');
    applyTextSize('md', root as unknown as Element);
    expect(root.attrs.has('data-wr-text')).toBe(false);
  });

  it('saves the choice in this browser and applies it', () => {
    const storage = fakeStorage();
    const root = fakeRoot();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('document', { documentElement: root });
    chooseTextSize('lg');
    expect(storage.m.get('wr_text')).toBe('lg');
    expect(root.attrs.get('data-wr-text')).toBe('lg');
    expect(storedTextSize()).toBe('lg');
  });

  it('boot script agrees with parseTextSize for every stored value', () => {
    for (const v of [null, 'md', 'lg', 'xl', 'huge', '']) {
      const root = fakeRoot();
      const storage = fakeStorage(v == null ? {} : { wr_text: v });
      new Function('localStorage', 'document', TEXT_SIZE_BOOT)(storage, { documentElement: root });
      const expected = parseTextSize(v);
      expect(root.attrs.get('data-wr-text') ?? 'md').toBe(expected);
    }
  });
});
