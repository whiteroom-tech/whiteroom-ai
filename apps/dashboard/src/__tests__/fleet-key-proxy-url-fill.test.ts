// @vitest-environment happy-dom
// Fleet key: the connect card says where the proxy URL is. Just after a key is
// connected its lines carry the real URL; later, when the URL can't be shown
// again, it says so instead of leaving a bare placeholder. All placeholders; no real keys.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProviderKey } from '@/lib/whiteroom/types';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proxyUrlState, withProxyUrl } from '@/lib/provider-key-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import './support/dialog';

const URL_ISSUED = 'https://proxy.whiteroom.tech/sk-wr-placeholder-issued';
const key = (over: Partial<ProviderKey> = {}): ProviderKey => ({ wrKey: 'sk-wr-placeholder...', provider: 'anthropic', keyHint: '5678', createdAt: '2026-11-01T00:00:00Z', ...over });
const api = vi.hoisted(() => ({ keys: [] as unknown[], store: vi.fn(), rotate: vi.fn() }));

vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('@/lib/owner-credentials', () => ({ rotateApiKey: api.rotate, replaceProxyUrls: vi.fn() }));
vi.mock('@/lib/users', () => ({ setByok: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  listProviderKeys: async () => ({ success: true, keys: api.keys }),
  storeProviderKey: api.store,
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
  /** The "Point your agent at WhiteRoom" card: the one above Provider keys. */
  const card = () => el.querySelector('#provider-keys')!.previousElementSibling!.textContent ?? '';
  return { el, root, type, click, card };
}

beforeEach(() => { api.keys = []; api.store.mockReset(); api.rotate.mockReset(); document.body.innerHTML = ''; });

describe('proxyUrlState', () => {
  it('has nothing to say before a key is connected, or while keys load', () => {
    expect(proxyUrlState('direct', null, [])).toEqual({ kind: 'none' });
    expect(proxyUrlState('direct', null, null)).toEqual({ kind: 'none' });
  });

  it('names the key when the tab has exactly one, and not when it has several', () => {
    expect(proxyUrlState('direct', null, [key()])).toEqual({ kind: 'shown-once', keyHint: '5678' });
    expect(proxyUrlState('direct', null, [key(), key({ provider: 'openai', keyHint: '9999' })])).toEqual({ kind: 'shown-once', keyHint: null });
  });

  it('counts only this tab’s keys, and not one that is off', () => {
    const azure = key({ provider: 'azure-openai', keyHint: 'b7e1' });
    expect(proxyUrlState('direct', null, [azure])).toEqual({ kind: 'none' });
    expect(proxyUrlState('azure', null, [azure, key()])).toEqual({ kind: 'shown-once', keyHint: 'b7e1' });
    expect(proxyUrlState('aws', null, [key({ provider: 'bedrock-mantle', pending: true })])).toEqual({ kind: 'none' });
  });

  it('shows an issued URL only on its own tab', () => {
    const issued = { proxyUrl: URL_ISSUED, keyHint: '5678', provider: 'anthropic' };
    expect(proxyUrlState('direct', issued, [key()])).toEqual({ kind: 'issued', issued });
    expect(proxyUrlState('azure', issued, [key()])).toEqual({ kind: 'none' });
  });

  it('fills a recipe only with an issued URL', () => {
    const line = 'export X=https://proxy.whiteroom.tech/<your-proxy-key>/v1 # https://proxy.whiteroom.tech/<your-proxy-key>';
    const ph = 'https://proxy.whiteroom.tech/<your-proxy-key>';
    expect(withProxyUrl(line, ph, { kind: 'shown-once', keyHint: null })).toBe(line);
    expect(withProxyUrl(line, ph, { kind: 'issued', issued: { proxyUrl: URL_ISSUED, keyHint: '5678', provider: 'openai' } })).toBe(`export X=${URL_ISSUED}/v1 # ${URL_ISSUED}`);
  });
});

describe('Fleet key connect card', () => {
  it('with no key: says how to get the proxy URL, and never calls it a proxy key', async () => {
    const { el, root } = await mount();
    expect(el.textContent).toContain('to get its proxy URL');
    expect(el.textContent).not.toMatch(/proxy key\b/i);
    expect(el.textContent).toContain('export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech/<your-proxy-key>');
    await act(async () => { root.unmount(); });
  });

  it('with a key connected earlier: says the URL was shown once and how to get a new one', async () => {
    api.keys = [key()];
    const { el, root } = await mount();
    expect(el.textContent).toContain('The proxy URL for your key ending 5678 was shown once, when you added it. Lost it? Choose Replace URLs under Provider keys below.');
    expect(el.textContent).not.toContain('to get its proxy URL');
    await act(async () => { root.unmount(); });
  });

  it('right after a key is connected: the setup line carries the real URL', async () => {
    api.store.mockImplementation(async () => { api.keys = [key()]; return { success: true, proxyUrl: URL_ISSUED, provider: 'anthropic', keyHint: '5678' }; });
    const { el, root } = await mount();
    const input = el.querySelector('#provider-keys input[type="password"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-ant-placeholder-not-a-real-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = [...el.querySelectorAll('#provider-keys button')].find((b) => /connect/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { submit.click(); });
    const card = el.querySelector('#provider-keys')!.previousElementSibling!;
    expect(card.textContent).toContain('The proxy URL for your key ending 5678 is filled in below.');
    expect(card.textContent).toContain(`export ANTHROPIC_BASE_URL=${URL_ISSUED}`);
    expect(card.textContent).not.toContain('<your-proxy-key>');
    await act(async () => { root.unmount(); });
  });

  it('names the provider on the filled line’s copy button', async () => {
    api.store.mockImplementation(async () => { api.keys = [key({ provider: 'openai' })]; return { success: true, proxyUrl: URL_ISSUED, provider: 'openai', keyHint: '5678' }; });
    const { el, root, type, click, card } = await mount();
    await type('#provider-keys input[type="password"]', 'sk-placeholder-not-a-real-key');
    await click('Connect');
    expect(card()).toContain(`export OPENAI_BASE_URL=${URL_ISSUED}/v1`);
    expect(el.querySelector('[aria-label="Copy the OpenAI setup line"]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('Azure: both snippets carry the issued URL, and the step no longer says where it will appear', async () => {
    api.keys = [key({ provider: 'azure-openai', keyHint: 'b7e1' })];
    api.store.mockImplementation(async () => ({ success: true, proxyUrl: URL_ISSUED, provider: 'azure-openai', keyHint: 'c0de' }));
    const { root, type, click, card } = await mount();
    await click('Azure OpenAI');
    expect(card()).toContain('The proxy URL for your key ending b7e1 was shown once');
    expect(card()).toContain('Set your proxy URL (shown when you connect your key)');
    await click('+ Add a provider key');
    await type('#provider-keys input[aria-label="Azure endpoint"]', 'https://example-resource.openai.azure.com');
    await type('#provider-keys input[type="password"]', 'azure-placeholder-not-a-real-key');
    await click('Connect');
    expect(card()).toContain('The proxy URL for your key ending c0de is filled in below.');
    expect(card()).toContain(`export AZURE_OPENAI_ENDPOINT=${URL_ISSUED}`);
    expect(card()).toContain(`base_url="${URL_ISSUED}/openai/v1"`);
    expect(card()).not.toContain('<your-proxy-key>');
    expect(card()).not.toContain('(shown when you connect your key)');
    await act(async () => { root.unmount(); });
  });

  it('Bedrock API key: the base URL line and the client snippet carry the issued URL', async () => {
    api.store.mockImplementation(async () => { api.keys = [key({ provider: 'bedrock-mantle' })]; return { success: true, proxyUrl: URL_ISSUED, provider: 'bedrock-mantle', keyHint: '5678' }; });
    const { root, type, click, card } = await mount();
    await click('AWS Bedrock');
    await type('#provider-keys input[aria-label="Region"]', 'us-east-1');
    await type('#provider-keys input[type="password"]', 'bedrock-placeholder-not-a-real-key');
    await click('Connect');
    expect(card()).toContain(`export ANTHROPIC_BASE_URL=${URL_ISSUED}`);
    expect(card()).toContain(`base_url="${URL_ISSUED}"`);
    expect(card()).not.toContain('<your-proxy-key>');
    await act(async () => { root.unmount(); });
  });

  it('after a fleet key rotation: says nothing about URLs whose card is hidden', async () => {
    api.keys = [key()];
    api.rotate.mockResolvedValue({ ok: true, apiKey: 'sk-wr-placeholder-new', proxyKeys: [], disconnected: [] });
    const { el, root, click } = await mount();
    expect(el.textContent).toContain('was shown once');
    await click('Rotate…');
    await click('Rotate fleet key');
    expect(el.querySelector('#provider-keys')).toBeNull();
    expect(el.textContent).not.toContain('was shown once');
    expect(el.textContent).not.toContain('Provider keys below');
    await act(async () => { root.unmount(); });
  });
});

describe('Fleet key: the issued URL is said once', () => {
  const count = (text: string, part: string) => text.split(part).length - 1;

  it('on the key’s own tab: only the setup card carries it, and Provider keys points up to it', async () => {
    api.store.mockImplementation(async () => { api.keys = [key()]; return { success: true, proxyUrl: URL_ISSUED, provider: 'anthropic', keyHint: '5678' }; });
    const { el, root, type, click } = await mount();
    await type('#provider-keys input[type="password"]', 'sk-ant-placeholder-not-a-real-key');
    await click('Connect');
    expect(count(el.textContent ?? '', URL_ISSUED)).toBe(1);
    const keys = el.querySelector('#provider-keys')!;
    expect(keys.textContent).toContain('Key ending 5678 connected. Its proxy URL is in the setup above. It’s shown once, so copy it now.');
    expect([...keys.querySelectorAll('a')].find((a) => a.textContent === 'the setup above')?.getAttribute('href')).toBe('#point');
    expect(el.querySelector('section#point')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('on another tab: Provider keys still shows it, since that tab’s setup can’t', async () => {
    api.store.mockImplementation(async () => { api.keys = [key()]; return { success: true, proxyUrl: URL_ISSUED, provider: 'anthropic', keyHint: '5678' }; });
    const { el, root, type, click, card } = await mount();
    await type('#provider-keys input[type="password"]', 'sk-ant-placeholder-not-a-real-key');
    await click('Connect');
    await click('Azure OpenAI');
    expect(card()).not.toContain(URL_ISSUED);
    expect(el.querySelector('#provider-keys')!.textContent).toContain(`export ANTHROPIC_BASE_URL=${URL_ISSUED}`);
    await act(async () => { root.unmount(); });
  });
});

describe('“proxy URL”, not “proxy key”, where other pages send people to Fleet key', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('empty Home', () => {
    const src = read('../components/home/EmptyHome.tsx');
    expect(src).toContain('Get your proxy URL on <Link');
    expect(src).not.toMatch(/Get a proxy key/);
  });

  it('Sandbox go-live', () => {
    const src = read('../components/sandbox/TestRunFlow.tsx');
    expect(src.match(/with your proxy URL from <Link/g)).toHaveLength(2);
    expect(src).not.toMatch(/your proxy key from/);
  });
});
