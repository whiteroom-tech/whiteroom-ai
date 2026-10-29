// @vitest-environment happy-dom
// Sandbox v2's page (components/sandbox/v2): connect, the Sandbox key shown
// once, the status card, Rotate and Reset, and what the page never shows (a
// link to Controls, a stored key). Placeholder keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SandboxHome, SANDBOX_SEPARATE } = await import('@/components/sandbox/v2/SandboxHome');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const { connectCheck, keptUntilText, lastCallText, pointLine, sandboxSetting } = await import('@/lib/sandbox/fleet');

const PROVIDER_KEY = 'sk-ant-placeholder-not-a-real-key-WXYZ';
const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
const STATUS = {
  success: true, exists: true, sandboxFleetId: SANDBOX_ID, createdAt: '2026-10-29T10:00:00.000Z', lastCallAt: null, expiresAt: '2026-11-12T10:00:00.000Z',
  key: { prefix: 'sk-wr-0123456789abcdef...', provider: 'anthropic', keyHint: 'WXYZ' },
};
const ISSUED = { proxyKey: 'sk-wr-placeholder-proxy-key', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-proxy-key', provider: 'anthropic', keyHint: 'WXYZ' };

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
let root: Root;
let el: HTMLDivElement;
const text = () => document.body.textContent ?? '';
const render = async (props: Parameters<typeof SandboxHome>[0]) => {
  await act(async () => { root.render(h(SandboxHome, props)); });
  await flush();
};
/** The last button with this name: a dialog's confirm comes after the button that opened it. */
const button = (name: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === name).pop() as HTMLButtonElement | undefined;
const click = async (name: string) => { await act(async () => { button(name)!.click(); }); await flush(); };
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** The BFF: status answers `status`; connect / rotate / reset answer as the engine would. */
const bff = vi.fn();
beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  bff.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) return Response.json({ success: true, exists: false });
    if (url.endsWith('/connect')) return Response.json({ ...STATUS, created: true, ...ISSUED });
    if (url.endsWith('/rotate')) return Response.json({ ...STATUS, ...ISSUED, proxyKey: 'sk-wr-placeholder-rotated', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-rotated' });
    return Response.json(STATUS);
  });
  vi.stubGlobal('fetch', bff);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const calls = () => bff.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

