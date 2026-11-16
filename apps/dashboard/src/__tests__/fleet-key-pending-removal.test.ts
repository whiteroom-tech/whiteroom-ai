// @vitest-environment happy-dom
// Removing a provider key when the engine turns it off but can't save that yet
// (engine #419): the key stays listed as "Off, saving…" with Try again, and
// doesn't count as a connected key.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProviderKey } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import './support/dialog';

const NOT_SAVED = 'This key is off for now, but we couldn’t save that. Try again in a minute.';
const KEY: ProviderKey = { wrKey: 'sk-wr-placeholder...', provider: 'anthropic', keyHint: '5678', createdAt: '2026-11-01T00:00:00Z' };
const api = vi.hoisted(() => ({ keys: [] as unknown[], remove: vi.fn(), setByok: vi.fn(async () => {}) }));

vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('@/lib/owner-credentials', () => ({ rotateApiKey: vi.fn(), replaceProxyUrls: vi.fn() }));
vi.mock('@/lib/users', () => ({ setByok: api.setByok }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  listProviderKeys: async () => ({ success: true, keys: api.keys }),
  deleteProviderKey: api.remove,
  getBedrockRoleStatus: async () => ({ success: true, configured: false }),
}));

const { Onboarding } = await import('@/app/fleet-key/onboarding');

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(Onboarding, { name: 'Test', email: 'test@example.invalid', apiKey: 'sk-wr-placeholder', fleetId: 'f', fleetToken: null, isNew: false })); });
  const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  const click = async (label: string) => { await act(async () => { button(label)!.click(); }); };
  return { el, root, button, click, row: () => el.querySelector('.wr-key-list li')?.textContent ?? null };
}

beforeEach(() => { api.keys = [KEY]; api.remove.mockReset(); api.setByok.mockClear(); document.body.innerHTML = ''; });

describe('removing a key the engine couldn’t save the removal of', () => {
  it('keeps it listed as off with Try again, shows why, and no longer counts it as connected', async () => {
    const m = await mount();
    expect(m.row()).toContain('key ending 5678');
    expect(m.row()).not.toContain('Off, saving');

    api.remove.mockResolvedValue({ error: NOT_SAVED, pending: true });
    api.keys = [{ ...KEY, pending: true }];
    await m.click('Remove…');
    await m.click('Remove key');
    expect(api.remove).toHaveBeenCalledWith(expect.anything(), 'sk-wr-placeholder');
    expect(m.row()).toContain('Off, saving…');
    expect(m.button('Try again')).toBeDefined();
    expect(m.button('Remove…')).toBeUndefined();
    expect(m.el.querySelector('[role="alert"]')?.textContent).toBe(NOT_SAVED);
    expect(api.setByok).toHaveBeenLastCalledWith(false);

    // Trying again needs no second confirmation: the key is already off. This time the engine saves it.
    api.remove.mockResolvedValue({ success: true, removed: { provider: 'anthropic', keyHint: '5678' } });
    api.keys = [];
    await m.click('Try again');
    expect(api.remove).toHaveBeenCalledTimes(2);
    expect(m.row()).toBeNull();
    expect(m.el.querySelector('[role="alert"]')).toBeNull();
    m.root.unmount();
  });

  it('a removal the engine refused outright still reads as a failure, and the key stays as it was', async () => {
    const m = await mount();
    api.remove.mockResolvedValue({ error: 'Key not found.' });
    await m.click('Remove…');
    await m.click('Remove key');
    expect(m.el.querySelector('[role="alert"]')?.textContent).toBe('Key not found.');
    expect(m.row()).not.toContain('Off, saving');
    expect(api.setByok).not.toHaveBeenCalled();
    m.root.unmount();
  });
});
