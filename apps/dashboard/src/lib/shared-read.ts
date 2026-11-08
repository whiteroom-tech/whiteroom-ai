/**
 * A browser-side read shared by the pages opened within `ttlMs`: a second
 * page reuses the first one's answer instead of asking again. A failed or
 * 'unknown' answer isn't kept, so the next page tries again. `key` keeps
 * reads for different arguments apart (only the last one is kept).
 */
export function sharedRead<T, K = void>(read: (key: K) => Promise<T | 'unknown'>, ttlMs: number) {
  let last: { at: number; key: K; value: Promise<T | 'unknown'> } | null = null;
  return {
    get(key: K, fresh = false): Promise<T | 'unknown'> {
      if (!fresh && last && last.key === key && Date.now() - last.at < ttlMs) return last.value;
      const value = read(key);
      last = { at: Date.now(), key, value };
      value.then((v) => { if (v === 'unknown' && last?.value === value) last = null; }, () => { if (last?.value === value) last = null; });
      return value;
    },
    forget(): void { last = null; },
  };
}
