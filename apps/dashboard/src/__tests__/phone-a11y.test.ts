// @vitest-environment happy-dom
// Phase 8: the phone tab bar and its menu, Home and End in a segmented control, and
// Needs you's Undo staying while it has focus.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ path: '/home' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  listRuns: async () => ({ runs: [{ runId: 'r1', agentId: 'a1', shift: 3, flags: [{ kind: 'loop' }] }], total: 1 }),
}));

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/lib/organization-actions', () => ({ myOrganizationSummary: async () => null }));

const { PhoneTabBar, TABS, MORE } = await import('@/components/PhoneTabBar');
const { AppShell } = await import('@/components/AppShell');
const { SegmentedControl } = await import('@whiteroom/ui');
const { NeedsYou } = await import('@/components/home/NeedsYou');

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
let el: HTMLDivElement;
let root: Root;
beforeEach(() => { el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); el.remove(); localStorage.clear(); vi.useRealTimers(); });
const render = async (node: React.ReactElement) => { await act(async () => { root.render(node); }); await flush(); };

describe('phone tab bar', () => {
  it('has the four everyday pages and More for the rest', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Home', 'Performance', 'Runs', 'Controls']);
    expect(MORE.map((t) => t.label)).toEqual(['Sandbox', 'Fleet key', 'Settings']);
  });

  it('marks the page you are on, and More for a page in the menu', async () => {
    nav.path = '/runs/r1';
    await render(h(PhoneTabBar, { menuOpen: false, onMore: () => {} }));
    expect(el.querySelector('[aria-current="page"]')?.textContent).toBe('Runs');
    nav.path = '/settings';
    await render(h(PhoneTabBar, { menuOpen: false, onMore: () => {} }));
    expect(el.querySelector('[aria-current="page"]')).toBeNull();
    const more = el.querySelector('button')!;
    expect(more.className).toContain('is-active');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.getAttribute('aria-controls')).toBe('wr-main-nav');
  });

  it('More toggles the menu, and nothing else reads as current while it is open', async () => {
    nav.path = '/home';
    const onMore = vi.fn();
    await render(h(PhoneTabBar, { menuOpen: true, onMore }));
    expect(el.querySelector('[aria-current="page"]')).toBeNull();
    const more = el.querySelector('button')!;
    expect(more.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { more.click(); });
    expect(onMore).toHaveBeenCalledOnce();
  });
});

describe('phone menu (AppShell)', () => {
  const open = () => el.querySelector('.wr-shell')!.classList.contains('navigation-open');
  const more = () => el.querySelector('.wr-tabbar button') as HTMLButtonElement;
  const shell = () => h(AppShell, null, h('main', null, 'page'));

  it('More opens the menu; Escape, the scrim and going to a page close it', async () => {
    nav.path = '/home';
    await render(shell());
    expect(open()).toBe(false);
    expect(el.querySelector('.wr-menu-scrim')).toBeNull();
    await act(async () => { more().click(); });
    expect(open()).toBe(true);
    expect(more().getAttribute('aria-expanded')).toBe('true');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(open()).toBe(false);
    await act(async () => { more().click(); });
    await act(async () => { (el.querySelector('.wr-menu-scrim') as HTMLElement).click(); });
    expect(open()).toBe(false);
    await act(async () => { more().click(); });
    nav.path = '/settings';
    await render(shell());
    expect(open()).toBe(false);
  });

  it('focus goes into the menu and comes back to More; the page behind is inert; a link closes it', async () => {
    nav.path = '/home';
    await render(shell());
    const page = el.querySelector('main')!.parentElement!;
    more().focus();
    await act(async () => { more().click(); });
    expect(el.querySelector('#wr-main-nav')!.contains(document.activeElement)).toBe(true);
    expect(page.inert).toBe(true);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(document.activeElement).toBe(more());
    expect(page.inert).toBe(false);
    // A link to the page you're on changes no path, and still closes the menu.
    await act(async () => { more().click(); });
    const home = [...el.querySelectorAll('#wr-main-nav a')].find((a) => a.textContent === 'Home') as HTMLAnchorElement;
    const stay = (e: Event) => e.preventDefault();
    document.addEventListener('click', stay);
    await act(async () => { home.click(); });
    document.removeEventListener('click', stay);
    expect(open()).toBe(false);
  });

  it('closes when the window widens past the phone layout, so the page isn’t left inert', async () => {
    const listeners: Array<() => void> = [];
    const wide = { matches: false, addEventListener: (_: string, f: () => void) => { listeners.push(f); }, removeEventListener() {} };
    vi.stubGlobal('matchMedia', () => wide);
    try {
      await render(shell());
      await act(async () => { more().click(); });
      expect(open()).toBe(true);
      wide.matches = true;
      await act(async () => { listeners.forEach((f) => f()); });
      expect(open()).toBe(false);
      expect(el.querySelector('main')!.parentElement!.inert).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the sidebar it opens is the one More controls', async () => {
    await render(shell());
    expect(el.querySelector('#wr-main-nav')).toBeTruthy();
    expect(more().getAttribute('aria-controls')).toBe('wr-main-nav');
  });
});

describe('segmented control keys', () => {
  it('Home and End pick the first and last enabled options', async () => {
    const onChange = vi.fn();
    await render(h(SegmentedControl<'off' | 'watch' | 'enforce' | 'locked'>, {
      label: 'Mode', value: 'watch', onChange,
      options: [{ value: 'off', label: 'Off' }, { value: 'watch', label: 'Record only' }, { value: 'enforce', label: 'Block' }, { value: 'locked', label: 'Locked', disabled: true }],
    }));
    const on = el.querySelector('[aria-checked="true"]') as HTMLButtonElement;
    await act(async () => { on.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('enforce');
    expect(document.activeElement?.textContent).toBe('Block');
    await act(async () => { on.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('off');
    expect(document.activeElement?.textContent).toBe('Off');
  });
});

describe('Needs you undo', () => {
  const mount = async () => {
    await render(h(NeedsYou, { agents: [], holds: {}, holdsKnown: true, fleet: { fleetId: 'f1' } }));
    const live = el.querySelector('[role="status"]');
    expect(live?.textContent).toBe('');
    const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
    await act(async () => { button('Mark as seen')!.click(); });
    // The same element: it stays mounted when the panel gives way to "Nothing needs you".
    expect(el.querySelector('[role="status"]')).toBe(live);
    return button;
  };

  it('moves focus to Undo, and keeps it while focused; it goes 5 s after focus leaves', async () => {
    const button = await mount();
    vi.useFakeTimers();
    const undo = button('Undo')!;
    expect(document.activeElement).toBe(undo);
    // Announced through a live region that was already there, so screen readers speak it.
    expect(el.querySelector('[role="status"]')!.textContent).toBe('Marked as seen.');
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(button('Undo')).toBeDefined();
    await act(async () => { undo.blur(); });
    await act(async () => { vi.advanceTimersByTime(4_900); });
    expect(button('Undo')).toBeDefined();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(button('Undo')).toBeUndefined();
  });

  it('Undo brings the run back', async () => {
    const button = await mount();
    expect(el.textContent).not.toContain('Run 3');
    await act(async () => { button('Undo')!.click(); });
    expect(el.textContent).toContain('Run 3');
    expect(button('Undo')).toBeUndefined();
  });
});
