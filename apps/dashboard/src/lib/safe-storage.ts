// localStorage throws outright in some privacy modes rather than returning
// null, and does not exist at all during SSR. Every read/write of browser
// storage in the dashboard must go through these wrappers so an unavailable
// store degrades to "no saved state" instead of crashing the page.

export function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the value is simply not persisted */
  }
}

export function safeRemove(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* as above */
  }
}
