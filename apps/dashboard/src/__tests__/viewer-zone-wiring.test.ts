// @vitest-environment happy-dom
// How the saved zone reaches the page: Providers sets it before anything below
// renders, components that stay mounted follow a change, and Settings switches
// it the moment a save succeeds.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next-auth/react', async () => {
  const { createElement, Fragment } = await import('react');
  return { SessionProvider: ({ children }: { children: React.ReactNode }) => createElement(Fragment, null, children), useSession: () => ({ data: null }) };
});
vi.mock('@/lib/account', () => ({ updateProfile: vi.fn() }));
// Settings' other imports, stood in for as the Settings render test does.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => '/settings' }));
vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('@/lib/billing', () => ({ openBillingPortal: vi.fn(), startCheckout: vi.fn() }));
vi.mock('@/lib/plan-savings', () => ({ getMonthSavings: vi.fn(async () => null) }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: null }) }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));

import { Providers } from '@/app/providers';
import { saveProfile } from '@/app/settings/settings-view';
import { useViewerZone } from '@/hooks/useViewerZone';
import { savedViewerZone, setViewerZone, viewerZone } from '@/lib/zone-time';
import { localDay, viewerTimeZone } from '@/lib/runs';

afterEach(() => { setViewerZone(null); document.body.innerHTML = ''; });

const now = Date.parse('2026-10-28T03:30:00Z'); // Oct 27 in New York, Oct 28 in Tokyo

function mount(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => { root.render(node); });
  return { el, root };
}

describe('Providers', () => {
  it('sets the saved zone before the page below renders', () => {
    let seen = '';
    const Page = () => { seen = `${viewerTimeZone()} ${localDay(now)}`; return null; };
    mount(h(Providers, { session: null, timeZone: 'America/New_York', children: h(Page) }));
    expect(seen).toBe('America/New_York 2026-10-27');
    expect(savedViewerZone()).toBe('America/New_York');
  });

  it('with no saved zone, dates follow the browser', () => {
    setViewerZone('Asia/Tokyo');
    mount(h(Providers, { session: null, timeZone: null, children: null }));
    expect(savedViewerZone()).toBeNull();
    expect(viewerZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('a mounted component follows a new zone from the layout', () => {
    const Shown = () => h('span', null, useViewerZone());
    const { el, root } = mount(h(Providers, { session: null, timeZone: 'America/New_York', children: h(Shown) }));
    expect(el.textContent).toBe('America/New_York');
    act(() => { root.render(h(Providers, { session: null, timeZone: 'Asia/Kolkata', children: h(Shown) })); });
    expect(el.textContent).toBe('Asia/Kolkata');
  });
});

describe('Settings › Save profile', () => {
  it('switches the zone at once when the save succeeds, and re-renders what shows it', async () => {
    const Shown = () => h('span', null, useViewerZone());
    const { el } = mount(h(Shown));
    const update = vi.fn().mockResolvedValue({ ok: true });
    await act(async () => { await saveProfile({ name: 'R', timezone: 'Asia/Kolkata' }, update); });
    expect(update).toHaveBeenCalledWith({ name: 'R', timezone: 'Asia/Kolkata' });
    expect(savedViewerZone()).toBe('Asia/Kolkata');
    expect(el.textContent).toBe('Asia/Kolkata');
    await act(async () => { await saveProfile({ name: 'R', timezone: null }, update); });
    expect(savedViewerZone()).toBeNull();
  });

  it('keeps the zone when the save fails', async () => {
    setViewerZone('America/New_York');
    const res = await saveProfile({ name: 'R', timezone: 'Asia/Kolkata' }, vi.fn().mockResolvedValue({ ok: false, error: 'nope' }));
    expect(res).toEqual({ ok: false, error: 'nope' });
    expect(savedViewerZone()).toBe('America/New_York');
  });
});
