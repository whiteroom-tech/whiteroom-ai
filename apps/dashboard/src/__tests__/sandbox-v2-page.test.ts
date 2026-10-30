// @vitest-environment happy-dom
// Sandbox v2's page (components/sandbox/v2): connect, the Sandbox key shown
// once, the status card, Rotate and Reset, and what the page never shows (a
// link to Controls, a stored key). Placeholder keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics', () => ({ analytics: { capture } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SandboxHome, SANDBOX_LEAD } = await import('@/components/sandbox/v2/SandboxHome');
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
  it('not connected: the steps bar on Connect, one lead line, practice tasks, and no link to Controls', async () => {
    await render({ fleet: 'prod-eu' });
    expect(calls()).toEqual([{ url: '/api/sandbox/fleet/status', body: { fleet: 'prod-eu' } }]);
    expect(text()).toContain('Paste your agent’s API key');
    expect(text()).toContain(SANDBOX_LEAD);
    // Key first: no provider cards until asked for.
    expect(document.querySelector('input[name="sandbox-provider"]')).toBeNull();
    expect(button('Using Azure, Foundry or Bedrock?')).toBeDefined();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('1Connect');
    // No numbered panels and no separate lock banner any more.
    expect(text()).not.toMatch(/\d\. (Connect|Point|Sandbox rules|Check)/);
    expect(text()).not.toContain('Sandbox is separate from your live agents');
    expect(text()).toContain('The key your agent already uses. We keep only the last 4 characters.');
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
    // Copy first: the line, a full-size Copy button, then one quiet line instead of a warning.
    expect(text()).toContain('Add this line to your agent’s .env, then run it');
    expect(text()).toContain('This URL is shown only on this visit; you can get a new one any time.');
    expect(text()).not.toContain('Copy this before you leave this page.');
    // Like production: one setting for the agent's .env, then run it as normal.
    expect(text()).toContain(`ANTHROPIC_BASE_URL=${ISSUED.proxyUrl}`);
    expect(document.querySelector('[aria-label="Copy the setting"]')).not.toBeNull();
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

  it('connected, key not on screen: Run your agent names the URL and gets a new one in place', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/rotate')
      ? Response.json({ ...STATUS, ...ISSUED, proxyKey: 'sk-wr-placeholder-rotated', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-rotated' })
      : Response.json(STATUS));
    await render({ fleet: 'prod-eu' });
    expect(text()).toContain('starts with sk-wr-0123456789abcdef...');
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('2Run your agent');
    await click('Lost the URL? Get a new one');
    expect(text()).toContain('Get a new Sandbox URL?');
    await click('Get a new URL');
    expect(calls().find((c) => c.url.endsWith('/rotate'))?.body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(text()).toContain('https://proxy.whiteroom.tech/sk-wr-placeholder-rotated');
    expect(button('Lost the URL? Get a new one')).toBeUndefined();
  });

  it('Copy puts the line on the clipboard, says what to do next, and counts it; the first call after connect is timed', async () => {
    capture.mockClear();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let connectedYet = false;
    bff.mockImplementation(async (url: string) => {
      if (url === '/api/sandbox/fleet/status') return Response.json(connectedYet ? STATUS : { success: true, exists: false });
      if (url.endsWith('/connect')) { connectedYet = true; return Response.json({ ...STATUS, created: true, ...ISSUED }); }
      if (url.startsWith('/api/sandbox/checks/')) {
        return Response.json({ success: true, window: null, checks: [], rules: [], activity: { lastCallAt: connectedYet ? new Date(Date.now() + 2_000).toISOString() : null, callsOutsideWindow24h: 0 } });
      }
      return Response.json(STATUS);
    });
    await render({ fleet: 'prod-eu' });
    await type(document.getElementById('sandbox-v2-key') as HTMLInputElement, PROVIDER_KEY);
    await click('Connect');
    expect(capture).toHaveBeenCalledWith('sandbox_v2_first_call', { seconds_since_connect: expect.any(Number) });
    const copy = document.querySelector<HTMLButtonElement>('button[aria-label="Copy the setting"]')!;
    expect(copy.className).toContain('wr-btn--primary');
    await act(async () => { copy.click(); });
    await flush();
    expect(writeText).toHaveBeenCalledWith(`ANTHROPIC_BASE_URL=${ISSUED.proxyUrl}`);
    expect(text()).toContain('Copied. Now run your agent as you normally do.');
    expect(capture).toHaveBeenCalledWith('sandbox_v2_setting_copied');
    // Never a key or URL in an event.
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(/sk-|https?:/);
  });

  it('Change key in Nothing happening? opens Connect for a different key', async () => {
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['run-help'] });
    const help = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent === 'Nothing happening?')!;
    expect(help.open).toBe(true);
    await act(async () => { [...help.querySelectorAll('button')].find((b) => b.textContent === 'Change key')!.click(); });
    expect(text()).toContain('Connect a different key');
  });

  it('key first: an Anthropic or OpenAI key connects with no provider click, and says which it is', async () => {
    capture.mockClear();
    await render({ fleet: 'prod-eu' });
    const input = document.getElementById('sandbox-v2-key') as HTMLInputElement;
    await type(input, 'sk-placeholder-openai-key-0000');
    expect(text()).toContain('OpenAI key. We keep only the last 4 characters.');
    expect(document.querySelector('input[name="sandbox-provider"]')).toBeNull();
    await click('Connect');
    expect(calls()[1]).toEqual({ url: '/api/sandbox/fleet/connect', body: { fleet: 'prod-eu', provider: 'openai', api_key: 'sk-placeholder-openai-key-0000' } });
    expect(capture).toHaveBeenCalledWith('sandbox_v2_connected', { provider: 'openai', detected: true });
  });

  it('Using Azure, Foundry or Bedrock? opens the choices; a cloud provider sends its endpoint', async () => {
    capture.mockClear();
    await render({ fleet: 'prod-eu' });
    await click('Using Azure, Foundry or Bedrock?');
    expect(document.querySelectorAll('input[name="sandbox-provider"]')).toHaveLength(5);
    expect(button('Using Azure, Foundry or Bedrock?')).toBeUndefined();
    const azure = document.querySelector<HTMLInputElement>('input[name="sandbox-provider"][value="azure-openai"]')!;
    await act(async () => { azure.click(); });
    await type(document.getElementById('sandbox-endpoint') as HTMLInputElement, 'https://placeholder.openai.azure.com');
    await type(document.getElementById('sandbox-v2-key') as HTMLInputElement, 'placeholder-azure-key-0000');
    await click('Connect');
    expect(calls()[1]).toEqual({ url: '/api/sandbox/fleet/connect', body: { fleet: 'prod-eu', provider: 'azure-openai', api_key: 'placeholder-azure-key-0000', endpoint: 'https://placeholder.openai.azure.com' } });
    expect(capture).toHaveBeenCalledWith('sandbox_v2_connected', { provider: 'azure-openai', detected: false });
  });

  it('a key that is neither Anthropic’s nor OpenAI’s opens the choices and asks to pick one; nothing is sent', async () => {
    await render({ fleet: 'prod-eu' });
    await type(document.getElementById('sandbox-v2-key') as HTMLInputElement, 'placeholder-unknown-key-0000');
    expect(document.querySelectorAll('input[name="sandbox-provider"]')).toHaveLength(5);
    expect(text()).toContain('Pick where your agent’s model runs, below.');
    await click('Connect');
    expect(calls()).toHaveLength(1);
    expect(text()).toContain('Pick where your agent’s model runs.');
  });

  it('a WhiteRoom key is named as one as soon as it is pasted', async () => {
    await render({ fleet: 'prod-eu' });
    await type(document.getElementById('sandbox-v2-key') as HTMLInputElement, 'wr_placeholder0000');
    expect(text()).toContain('That’s a WhiteRoom key.');
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

  it('connected: Sandbox settings is closed, holds the facts, and Get a new Sandbox URL confirms then shows the new key once', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/rotate')
      ? Response.json({ ...STATUS, ...ISSUED, proxyKey: 'sk-wr-placeholder-rotated', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-rotated' })
      : Response.json({ ...STATUS, lastCallAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
    await render({ fleet: 'prod-eu' });
    const settings = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent?.startsWith('Sandbox settings'))!;
    expect(settings.open).toBe(false);
    expect(settings.querySelector('summary')?.textContent).toBe('Sandbox settingsAnthropic · last call 5 min ago');
    expect(text()).not.toContain('Connect your provider key');
    // One name per action: no Rotate key, no Use a different key.
    expect(button('Rotate key')).toBeUndefined();
    expect(button('Use a different key')).toBeUndefined();
    await click('Get a new Sandbox URL');
    expect(text()).toContain('Get a new Sandbox URL?');
    await click('Get a new URL');
    const rotate = calls().find((c) => c.url.endsWith('/rotate'));
    expect(rotate?.body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(text()).toContain('sk-wr-placeholder-rotated');
  });

  it('connected: Reset confirms, clears calls and check results, and keeps the rules and key', async () => {
    bff.mockImplementation(async () => Response.json(STATUS));
    await render({ fleet: 'prod-eu' });
    const checkReads = () => calls().filter((c) => c.url.endsWith('/checks/status')).length;
    const before = checkReads();
    await click('Reset Sandbox');
    expect(text()).toContain('This clears its calls and check results. Your rules and key stay, so your agent keeps working.');
    await click('Reset Sandbox');
    expect(calls().find((c) => c.url.endsWith('/reset'))?.body).toEqual({ fleet: 'prod-eu', sandboxFleetId: SANDBOX_ID });
    expect(text()).toContain('Sandbox reset. Its calls and check results are cleared.');
    expect(text()).not.toMatch(/clears? its calls, rules/);
    // Step 4 starts over at once: its checks are read again, not left showing the old report.
    expect(checkReads()).toBeGreaterThan(before);
  });

  it.each([['rotate', 'Get a new Sandbox URL', 'Get a new URL', 409], ['reset', 'Reset Sandbox', 'Reset Sandbox', 404]] as const)('a refused %s shows why and reads the Sandbox again', async (action, label, confirmLabel, code) => {
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
    expect(button('Lost the URL? Get a new one')).toBeDefined();
  });

  it('Change key (connected row) and Change API key (settings) open Connect with Cancel; Cancel goes back', async () => {
    bff.mockImplementation(async () => Response.json(STATUS));
    await render({ fleet: 'prod-eu' });
    expect(text()).toContain('Connected · Anthropic key ending');
    for (const label of ['Change key', 'Change API key']) {
      await click(label);
      expect(text()).toContain('Connect a different key');
      expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('1Connect');
      expect(document.getElementById('sandbox-step')).toBeNull();
      const cancel = [...document.querySelectorAll<HTMLButtonElement>('#sandbox-connect button')].find((b) => b.textContent === 'Cancel')!;
      await act(async () => { cancel.click(); });
      expect(text()).not.toContain('Connect a different key');
      expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('2Run your agent');
    }
  });

  it('on Results, Get a new Sandbox URL shows the new URL above the report', async () => {
    const ENDED = { success: true, window: { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', endedAt: '2026-10-29T10:06:00.000Z', stage: 'done', injectErrors: true, calls: 12 }, checks: [], rules: [] };
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/rotate')) return Response.json({ ...STATUS, ...ISSUED, proxyKey: 'sk-wr-placeholder-rotated', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-rotated' });
      if (url.startsWith('/api/sandbox/checks/')) return Response.json(ENDED);
      return Response.json(STATUS);
    });
    await render({ fleet: 'prod-eu' });
    expect(document.querySelector('#sandbox-step h2')?.textContent).toBe('Results');
    await click('Get a new Sandbox URL');
    await click('Get a new URL');
    expect(document.querySelector('#sandbox-step h2')?.textContent).toBe('Results');
    expect(text()).toContain('https://proxy.whiteroom.tech/sk-wr-placeholder-rotated');
  });

  it('a check that ends on the page: Results, with focus on the verdict (not the card heading)', async () => {
    const win = { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', injectErrors: true, calls: 12 };
    let ended = false;
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/checks/stop')) ended = true;
      if (url.startsWith('/api/sandbox/checks/')) return Response.json({ success: true, window: { ...win, endedAt: ended ? '2026-10-29T10:06:00.000Z' : null, stage: ended ? 'done' : 'observe' }, checks: [], rules: [] });
      return Response.json(STATUS);
    });
    await render({ fleet: 'prod-eu' });
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('2Run your agent');
    await click('Finish now');
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('3Results');
    expect(document.activeElement?.tagName).toBe('H3');
  });

  it('Reset on Results goes back to Run your agent once the checks are read again', async () => {
    // First the Sandbox with an ended check (Results).
    bff.mockImplementation(async (url: string) => (url.startsWith('/api/sandbox/checks/')
      ? Response.json({ success: true, window: { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', endedAt: '2026-10-29T10:06:00.000Z', stage: 'done', injectErrors: true, calls: 12 }, checks: [], rules: [] })
      : Response.json(STATUS)));
    await render({ fleet: 'prod-eu' });
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('3Results');
    // Answer the reset, but hold the next checks read: the steps bar moves at once anyway.
    let release = () => {};
    bff.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/sandbox/checks/')) { await new Promise<void>((r) => { release = r; }); return Response.json({ success: true, window: null, checks: [], rules: [] }); }
      return Response.json(STATUS);
    });
    await click('Reset Sandbox');
    await click('Reset Sandbox');
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('2Run your agent');
    await act(async () => { release(); });
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('2Run your agent');
  });

  it('focus follows the step: Change key focuses Connect, Cancel focuses the step card again', async () => {
    bff.mockImplementation(async () => Response.json(STATUS));
    await render({ fleet: 'prod-eu' });
    // Not on first load.
    expect(document.activeElement?.tagName).not.toBe('H2');
    await click('Change key');
    expect(document.activeElement?.textContent).toBe('Connect a different key');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('#sandbox-connect button')].find((b) => b.textContent === 'Cancel')!;
    await act(async () => { cancel.click(); });
    expect(document.activeElement?.textContent).toBe('Run your agent');
  });

  it('Results is the step once the check has ended; the practice footer shows on Connect only', async () => {
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-report'] });
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('3Results');
    expect(document.querySelector('#sandbox-step h2')?.textContent).toBe('Results');
    expect(text()).not.toContain('Want scripted tasks with known answers?');
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['checks-observe'] });
    expect(document.querySelector('#sandbox-step h2')?.textContent).toBe('Run your agent');
    expect(text()).not.toContain('Want scripted tasks with known answers?');
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
    // One current step, except while the Sandbox hasn't loaded (an error).
    expect(document.querySelectorAll('[aria-current="step"]').length).toBe(SANDBOX_V2_STATES[state].status ? 1 : 0);
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
    expect(keptUntilText(null, now)).toBe('Kept for 7 days after your agent’s last call');
  });

  it('checks a key against its provider', () => {
    expect(connectCheck('anthropic', PROVIDER_KEY)).toEqual({ ok: true, request: { api_key: PROVIDER_KEY, provider: 'anthropic' } });
    expect(connectCheck('openai', 'sk-proj-placeholder').ok).toBe(true);
    expect(connectCheck('bedrock-mantle', 'placeholder-bedrock-key', 'us-east-1').ok).toBe(true);
    expect(connectCheck('anthropic', 'has space in it').ok).toBe(false);
    expect(connectCheck('nope', PROVIDER_KEY).ok).toBe(false);
  });
});
