// @vitest-environment happy-dom
// Phase 8: the phone tab bar and its menu, Home and End in a segmented control, and
// Home's Pause with a toast and Undo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ path: '/home' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
const api = vi.hoisted(() => ({ pause: vi.fn(), resume: vi.fn(), check: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  pauseAgent: api.pause,
  resumeAgent: api.resume,
  checkWatch: api.check,
}));

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/lib/organization-actions', () => ({ myOrganizationSummary: async () => null }));
vi.mock('@/lib/account', () => ({ getAccountClosing: async () => null, cancelAccountDeletion: async () => ({ ok: true }) }));

const { PhoneTabBar, TABS, MORE } = await import('@/components/PhoneTabBar');
const { AppShell } = await import('@/components/AppShell');
const { SegmentedControl } = await import('@whiteroom/ui');
const { AgentActions } = await import('@/components/home/AgentActions');
const { HomeFacts } = await import('@/components/home/HomeFacts');
const { ControlDeniedError, WhiteRoomApiError } = await import('@/lib/whiteroom/client');

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

describe('Pause from Home', () => {
  const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  const agent = { agentId: 'code-reviewer', status: 'idle' };

  it('pauses at once and offers Undo in a toast, which resumes', async () => {
    const own = { state: 'paused', by: 'user:u1', reason: null, at: '2026-10-27T10:00:00.000Z' };
    api.pause.mockResolvedValue({ success: true, hold: own });
    api.resume.mockResolvedValue({});
    api.check.mockResolvedValue({ agentId: 'code-reviewer', status: 'idle', hold: own });
    await render(h(AgentActions, { agent, fleetId: 'f1', onChanged: () => {} }));
    await act(async () => { (el.querySelector('[aria-label="Actions for code-reviewer"]') as HTMLButtonElement).click(); });
    await act(async () => { button('Pause')!.click(); });
    await flush();
    expect(api.pause).toHaveBeenCalledWith('f1', 'code-reviewer', undefined);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('code-reviewer paused.');
    await act(async () => { button('Undo')!.click(); });
    await flush();
    expect(api.resume).toHaveBeenCalledWith('f1', 'code-reviewer', undefined);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('code-reviewer resumed.');
    expect(button('Undo')).toBeUndefined();
  });

  it('keeps a failure on screen until it is dismissed', async () => {
    api.pause.mockRejectedValue(new Error('boom'));
    vi.useFakeTimers();
    await render(h(AgentActions, { agent, fleetId: 'f1', onChanged: () => {} }));
    await act(async () => { (el.querySelector('[aria-label="Actions for code-reviewer"]') as HTMLButtonElement).click(); });
    await act(async () => { button('Pause')!.click(); });
    await flush();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t pause code-reviewer');
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => { (el.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click(); });
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('Undo after a Pause', () => {
  const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  it('is withdrawn once the agent is held some other way', async () => {
    api.pause.mockResolvedValue({ success: true, hold: { state: 'paused', by: 'user:u1', reason: null, at: '2026-10-27T10:00:00.000Z' } });
    const agent = { agentId: 'code-reviewer', status: 'idle' };
    await render(h(AgentActions, { agent, fleetId: 'f1', onChanged: () => {} }));
    await act(async () => { (el.querySelector('[aria-label="Actions for code-reviewer"]') as HTMLButtonElement).click(); });
    await act(async () => { button('Pause')!.click(); });
    await flush();
    // The refresh shows the pause: Undo stays.
    await render(h(AgentActions, { agent: { ...agent, hold: { state: 'paused', by: 'user:u1', reason: null, at: '' } }, fleetId: 'f1', onChanged: () => {} }));
    expect(button('Undo')).toBeDefined();
    // A rule then stops it: Undo would lift a hold it didn't make.
    await render(h(AgentActions, { agent: { ...agent, hold: { state: 'stopped', by: 'rule:gr_1', reason: null, at: '' } }, fleetId: 'f1', onChanged: () => {} }));
    expect(button('Undo')).toBeUndefined();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('code-reviewer paused.');
  });
});

describe('Home fact line', () => {
  const hold = { state: 'stopped' as const, by: 'user:u1', reason: null, at: '2026-10-27T10:00:00Z' };
  const facts = (onResumed = () => {}) => h(HomeFacts, { agents: [], holds: { 'old-scraper': hold }, holdsKnown: true, flaggedToday: 2, todayRules: null, fleet: { fleetId: 'f1' }, onResumed });
  const resumeButton = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Resume') as HTMLButtonElement;

  it('resumes an agent removed while held, and says so', async () => {
    api.resume.mockResolvedValue({});
    const onResumed = vi.fn();
    await render(facts(onResumed));
    expect(el.textContent).toContain('1 agent on hold: old-scraper (removed, stopped)');
    expect(el.querySelector('a[href="/runs?show=flagged&range=today"]')?.textContent).toBe('2 flagged runs today');
    await act(async () => { resumeButton().click(); });
    await flush();
    expect(api.resume).toHaveBeenCalledWith('f1', 'old-scraper', undefined);
    expect(onResumed).toHaveBeenCalled();
  });

  it.each([
    [new ControlDeniedError('Only owners can resume agents.'), 'Only owners can resume agents.'],
    [new WhiteRoomApiError('expired', 401), 'Your session expired. Reload the page to sign in again.'],
    [new Error('down'), 'Couldn’t resume old-scraper. Nothing changed; try again.'],
  ])('says why a Resume failed (%s)', async (err, words) => {
    api.resume.mockRejectedValue(err);
    await render(facts());
    await act(async () => { resumeButton().click(); });
    await flush();
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(words);
  });
});

describe('Undo after a Pause, resumed elsewhere', () => {
  const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  it('stays through a refresh that hasn’t caught up, and goes once the pause is seen and then lifted', async () => {
    api.pause.mockResolvedValue({ success: true, hold: { state: 'paused', by: 'user:u1', reason: null, at: '2026-10-27T10:00:00.000Z' } });
    const agent = { agentId: 'code-reviewer', status: 'idle' };
    const at = (x: object) => render(h(AgentActions, { agent: { ...agent, ...x }, fleetId: 'f1', onChanged: () => {} }));
    await at({});
    await act(async () => { (el.querySelector('[aria-label="Actions for code-reviewer"]') as HTMLButtonElement).click(); });
    await act(async () => { button('Pause')!.click(); });
    await flush();
    // A refresh from before the pause landed: no hold yet, Undo stays.
    await at({ hold: null });
    expect(button('Undo')).toBeDefined();
    await at({ hold: { state: 'paused', by: 'user:u1', reason: null, at: '2026-10-27T10:00:00.000Z' } });
    expect(button('Undo')).toBeDefined();
    // Someone else resumed it: there's no pause left to undo.
    await at({ hold: null });
    expect(button('Undo')).toBeUndefined();
  });
});

describe('Undo checks the hold first', () => {
  const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  const pauseThenUndo = async () => {
    api.pause.mockResolvedValue({ success: true, hold: { state: 'paused', by: 'user:u1', reason: null, at: '2026-10-27T10:00:00.000Z' } });
    api.resume.mockReset();
    await render(h(AgentActions, { agent: { agentId: 'code-reviewer', status: 'idle' }, fleetId: 'f1', onChanged: () => {} }));
    await act(async () => { (el.querySelector('[aria-label="Actions for code-reviewer"]') as HTMLButtonElement).click(); });
    await act(async () => { button('Pause')!.click(); });
    await flush();
    await act(async () => { button('Undo')!.click(); });
    await flush();
  };

  it('leaves an agent alone that was stopped since', async () => {
    api.check.mockResolvedValue({ agentId: 'code-reviewer', status: 'idle', hold: { state: 'stopped', by: 'rule:gr_1', reason: null, at: new Date().toISOString() } });
    await pauseThenUndo();
    expect(api.resume).not.toHaveBeenCalled();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Nothing changed.');
  });

  it('leaves another pause alone, even one made a moment later', async () => {
    api.check.mockResolvedValue({ agentId: 'code-reviewer', status: 'idle', hold: { state: 'paused', by: 'user:u2', reason: null, at: '2026-10-27T10:00:05.000Z' } });
    await pauseThenUndo();
    expect(api.resume).not.toHaveBeenCalled();
  });

  it('offers no Undo when the engine doesn’t say which hold it set', async () => {
    api.pause.mockResolvedValue({ success: true });
    await render(h(AgentActions, { agent: { agentId: 'code-reviewer', status: 'idle' }, fleetId: 'f1', onChanged: () => {} }));
    await act(async () => { (el.querySelector('[aria-label="Actions for code-reviewer"]') as HTMLButtonElement).click(); });
    await act(async () => { button('Pause')!.click(); });
    await flush();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('code-reviewer paused.');
    expect(button('Undo')).toBeUndefined();
  });

  it('does nothing when the check fails, and says so', async () => {
    api.check.mockRejectedValue(new Error('down'));
    await pauseThenUndo();
    expect(api.resume).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t check code-reviewer before undoing. Nothing changed.');
  });
});