describe('Sandbox v2 page', () => {
  it('not connected: step 1, the isolation line, practice tasks, and no link to Controls', async () => {
    await render({ fleet: 'prod-eu' });
    expect(calls()).toEqual([{ url: '/api/sandbox/fleet/status', body: { fleet: 'prod-eu' } }]);
    expect(text()).toContain('1. Connect your provider key');
    expect(text()).toContain(SANDBOX_SEPARATE);
    expect(text()).toContain('Paste the key your agent uses. We keep only its last 4 characters.');
    const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('/sandbox/practice');
    expect(links.some((href) => href?.startsWith('/controls'))).toBe(false);
  });

  it('connect sends the typed key once, then shows the Sandbox URL and key with the exact line', async () => {
    await render({ fleet: 'prod-eu' });
    const input = document.getElementById('sandbox-v2-key') as HTMLInputElement;
    await type(input, PROVIDER_KEY);
    await click('Connect');
    expect(calls()[1]).toEqual({ url: '/api/sandbox/fleet/connect', body: { fleet: 'prod-eu', provider: 'anthropic', api_key: PROVIDER_KEY } });
    expect(text()).toContain('We can’t show your Sandbox URL again after that.');
    // Like production: one setting for the agent's .env, then run it as normal.
    expect(text()).toContain(`ANTHROPIC_BASE_URL=${ISSUED.proxyUrl}`);
    expect(document.querySelector('[aria-label="Copy the setting"]')).not.toBeNull();
    expect(text()).toContain('Checks start on its first call.');
    expect(document.getElementById('sandbox-start-command')).toBeNull();
    expect(document.querySelector('[aria-label="Copy the Sandbox URL"]')).not.toBeNull();
    expect(text()).toContain(ISSUED.proxyKey);
    expect(document.querySelector('[aria-label="Copy the Sandbox key"]')).not.toBeNull();
    // The status card, and the provider key nowhere on the page or in storage.
    expect(text()).toContain('key ending WXYZ');
    expect(text()).toContain('No calls yet');
    expect(text()).toContain('renewed each time your agent calls');
    expect(document.body.innerHTML).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify({ ...localStorage })).not.toContain('sk-wr-placeholder');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('sk-wr-placeholder');
    // It stays on screen for the visit: nothing to dismiss.
    expect(button('I’ve copied it')).toBeUndefined();
  });

  it('connected, key not on screen: step 2 names the key and gets a new URL in place', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/rotate')
      ? Response.json({ ...STATUS, ...ISSUED, proxyKey: 'sk-wr-placeholder-rotated', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-rotated' })
      : Response.json(STATUS));
    await render({ fleet: 'prod-eu' });
    expect(text()).toContain('starts with sk-wr-0123456789abcdef...');
    await click('Get a new Sandbox URL');
    expect(text()).toContain('Get a new Sandbox URL?');
    await click('Get a new URL');
    expect(calls().find((c) => c.url.endsWith('/rotate'))?.body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(text()).toContain('https://proxy.whiteroom.tech/sk-wr-placeholder-rotated');
    expect(button('Get a new Sandbox URL')).toBeUndefined();
  });

  it('refuses a mismatched key in the browser, before anything is sent', async () => {
    await render({ fleet: 'prod-eu' });
    await type(document.getElementById('sandbox-v2-key') as HTMLInputElement, 'sk-wr-placeholder-proxy-key');
    await click('Connect');
    expect(calls()).toHaveLength(1);
    expect(text()).toContain('That’s a WhiteRoom key.');
  });

  it('shows the engine’s refusal on connect', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/status')
      ? Response.json({ success: true, exists: false })
      : Response.json({ error: 'Invalid endpoint: not allowed.' }, { status: 400 }));
    await render({ fleet: 'prod-eu' });
    await type(document.getElementById('sandbox-v2-key') as HTMLInputElement, PROVIDER_KEY);
    await click('Connect');
    expect(text()).toContain('Invalid endpoint: not allowed.');
    expect((document.getElementById('sandbox-v2-key') as HTMLInputElement).value).toBe('');
  });

  it('connected: Rotate confirms, then shows the new key once', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/rotate')
      ? Response.json({ ...STATUS, ...ISSUED, proxyKey: 'sk-wr-placeholder-rotated', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-rotated' })
      : Response.json({ ...STATUS, lastCallAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
    await render({ fleet: 'prod-eu' });
    expect(text()).toContain('Your Sandbox');
    expect(text()).toContain('5 min ago');
    expect(text()).not.toContain('1. Connect your provider key');
    await click('Rotate key');
    expect(text()).toContain('Get a new Sandbox URL?');
    await click('Get a new URL');
    const rotate = calls().find((c) => c.url.endsWith('/rotate'));
    expect(rotate?.body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(text()).toContain('sk-wr-placeholder-rotated');
  });

  it('connected: Reset confirms, clears calls and rules, and keeps the key', async () => {
    bff.mockImplementation(async () => Response.json(STATUS));
    await render({ fleet: 'prod-eu' });
    await click('Reset Sandbox');
    expect(text()).toContain('This clears its calls and rules. Your key stays the same');
    await click('Reset Sandbox');
    expect(calls().find((c) => c.url.endsWith('/reset'))?.body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(text()).toContain('Sandbox reset.');
  });

  it.each([['rotate', 'Rotate key', 'Get a new URL', 409], ['reset', 'Reset Sandbox', 'Reset Sandbox', 404]] as const)('a refused %s shows why and reads the Sandbox again', async (action, label, confirmLabel, code) => {
    bff.mockImplementation(async (url: string) => url.endsWith(`/${action}`)
      ? Response.json({ error: 'Your Sandbox changed since this page loaded.' }, { status: code })
      : Response.json(STATUS));
    await render({ fleet: 'prod-eu' });
    const before = calls().filter((c) => c.url.endsWith('/status')).length;
    await click(label);
    await click(confirmLabel);
    expect(text()).toContain('Your Sandbox changed since this page loaded.');
    expect(calls().filter((c) => c.url.endsWith('/status')).length).toBeGreaterThan(before);
  });

  it('a Sandbox changed elsewhere takes the key on screen with it', async () => {
    let changed = false;
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/rotate')) return Response.json({ ...STATUS, ...ISSUED, proxyKey: 'sk-wr-placeholder-rotated', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-rotated' });
      if (url.endsWith('/reset')) { changed = true; return Response.json({ error: 'Your Sandbox changed since this page loaded.' }, { status: 409 }); }
      return Response.json(changed ? { ...STATUS, sandboxFleetId: 'sandbox-11111111-1111-4111-8111-111111111111' } : STATUS);
    });
    await render({ fleet: 'prod-eu' });
    await click('Get a new Sandbox URL');
    await click('Get a new URL');
    expect(text()).toContain('sk-wr-placeholder-rotated');
    await click('Reset Sandbox');
    await click('Reset Sandbox');
    expect(text()).toContain('Your Sandbox changed since this page loaded.');
    expect(text()).not.toContain('sk-wr-placeholder-rotated');
  });

  it('a step that finds the Sandbox changed (onStale) also takes the key on screen with it', async () => {
    // Connected here, but the rules read finds this Sandbox gone: it was reconnected in another tab.
    let connected = false;
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/connect')) { connected = true; return Response.json({ ...STATUS, created: true, ...ISSUED }); }
      if (url.endsWith('/status')) return Response.json(connected ? { ...STATUS, sandboxFleetId: 'sandbox-11111111-1111-4111-8111-111111111111' } : { success: true, exists: false });
      if (url.endsWith('/rules/list')) return Response.json({ error: 'Your Sandbox changed since this page loaded.' }, { status: 409 });
      return Response.json(STATUS);
    });
    await render({ fleet: 'prod-eu' });
    await type(document.getElementById('sandbox-v2-key') as HTMLInputElement, PROVIDER_KEY);
    await click('Connect');
    expect(calls().some((c) => c.url.endsWith('/rules/list'))).toBe(true);
    expect(text()).not.toContain(ISSUED.proxyKey);
    expect(button('Get a new Sandbox URL')).toBeDefined();
  });

  it('an unreadable status answer is an error with Try again, not the older destination', async () => {
    bff.mockImplementation(async () => Response.json({ success: true, nonsense: 1 }));
    const onUnavailable = vi.fn();
    await render({ fleet: 'prod-eu', onUnavailable });
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(button('Try again')).toBeDefined();
  });

  it('no Sandbox v2 on the engine: hands back to /sandbox’s older destination', async () => {
    bff.mockImplementation(async () => Response.json({ error: 'Sandbox isn’t available yet.', reason: 'sandbox_fleet_unavailable' }, { status: 404 }));
    const onUnavailable = vi.fn();
    await render({ fleet: 'prod-eu', onUnavailable });
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('a failed status read says so and offers Try again', async () => {
    bff.mockImplementation(async () => Response.json({ error: 'The Sandbox couldn’t do that right now. Try again in a moment.' }, { status: 503 }));
    await render({ fleet: 'prod-eu' });
    expect(text()).toContain('The Sandbox couldn’t do that right now.');
    expect(button('Try again')).toBeDefined();
  });

  it.each(Object.keys(SANDBOX_V2_STATES) as (keyof typeof SANDBOX_V2_STATES)[])('/dev/sandbox-v2 %s renders without fetching or linking to Controls', async (state) => {
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES[state] });
    expect(bff).not.toHaveBeenCalled();
    expect(text()).toContain(SANDBOX_SEPARATE);
    expect(document.body.innerHTML).not.toContain('href="/controls');
  });

  it('/dev/sandbox-v2 openai shows the /v1 line', async () => {
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES.openai });
    expect(text()).toMatch(/OPENAI_BASE_URL=https:\/\/proxy\.whiteroom\.tech\/sk-wr-[\w-]+\/v1/);
  });
});

