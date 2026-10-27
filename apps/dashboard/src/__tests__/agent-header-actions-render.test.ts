// @vitest-environment happy-dom
// Agent detail's header: one Pause / Resume button (Pause shows a toast, with
// Undo on a fleet that holds agents) and a ⋯ menu with Stop… and Remove….
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import './support/dialog';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/agents/scout' }));
const api = vi.hoisted(() => ({ pause: vi.fn(), resume: vi.fn(), watch: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  checkWatch: api.watch,
  auditLog: async () => ({ entries: [] }),
  listRuns: async () => ({ runs: [] }),
  getDiagnosis: async () => { throw new Error('off'); },
  pauseAgent: api.pause,
  resumeAgent: api.resume,
}));
vi.mock('@/lib/control-actors', async (orig) => ({ ...(await orig<typeof import('@/lib/control-actors')>()), fetchControlActors: async () => [] }));
vi.mock('@/components/agent/RecentRuns', () => ({ RecentRuns: () => null }));
vi.mock('@/components/agent/AgentWeekCard', () => ({ AgentWeekCard: () => null }));
vi.mock('@/components/agent/RulesOnAgent', () => ({ RulesOnAgent: () => null }));
vi.mock('@/components/citadel/PageChrome', async () => {
  const { createElement } = await import('react');
  return { PageHeader: ({ children }: { children?: React.ReactNode }) => createElement('header', null, children), LiveStatus: () => null };
});

import { AgentDetail } from '@/components/agent/AgentDetail';
import { WhiteRoomApiError } from '@/lib/whiteroom/client';

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const HOLD = { state: 'stopped' as const, by: 'dashboard', reason: null, at: '2026-10-27T10:00:00Z' };

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(AgentDetail, { fleetId: 'f1', authKey: 'k', agentId: 'scout', from: 'home' })); });
  await flush();
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const click = async (b: Element | null | undefined) => { expect(b, 'button').toBeTruthy(); await act(async () => { (b as HTMLElement).click(); }); await flush(); };
  const toast = () => el.querySelector('.wr-toast');
  return { el, root, button, click, toast, menu: () => el.querySelector('[role="menu"]'), more: () => el.querySelector('[aria-label="More actions"]') };
}

beforeEach(() => {
  api.pause.mockReset(); api.resume.mockReset(); api.watch.mockReset();
  document.body.innerHTML = '';
});

describe('Agent detail header', () => {
  it('Pause on a fleet that holds agents shows a toast with the fleet-wide warning, and Undo resumes it', async () => {
    api.watch.mockResolvedValue({ status: 'idle', watchNumber: 1, govV1: true });
    api.pause.mockResolvedValue({ success: true });
    api.resume.mockResolvedValue({ success: true });
    const m = await mount();
    expect(m.button('Resume')).toBeUndefined();
    await m.click(m.button('Pause'));
    expect(api.pause).toHaveBeenCalledWith('f1', 'scout', 'k');
    expect(m.toast()?.textContent).toContain('scout paused. It makes no calls until you resume it.');
    expect(m.toast()?.textContent).toContain('can’t tie to an agent');
    await m.click([...m.toast()!.querySelectorAll('button')].find((b) => b.textContent === 'Undo'));
    expect(api.resume).toHaveBeenCalledWith('f1', 'scout', 'k');
    expect(m.toast()).toBeNull();
    m.root.unmount();
  });

  it('Pause on an older fleet says it starts again on its own, with no Undo', async () => {
    api.watch.mockResolvedValue({ status: 'working', watchNumber: 1 });
    api.pause.mockResolvedValue({ success: true });
    const m = await mount();
    await m.click(m.button('Pause'));
    expect(m.toast()?.textContent).toContain('starts again on its own');
    expect([...m.toast()!.querySelectorAll('button')].some((b) => b.textContent === 'Undo')).toBe(false);
    m.root.unmount();
  });

  it('a failed Pause stays on screen with Try again', async () => {
    api.watch.mockResolvedValue({ status: 'idle', watchNumber: 1, govV1: true });
    api.pause.mockRejectedValueOnce(new WhiteRoomApiError('Engine unavailable', 503)).mockResolvedValueOnce({ success: true });
    const m = await mount();
    await m.click(m.button('Pause'));
    expect(m.el.textContent).toContain('Couldn’t pause scout.');
    expect(m.toast()).toBeNull();
    await m.click(m.button('Try again'));
    expect(api.pause).toHaveBeenCalledTimes(2);
    expect(m.toast()).not.toBeNull();
    m.root.unmount();
  });

  it('shows Resume for a held agent, and Stop… is unavailable once it is stopped', async () => {
    api.watch.mockResolvedValue({ status: 'idle', watchNumber: 1, govV1: true, hold: HOLD });
    const m = await mount();
    expect(m.button('Pause')).toBeUndefined();
    expect(m.button('Resume')).toBeTruthy();
    await m.click(m.more());
    expect(m.button('Stop…')?.disabled).toBe(true);
    expect(m.button('Remove…')?.disabled).toBe(false);
    m.root.unmount();
  });

  it('the ⋯ menu closes on Escape and on a click outside it', async () => {
    api.watch.mockResolvedValue({ status: 'idle', watchNumber: 1, govV1: true });
    const m = await mount();
    await m.click(m.more());
    expect(m.menu()).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(m.menu()).toBeNull();
    await m.click(m.more());
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(m.menu()).toBeNull();
    m.root.unmount();
  });
});
