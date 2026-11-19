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
const api = vi.hoisted(() => ({ keys: [] as unknown[], store: vi.fn(), rotate: vi.fn(), replace: vi.fn() }));

vi.mock('@/auth', () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock('@/lib/owner-credentials', () => ({ rotateApiKey: api.rotate, replaceProxyUrls: api.replace }));
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
  /** The setup card: what to do, Provider keys, then the line a key gives back. */
  const card = () => el.querySelector('section#point')!.textContent ?? '';
  /** The card's text after the Provider keys section: the setup the key gives back. */
  const after = () => card().split(el.querySelector('#provider-keys')!.textContent ?? '\u0000')[1] ?? '';
  return { el, root, type, click, card, after };
}

beforeEach(() => { api.keys = []; api.store.mockReset(); api.rotate.mockReset(); api.replace.mockReset(); document.body.innerHTML = ''; });

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

const PLACEHOLDER = '<your-proxy-key>';
const count = (text: string, part: string) => text.split(part).length - 1;

describe('Fleet key: one setup card', () => {
  it('holds Provider keys inside it, above the fleet key card', async () => {
    const { el, root } = await mount();
    const point = el.querySelector('section#point')!;
    expect(point.querySelector('section#provider-keys')).not.toBeNull();
    const cards = [...el.querySelectorAll('.wr-scard__title')].map((h) => h.textContent);
    expect(cards).toEqual(['Point your agent at WhiteRoom', 'Your WhiteRoom fleet key']);
    await act(async () => { root.unmount(); });
  });

  it('with no key: says what to do, with no placeholder line and no “proxy key”', async () => {
    const { el, root, card } = await mount();
    expect(card()).toContain('Connect your Anthropic or OpenAI key under Provider keys below. You get back one line to set where your agent runs.');
    expect(el.textContent).not.toContain(PLACEHOLDER);
    expect(el.textContent).not.toMatch(/proxy key\b/i);
    await act(async () => { root.unmount(); });
  });

  it('with a key connected earlier: says the URL was shown once, with no placeholder line', async () => {
    api.keys = [key()];
    const { el, root, after } = await mount();
    expect(after()).toContain('The proxy URL for your key ending 5678 was shown once, when you added it. Lost it? Choose Replace URLs under Provider keys.');
    expect(el.textContent).not.toContain(PLACEHOLDER);
    await act(async () => { root.unmount(); });
  });

  it('right after a key is connected: one line with the real URL, under the keys', async () => {
    api.store.mockImplementation(async () => { api.keys = [key({ provider: 'openai' })]; return { success: true, proxyUrl: URL_ISSUED, provider: 'openai', keyHint: '5678' }; });
    const { el, root, type, click, after } = await mount();
    await type('#provider-keys input[type="password"]', 'sk-placeholder-not-a-real-key');
    await click('Connect');
    expect(after()).toContain('Key ending 5678 connected. Set this where your agent runs. It’s shown once, so copy it now.');
    expect(after()).toContain(`export OPENAI_BASE_URL=${URL_ISSUED}/v1`);
    expect(count(el.textContent ?? '', URL_ISSUED)).toBe(1);
    expect(el.querySelector('[aria-label="Copy the OpenAI setup line"]')).not.toBeNull();
    expect(count(el.textContent ?? '', 'Agents without a system prompt')).toBe(1);
    await act(async () => { root.unmount(); });
  });

  it.each([
    ['Azure OpenAI', 'azure-openai', 'Azure endpoint', 'https://example-resource.openai.azure.com', 'azure-placeholder-not-a-real-key', [`export AZURE_OPENAI_ENDPOINT=${URL_ISSUED}`, `base_url="${URL_ISSUED}/openai/v1"`]],
    ['AWS Bedrock', 'bedrock-mantle', 'Region', 'us-east-1', 'bedrock-placeholder-not-a-real-key', [`export ANTHROPIC_BASE_URL=${URL_ISSUED}`, `base_url="${URL_ISSUED}"`]],
  ])('%s: the client lines are folded until a key is connected, then open with the real URL', async (tabLabel, provider, field, fieldValue, secret, lines) => {
    api.store.mockImplementation(async () => { api.keys = [key({ provider })]; return { success: true, proxyUrl: URL_ISSUED, provider, keyHint: '5678' }; });
    const { el, root, type, click, after } = await mount();
    await click(tabLabel);
    const folded = el.querySelector('section#point details');
    expect(folded?.querySelector('summary')?.textContent).toBe('Client setup');
    expect(folded?.hasAttribute('open')).toBe(false);
    expect(folded?.textContent).toContain('Set your proxy URL (shown when you connect your key)');
    await type(`#provider-keys input[aria-label="${field}"]`, fieldValue);
    await type('#provider-keys input[type="password"]', secret);
    await click('Connect');
    for (const line of lines) expect(after()).toContain(line);
    expect(el.textContent).not.toContain(PLACEHOLDER);
    expect(el.textContent).not.toContain('(shown when you connect your key)');
    expect(el.querySelector('#provider-keys')!.textContent).not.toContain(URL_ISSUED);
    expect(count(el.textContent ?? '', 'Agents without a system prompt')).toBe(1);
    expect(count(after(), 'X-WhiteRoom-Key header')).toBe(1);
    await act(async () => { root.unmount(); });
  });

  it('from another tab: Provider keys shows the issued URL, since that tab’s setup can’t', async () => {
    api.store.mockImplementation(async () => { api.keys = [key()]; return { success: true, proxyUrl: URL_ISSUED, provider: 'anthropic', keyHint: '5678' }; });
    const { el, root, type, click, after } = await mount();
    await type('#provider-keys input[type="password"]', 'sk-ant-placeholder-not-a-real-key');
    await click('Connect');
    await click('Azure OpenAI');
    expect(after()).not.toContain(URL_ISSUED);
    expect(el.querySelector('#provider-keys')!.textContent).toContain(`export ANTHROPIC_BASE_URL=${URL_ISSUED}`);
    await click('Anthropic or OpenAI');
    expect(after()).toContain(`export ANTHROPIC_BASE_URL=${URL_ISSUED}`);
    expect(count(el.textContent ?? '', URL_ISSUED)).toBe(1);
    await act(async () => { root.unmount(); });
  });

  it('Bedrock cross-account role: its own card replaces Provider keys, and an issued URL survives the trip', async () => {
    api.store.mockImplementation(async () => { api.keys = [key({ provider: 'bedrock-mantle' })]; return { success: true, proxyUrl: URL_ISSUED, provider: 'bedrock-mantle', keyHint: '5678' }; });
    const { el, root, type, click, after } = await mount();
    await click('AWS Bedrock');
    await type('#provider-keys input[aria-label="Region"]', 'us-east-1');
    await type('#provider-keys input[type="password"]', 'bedrock-placeholder-not-a-real-key');
    await click('Connect');
    await click('Cross-account role (any model)');
    expect(el.querySelector('#provider-keys')!.closest('[hidden]')).not.toBeNull();
    expect(el.textContent).not.toContain(URL_ISSUED);
    expect([...el.querySelectorAll('.wr-scard__title')].map((h) => h.textContent)).toEqual(['Point your agent at WhiteRoom', 'Cross-account role', 'Your WhiteRoom fleet key']);
    await click('API key (Claude)');
    expect(after()).toContain(`export ANTHROPIC_BASE_URL=${URL_ISSUED}`);
    await act(async () => { root.unmount(); });
  });

  it('Bedrock cross-account role: new URLs from Replace URLs, shown once, are still there on the way back', async () => {
    api.keys = [key()];
    api.replace.mockResolvedValue({ ok: true, proxyKeys: [{ prefix: 'sk-wr-0000000000000000', provider: 'anthropic', keyHint: '5678', cloudIdentity: false, wrKey: 'sk-wr-placeholder-replaced' }], disconnected: [] });
    const { el, root, click } = await mount();
    await click('Replace URLs…');
    await click('Replace URLs');
    const section = el.querySelector('#provider-keys')!;
    expect(section.textContent).toContain('sk-wr-placeholder-replaced');
    await click('AWS Bedrock');
    await click('Cross-account role (any model)');
    await click('API key (Claude)');
    expect(el.querySelector('#provider-keys')).toBe(section);
    expect(section.closest('[hidden]')).toBeNull();
    expect(section.textContent).toContain('sk-wr-placeholder-replaced');
    await act(async () => { root.unmount(); });
  });

  it('keeps the Provider keys section mounted across tabs, so a shown-once result isn’t lost', async () => {
    api.keys = [key()];
    const { el, root, click } = await mount();
    const before = el.querySelector('#provider-keys');
    await click('Azure OpenAI');
    expect(el.querySelector('#provider-keys')).toBe(before);
    await act(async () => { root.unmount(); });
  });

  it('after a fleet key rotation: the keys are hidden and nothing is said about their URLs', async () => {
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