describe('Sandbox v2 wording and checks', () => {
  it('the setting for each provider', () => {
    expect(sandboxSetting('anthropic', 'https://proxy.example/sk-wr-x/')).toEqual({ name: 'ANTHROPIC_BASE_URL', value: 'https://proxy.example/sk-wr-x' });
    expect(sandboxSetting('openai', 'https://proxy.example/sk-wr-x')).toEqual({ name: 'OPENAI_BASE_URL', value: 'https://proxy.example/sk-wr-x/v1' });
    expect(sandboxSetting('azure-openai', 'https://proxy.example/sk-wr-x')).toEqual({ name: 'AZURE_OPENAI_ENDPOINT', value: 'https://proxy.example/sk-wr-x' });
  });

  it('points the agent the way production does', () => {
    expect(pointLine('anthropic', 'https://proxy.example/sk-wr-x/')).toBe('export ANTHROPIC_BASE_URL=https://proxy.example/sk-wr-x');
    expect(pointLine('openai', 'https://proxy.example/sk-wr-x')).toBe('export OPENAI_BASE_URL=https://proxy.example/sk-wr-x/v1');
    expect(pointLine('azure-openai', 'https://proxy.example/sk-wr-x')).toBe('export AZURE_OPENAI_ENDPOINT=https://proxy.example/sk-wr-x');
  });

  it('says when the agent last called and how long the Sandbox is kept', () => {
    const now = Date.parse('2026-10-29T15:00:00Z');
    expect(lastCallText(null, now)).toBe('No calls yet');
    expect(lastCallText('2026-10-29T14:55:00Z', now)).toBe('5 min ago');
    expect(keptUntilText('2026-11-12T15:00:00Z', now)).toMatch(/^Kept until Nov 1[23] — renewed each time your agent calls$/);
    expect(keptUntilText(null, now)).toBe('Kept for 14 days after your agent’s last call');
  });

  it('checks a key against its provider', () => {
    expect(connectCheck('anthropic', PROVIDER_KEY)).toEqual({ ok: true, request: { api_key: PROVIDER_KEY, provider: 'anthropic' } });
    expect(connectCheck('openai', 'sk-proj-placeholder').ok).toBe(true);
    expect(connectCheck('bedrock-mantle', 'placeholder-bedrock-key', 'us-east-1').ok).toBe(true);
    expect(connectCheck('anthropic', 'has space in it').ok).toBe(false);
    expect(connectCheck('nope', PROVIDER_KEY).ok).toBe(false);
  });
});
