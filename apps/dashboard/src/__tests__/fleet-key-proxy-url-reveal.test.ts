// @vitest-environment happy-dom
// Fleet key: a connected key's proxy URL stays with the key, hidden until
// Reveal. A key connected before URLs were saved still says it was shown once.
// All placeholders; no real keys.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProviderKey } from '@/lib/whiteroom/types';
import { maskProxyUrl, proxyUrlState, savedPrefixFor } from '@/lib/provider-key-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import './support/dialog';

const PREFIX = 'sk-wr-0000000000000000';
const PROXY_KEY = PREFIX + '0'.repeat(24);
const URL = `https://proxy.whiteroom.tech/${PROXY_KEY}`;
const key = (over: Partial<ProviderKey> = {}): ProviderKey => ({ wrKey: `${PREFIX}...`, provider: 'anthropic', keyHint: '5678', createdAt: '2026-11-01T00:00:00Z', ...over });
const api = vi.hoisted(() => ({
  keys: [] as unknown[], saved: [] as string[], store: vi.fn(), del: vi.fn(), replace: vi.fn(),
  remember: vi.fn(), reveal: vi.fn(), drop: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('@/lib/owner-credentials', () => ({ rotateApiKey: vi.fn(), replaceProxyUrls: api.replace }));
vi.mock('@/lib/proxy-keys', () => ({ rememberProxyKey: api.remember, revealProxyKey: api.reveal, dropProxyKey: api.drop, revealableProxyKeys: async () => api.saved }));
vi.mock('@/lib/users', () => ({ setByok: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  listProviderKeys: async () => ({ success: true, keys: api.keys }),
  storeProviderKey: api.store,
  deleteProviderKey: api.del,
  getBedrockRoleStatus: async () => ({ success: true, configured: false }),
}));

const { Onboarding } = await import('@/app/fleet-key/onboarding');

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(Onboarding, { name: 'Test', email: 'test@example.invalid', apiKey: 'sk-wr-placeholder', fleetId: 'f', fleetToken: null, isNew: false })); });
  const type = async (selector: string, text: string) => {
    const input = el.querySelector(selector) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const click = async (label: string) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === label) as HTMLButtonElement;
    await act(async () => { b.click(); });
  };
  const keys = () => el.querySelector('#provider-keys')!;
  return { el, root, type, click, keys };
}

beforeEach(() => {
  api.keys = []; api.saved = [];
  for (const f of [api.store, api.del, api.replace, api.remember, api.reveal, api.drop]) f.mockReset();
  api.remember.mockResolvedValue(true); api.drop.mockResolvedValue(undefined);
  document.body.innerHTML = '';
});

describe('saved proxy URLs: the pure rules', () => {
  it('matches a listed key to its saved prefix, and never on a prefix too short to trust', () => {
    expect(savedPrefixFor(key(), [PREFIX])).toBe(PREFIX);
    expect(savedPrefixFor(key(), ['sk-wr-1111111111111111'])).toBeNull();
    expect(savedPrefixFor({ wrKey: 'sk-wr-...' }, [PREFIX])).toBeNull();
  });

  it('a tab whose keys are all saved has nothing lost to explain; one that isn’t is named', () => {
    const old = key({ wrKey: 'sk-wr-1111111111111111...', keyHint: '9999' });
    expect(proxyUrlState('direct', null, [key()], [PREFIX])).toEqual({ kind: 'saved' });
    expect(proxyUrlState('direct', null, [key(), old], [PREFIX])).toEqual({ kind: 'shown-once', keyHint: '9999' });
  });

  it('masks all but the start of the key', () => {
    expect(maskProxyUrl('https://proxy.whiteroom.tech', PREFIX)).toBe('https://proxy.whiteroom.tech/sk-wr-0000…');
  });
});

