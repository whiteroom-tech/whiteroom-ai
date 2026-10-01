import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNavActive, isUnder, ROUTES } from '@/lib/routes';

describe('nav matching', () => {
  it('matches the page and pages under it, not shared prefixes', () => {
    expect(isUnder('/settings', '/settings')).toBe(true);
    expect(isUnder('/settings/confirm-email', '/settings')).toBe(true);
    expect(isUnder('/settings-old', '/settings')).toBe(false);
  });

  it('highlights an item for its extra paths too', () => {
    expect(isNavActive('/fleet', ROUTES.home, ['/fleet'])).toBe(true);
    expect(isNavActive('/runs', ROUTES.home, ['/fleet'])).toBe(false);
  });
});

// lib/theme.ts reads localStorage and writes data attributes; give it small
// stand-ins rather than a full DOM.
class FakeEl {
  attrs = new Map<string, string>();
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
}

describe('theme helpers', () => {
  let root: FakeEl;
  let shell: FakeEl;
  const store = new Map<string, string>();

  beforeEach(() => {
    root = new FakeEl();
    shell = new FakeEl();
    store.clear();
    Object.assign(globalThis, {
      document: { documentElement: root, querySelector: (sel: string) => (sel === '.wr-shell' ? shell : null) },
      window: globalThis,
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
  });
  afterEach(() => {
    for (const k of ['document', 'localStorage', 'window']) delete (globalThis as Record<string, unknown>)[k];
  });

  it('reads only light or dark as a stored choice', async () => {
    const { storedTheme } = await import('@/lib/theme');
    expect(storedTheme()).toBe('system');
    store.set('wr_theme', 'light');
    expect(storedTheme()).toBe('light');
    store.set('wr_theme', 'purple');
    expect(storedTheme()).toBe('system');
  });

  it('stores, pins and clears the choice on the shell and on <html>', async () => {
    const { chooseTheme } = await import('@/lib/theme');
    chooseTheme('light');
    expect(store.get('wr_theme')).toBe('light');
    expect(shell.getAttribute('data-theme')).toBe('light');
    expect(root.getAttribute('data-wr-theme')).toBe('light');
    chooseTheme('system');
    expect(store.has('wr_theme')).toBe(false);
    expect(shell.getAttribute('data-theme')).toBeNull();
    expect(root.getAttribute('data-wr-theme')).toBeNull();
  });

  it('applies to a given shell rather than the first one on the page', async () => {
    const { applyTheme } = await import('@/lib/theme');
    const other = new FakeEl();
    applyTheme('dark', other as unknown as Element);
    expect(other.getAttribute('data-theme')).toBe('dark');
    expect(shell.getAttribute('data-theme')).toBeNull();
  });
});