describe('Fleet key: the proxy URL stays with its key', () => {
  it('a saved URL is hidden until Reveal, then shown with its setup line, and hidden again', async () => {
    api.keys = [key()]; api.saved = [PREFIX];
    api.reveal.mockResolvedValue(PROXY_KEY);
    const { el, root, click, keys } = await mount();
    expect(keys().textContent).toContain('https://proxy.whiteroom.tech/sk-wr-0000…');
    expect(el.textContent).not.toContain(PROXY_KEY);
    expect(el.textContent).not.toContain('shown once');
    expect(el.querySelector('section#point')!.textContent).toContain('Your proxy URL is with your key under Provider keys. Choose Reveal, then set it where your agent runs.');
    const copy = keys().querySelector('[title="Reveal the URL to copy it"]') as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    await click('Reveal');
    expect(api.reveal).toHaveBeenCalledWith(PREFIX);
    expect(keys().textContent).toContain(URL);
    expect(keys().textContent).toContain(`export ANTHROPIC_BASE_URL=${URL}`);
    await click('Hide');
    expect(el.textContent).not.toContain(PROXY_KEY);
    await act(async () => { root.unmount(); });
  });

  it('a URL that won’t load says so, and shows nothing', async () => {
    api.keys = [key()]; api.saved = [PREFIX];
    api.reveal.mockResolvedValue(null);
    const { root, click, keys } = await mount();
    await click('Reveal');
    expect(keys().querySelector('[role="alert"]')?.textContent).toBe('Couldn’t load this proxy URL. Try again in a minute.');
    await act(async () => { root.unmount(); });
  });

  it('a key connected before URLs were saved has no Reveal, and still says it was shown once', async () => {
    api.keys = [key()];
    const { el, root, keys } = await mount();
    expect([...keys().querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Reveal');
    expect(el.textContent).toContain('The proxy URL for your key ending 5678 was shown once, when you added it.');
    await act(async () => { root.unmount(); });
  });

  it('connecting a key saves its URL, so the page no longer says “shown once”', async () => {
    api.store.mockImplementation(async () => { api.keys = [key()]; return { success: true, proxyUrl: URL, proxyKey: PROXY_KEY, provider: 'anthropic', keyHint: '5678' }; });
    const { el, root, type, click, keys } = await mount();
    await type('#provider-keys input[type="password"]', 'sk-ant-placeholder-not-a-real-key');
    await click('Connect');
    expect(api.remember).toHaveBeenCalledWith(PROXY_KEY);
    expect(el.textContent).toContain('Key ending 5678 connected. Set this where your agent runs. You can see it again any time under Provider keys.');
    expect(el.textContent).not.toContain('shown once');
    expect([...keys().querySelectorAll('button')].map((b) => b.textContent)).toContain('Reveal');
    await act(async () => { root.unmount(); });
  });

  it('when the URL couldn’t be saved, it is still shown, as the one time', async () => {
    api.remember.mockResolvedValue(false);
    api.store.mockImplementation(async () => { api.keys = [key()]; return { success: true, proxyUrl: URL, proxyKey: PROXY_KEY, provider: 'anthropic', keyHint: '5678' }; });
    const { el, root, type, click } = await mount();
    await type('#provider-keys input[type="password"]', 'sk-ant-placeholder-not-a-real-key');
    await click('Connect');
    expect(el.textContent).toContain('It’s shown once, so copy it now.');
    expect(el.textContent).toContain(`export ANTHROPIC_BASE_URL=${URL}`);
    await act(async () => { root.unmount(); });
  });

  it('removing a key drops its saved URL', async () => {
    api.keys = [key()]; api.saved = [PREFIX];
    api.del.mockImplementation(async () => { api.keys = []; return { success: true }; });
    const { root, click } = await mount();
    await click('Remove…');
    await click('Remove key');
    expect(api.drop).toHaveBeenCalledWith(PREFIX);
    await act(async () => { root.unmount(); });
  });

  it('Replace URLs: saved new URLs are revealable and not called “shown once”', async () => {
    api.keys = [key()]; api.saved = [PREFIX];
    const fresh = 'sk-wr-1111111111111111' + '1'.repeat(24);
    api.replace.mockImplementation(async () => {
      api.keys = [key({ wrKey: 'sk-wr-1111111111111111...' })];
      return { ok: true, proxyKeysSaved: true, proxyKeys: [{ prefix: 'sk-wr-1111111111111111', provider: 'anthropic', keyHint: '5678', cloudIdentity: false, wrKey: fresh }], disconnected: [] };
    });
    const { root, click, keys } = await mount();
    await click('Replace URLs…');
    await click('Replace URLs');
    expect(keys().textContent).toContain('Update your agents with the new ones. You can see them again any time under Provider keys.');
    expect(keys().textContent).toContain('https://proxy.whiteroom.tech/sk-wr-1111…');
    await act(async () => { root.unmount(); });
  });

  it('the fleet key card says what it is for', async () => {
    const { el, root } = await mount();
    expect(el.textContent).toContain('Only for CLI commands and API requests. Your agents use a proxy URL, not this key.');
    await act(async () => { root.unmount(); });
  });
});
