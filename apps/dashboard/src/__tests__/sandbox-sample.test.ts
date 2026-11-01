// @vitest-environment happy-dom
// The Sandbox sample agent (spec sandbox-sample-agent §5): offered on Connect
// before a key is connected; while it runs there's nothing to set up; its
// report leads to connecting your own key, which replaces it. The BFF sends
// only the fleet. Placeholder values only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics', () => ({ analytics: { capture } }));
const auth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => auth() }));
vi.mock('@/lib/control-auth', () => ({ CONTROL_SECRET_HEADER: 'x-wr-dashboard-secret', CONTROL_USER_HEADER: 'x-wr-dashboard-user', controlAccessError: async () => null }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: async () => 'wr_placeholder_fleet_token', tokenFromUserFleets: async () => null }));
vi.mock('@/lib/origin-check', () => ({ checkSameOrigin: async () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SandboxHome, SAMPLE_OFFER, SAMPLE_REPLACE } = await import('@/components/sandbox/v2/SandboxHome');
const { SAMPLE_NOTE, SAMPLE_RUNNING } = await import('@/components/sandbox/v2/SandboxChecks');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const { statusOf, activityLine, stageLine } = await import('@/lib/sandbox/fleet').then(async (f) => ({ ...f, ...(await import('@/lib/sandbox/checks')) }));
const { POST } = await import('@/app/api/sandbox/fleet/[action]/route');

const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
const SAMPLE = {
  success: true, exists: true, sandboxFleetId: SANDBOX_ID, createdAt: '2026-10-29T10:00:00.000Z', lastCallAt: null, expiresAt: '2026-11-05T10:00:00.000Z',
  key: { prefix: 'sk-wr-0123456789abcdef...', provider: 'anthropic', keyHint: 'none' }, sample: true, sampleRunning: true, sampleAvailable: false,
};
const OWN = { ...SAMPLE, key: { ...SAMPLE.key, keyHint: 'WXYZ' }, sample: false, sampleRunning: false };
const ISSUED = { proxyKey: 'sk-wr-placeholder-proxy-key', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-placeholder-proxy-key', provider: 'anthropic', keyHint: 'WXYZ' };
const WINDOW = { id: 'chk_1', startedAt: '2026-10-29T10:00:00.000Z', endedAt: null, stage: 'observe', injectErrors: true, calls: 3 };

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
let root: Root;
const text = () => document.body.textContent ?? '';
const render = async (props: Parameters<typeof SandboxHome>[0]) => {
  await act(async () => { root.render(h(SandboxHome, props)); });
  await flush();
};
const button = (name: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === name).pop() as HTMLButtonElement | undefined;
const click = async (name: string) => { await act(async () => { button(name)!.click(); }); await flush(); };

const bff = vi.fn();
const calls = () => bff.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));
beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  capture.mockReset();
  bff.mockReset();
  vi.stubGlobal('fetch', bff);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Sandbox sample agent: the page', () => {
  it('Connect offers the sample when the engine says it can run; one press starts it and the run step shows, with nothing to set up', async () => {
    let started = false;
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/fleet/status')) return Response.json(started ? SAMPLE : { success: true, exists: false, sampleAvailable: true });
      if (url.endsWith('/fleet/sample')) { started = true; return Response.json(SAMPLE); }
      if (url.startsWith('/api/sandbox/checks/')) return Response.json({ success: true, window: WINDOW, checks: [], rules: [], activity: { lastCallAt: new Date().toISOString(), callsOutsideWindow24h: 0 } });
      return Response.json(SAMPLE);
    });
    await render({ fleet: 'prod-eu' });
    expect(text()).toContain('No key handy?');
    expect(text()).toContain(SAMPLE_OFFER);
    await click('Try a sample agent');
    expect(calls().find((c) => c.url.endsWith('/fleet/sample'))?.body).toEqual({ fleet: 'prod-eu' });
    expect(capture).toHaveBeenCalledWith('sandbox_v2_sample_started');
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('2Run your agent');
    expect(document.querySelector('#sandbox-step h2')?.textContent).toBe('Our sample agent is running');
    expect(text()).toContain(SAMPLE_RUNNING);
    expect(text()).toContain('Sample agent · run by WhiteRoom');
    expect(text()).toContain('The sample agent is calling the Sandbox');
    // Nothing of the owner's to set up or fix.
    expect(text()).not.toContain('.env');
    expect(text()).not.toContain('Nothing happening?');
    expect(text()).not.toContain('key ending');
    expect(text()).not.toContain('Run your agent as you normally do');
    expect(button('Get a new Sandbox URL')).toBeUndefined();
  });

  it('not offered once a key of the owner’s is connected, nor when the engine says no', async () => {
    bff.mockImplementation(async (url: string) => url.startsWith('/api/sandbox/checks/') ? Response.json({ success: true, window: null, checks: [], rules: [] }) : Response.json({ ...OWN, sampleAvailable: false }));
    await render({ fleet: 'prod-eu' });
    await click('Change key');
    expect(text()).not.toContain('No key handy?');
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    bff.mockImplementation(async () => Response.json({ success: true, exists: false }));
    await render({ fleet: 'prod-eu' });
    expect(text()).toContain('Paste your agent’s API key');
    expect(text()).not.toContain('No key handy?');
  });

  it('a refusal for the day’s limit replaces the button with the engine’s line, and is counted by reason only', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/fleet/sample')
      ? Response.json({ error: 'You’ve used today’s sample runs. Try again tomorrow, or use your own key.', reason: 'limit_fleet' }, { status: 429 })
      : Response.json({ success: true, exists: false, sampleAvailable: true }));
    await render({ fleet: 'prod-eu' });
    await click('Try a sample agent');
    expect(text()).toContain('You’ve used today’s sample runs. Try again tomorrow, or use your own key.');
    expect(button('Try a sample agent')).toBeUndefined();
    expect(capture).toHaveBeenCalledWith('sandbox_v2_sample_refused', { reason: 'limit_fleet' });
  });

  it('another refusal keeps the button and says why', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/fleet/sample')
      ? Response.json({ error: 'Sample runs are busy right now. Try again in a minute.', reason: 'busy' }, { status: 429 })
      : Response.json({ success: true, exists: false, sampleAvailable: true }));
    await render({ fleet: 'prod-eu' });
    await click('Try a sample agent');
    expect(text()).toContain('Sample runs are busy right now. Try again in a minute.');
    expect(button('Try a sample agent')).toBeDefined();
    expect(capture).toHaveBeenCalledWith('sandbox_v2_sample_refused', { reason: 'busy' });
  });

  it('refused because a key of the owner’s is connected: reads the Sandbox again; no answer at all or an unnamed refusal is counted as network or engine', async () => {
    let answer: () => Response | Promise<Response> = () => Response.json({ error: 'This Sandbox has your own key connected, so the sample can’t run in it.', reason: 'connected' }, { status: 409 });
    let connectedNow = false;
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/fleet/sample')) { connectedNow = true; return answer(); }
      if (url.startsWith('/api/sandbox/checks/')) return Response.json({ success: true, window: null, checks: [], rules: [] });
      return Response.json(connectedNow ? { ...OWN, sampleAvailable: false } : { success: true, exists: false, sampleAvailable: true });
    });
    await render({ fleet: 'prod-eu' });
    await click('Try a sample agent');
    expect(capture).toHaveBeenCalledWith('sandbox_v2_sample_refused', { reason: 'connected' });
    expect(calls().filter((c) => c.url.endsWith('/fleet/status'))).toHaveLength(2);
    expect(text()).toContain('key ending WXYZ');

    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    connectedNow = false;
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/fleet/sample')) return answer();
      return Response.json({ success: true, exists: false, sampleAvailable: true });
    });
    await render({ fleet: 'prod-eu' });
    answer = () => { throw new TypeError('Failed to fetch'); };
    await click('Try a sample agent');
    expect(capture).toHaveBeenCalledWith('sandbox_v2_sample_refused', { reason: 'network' });
    answer = () => Response.json({ error: 'The Sandbox couldn’t do that right now. Try again in a moment.' }, { status: 502 });
    await click('Try a sample agent');
    expect(capture).toHaveBeenCalledWith('sandbox_v2_sample_refused', { reason: 'engine' });
  });

  it('Reset clears a limit refusal: Run the sample again comes back', async () => {
    const DONE = { success: true, window: { ...WINDOW, endedAt: '2026-10-29T10:02:00.000Z', stage: 'done' }, checks: [], rules: [] };
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/fleet/sample')) return Response.json({ error: 'You’ve used today’s sample runs. Try again tomorrow, or use your own key.', reason: 'limit_fleet' }, { status: 429 });
      if (url.startsWith('/api/sandbox/checks/')) return Response.json(DONE);
      return Response.json({ ...SAMPLE, sampleRunning: false });
    });
    await render({ fleet: 'prod-eu' });
    await click('Run the sample again');
    expect(button('Run the sample again')).toBeUndefined();
    await click('Reset Sandbox');
    await click('Reset Sandbox');
    expect(text()).not.toContain('You’ve used today’s sample runs.');
    expect(button('Run the sample again')).toBeDefined();
  });

  it('a sample report that finishes on the page is counted with sample: true', async () => {
    let ended = false;
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/checks/stop')) ended = true;
      if (url.startsWith('/api/sandbox/checks/')) return Response.json({ success: true, window: { ...WINDOW, endedAt: ended ? '2026-10-29T10:02:00.000Z' : null, stage: ended ? 'done' : 'observe' }, checks: [], rules: [] });
      return Response.json(SAMPLE);
    });
    await render({ fleet: 'prod-eu' });
    await click('Finish now');
    expect(capture).toHaveBeenCalledWith('sandbox_v2_report', expect.objectContaining({ sample: true }));
  });

  it('the sample’s report: its note, Check your own agent first, Run the sample again, and no practice line or Check again', async () => {
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['sample-results'] });
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('3Results');
    expect(text()).toContain(`This was our sample agent. ${SAMPLE_NOTE}`);
    expect(text()).toContain('1 thing to fix before going live');
    // The engine's "Fix: …" isn't repeated in What happened: How to fix says it once.
    expect(text()).toContain('your agent retried it 4 times within 5 s.How to fix');
    expect(text()).not.toContain('Fix: retry with a growing wait');
    const actions = [...document.querySelectorAll('#sandbox-step button')].map((b) => b.textContent?.trim());
    expect(actions.indexOf('Check your own agent')).toBeLessThan(actions.indexOf('Run the sample again'));
    expect(button('Check again')).toBeUndefined();
    expect(text()).not.toContain('Next: check its answers too.');
    // Settings: no URL or key to change, only Use your own key and Reset.
    expect(text()).toContain('Sample agent (WhiteRoom)');
    expect(button('Get a new Sandbox URL')).toBeUndefined();
    expect(button('Use your own key')).toBeDefined();
  });

  it('Run the sample again starts a new run from the report; a limit refusal hides it and says why, another keeps it', async () => {
    const DONE = { success: true, window: { ...WINDOW, endedAt: '2026-10-29T10:02:00.000Z', stage: 'done' }, checks: [], rules: [] };
    let answer: Response | null = null;
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/fleet/sample')) return answer ?? Response.json(SAMPLE);
      if (url.startsWith('/api/sandbox/checks/')) return Response.json(DONE);
      return Response.json({ ...SAMPLE, sampleRunning: false });
    });
    await render({ fleet: 'prod-eu' });
    await click('Run the sample again');
    expect(calls().filter((c) => c.url.endsWith('/fleet/sample'))).toHaveLength(1);
    expect(capture).toHaveBeenCalledWith('sandbox_v2_sample_started');

    answer = Response.json({ error: 'Sample runs are busy right now. Try again in a minute.', reason: 'busy' }, { status: 429 });
    await click('Run the sample again');
    expect(text()).toContain('Sample runs are busy right now. Try again in a minute.');
    expect(button('Run the sample again')).toBeDefined();

    answer = Response.json({ error: 'You’ve used today’s sample runs. Try again tomorrow, or use your own key.', reason: 'limit_fleet' }, { status: 429 });
    await click('Run the sample again');
    expect(text()).toContain('You’ve used today’s sample runs.');
    expect(button('Run the sample again')).toBeUndefined();
    expect(button('Check your own agent')).toBeDefined();
    expect(capture).toHaveBeenCalledWith('sandbox_v2_sample_refused', { reason: 'limit_fleet' });
  });

  it('Check your own agent opens Connect over the sample; connecting counts after_sample and starts the checks over', async () => {
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/fleet/connect')) return Response.json({ ...OWN, created: false, ...ISSUED });
      if (url.startsWith('/api/sandbox/checks/')) return Response.json({ success: true, window: { ...WINDOW, endedAt: '2026-10-29T10:02:00.000Z', stage: 'done' }, checks: [], rules: [] });
      return Response.json({ ...SAMPLE, sampleRunning: false });
    });
    await render({ fleet: 'prod-eu' });
    await click('Check your own agent');
    expect(document.querySelector('#sandbox-connect h2')?.textContent).toBe('Connect your own key');
    expect(text()).toContain(SAMPLE_REPLACE);
    // Not offered over the sample: this is the way out of it.
    expect(text()).not.toContain('No key handy?');
    const input = document.getElementById('sandbox-v2-key') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-ant-placeholder-not-a-real-key-WXYZ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    bff.mockImplementation(async (url: string) => {
      if (url.endsWith('/fleet/connect')) return Response.json({ ...OWN, created: false, ...ISSUED });
      if (url.startsWith('/api/sandbox/checks/')) return Response.json({ success: true, window: null, checks: [], rules: [] });
      return Response.json(OWN);
    });
    await click('Connect');
    expect(capture).toHaveBeenCalledWith('sandbox_v2_connected', { provider: 'anthropic', detected: true, after_sample: true });
    expect(text()).toContain('key ending WXYZ');
    expect(text()).toContain(`ANTHROPIC_BASE_URL=${ISSUED.proxyUrl}`);
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('2Run your agent');
  });

  it('the dev preview’s sample states render', async () => {
    const shown: Record<string, string> = {};
    for (const state of ['sample-offer', 'sample-limit', 'sample-running', 'sample-results', 'sample-connect-own'] as const) {
      act(() => root.unmount());
      document.body.innerHTML = '';
      root = createRoot(document.body.appendChild(document.createElement('div')));
      await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES[state] });
      shown[state] = text();
    }
    expect(shown['sample-offer']).toContain('Try a sample agent');
    expect(shown['sample-limit']).toContain('You’ve used today’s sample runs.');
    expect(shown['sample-running']).toContain('Our sample agent is running');
    expect(shown['sample-results']).toContain('This was our sample agent.');
    expect(shown['sample-connect-own']).toContain('Connect your own key');
  });
});

describe('Sandbox sample agent: wording and status', () => {
  it('reads the sample flags, with or without a Sandbox', () => {
    expect(statusOf({ exists: false, sampleAvailable: true })).toEqual({ exists: false, sampleAvailable: true });
    expect(statusOf({ exists: false })).toEqual({ exists: false });
    expect(statusOf(SAMPLE)).toMatchObject({ sample: true });
    expect(statusOf(SAMPLE)).not.toHaveProperty('sampleRunning');
    expect(statusOf(OWN)).not.toHaveProperty('sample');
  });

  it('the live and stage lines name the sample agent, and the live line goes once its check ends', () => {
    const now = Date.parse('2026-10-29T10:01:00.000Z');
    const state = { window: WINDOW, checks: [], rules: [], activity: { lastCallAt: '2026-10-29T10:00:58.000Z', callsOutsideWindow24h: 0 } };
    expect(activityLine(state as never, now, true)?.text).toMatch(/^The sample agent is calling the Sandbox/);
    expect(activityLine(state as never, now)?.text).toMatch(/^Your agent is calling the Sandbox/);
    expect(activityLine({ ...state, window: { ...WINDOW, endedAt: '2026-10-29T10:00:59.000Z' } } as never, now, true)).toBeNull();
    // No check at all (the run hasn't opened one, or it's gone): nothing to say about the sample.
    expect(activityLine({ ...state, window: null } as never, now, true)).toBeNull();
    expect(activityLine({ ...state, window: null } as never, now)?.text).toMatch(/^Your agent is calling the Sandbox/);
    expect(stageLine(state as never, true)).toBe('Watching the sample agent’s calls…');
    expect(stageLine({ ...state, window: { ...WINDOW, stage: 'pause' } } as never, true)).toBe('Paused the sample agent for 5 seconds…');
  });
});

describe('Sandbox sample agent: the BFF', () => {
  it('sends only the fleet, as sandbox_sample_start, and passes the engine’s refusal reason back', async () => {
    vi.stubEnv('WR_DASHBOARD_SERVICE_SECRET', 'dash-secret');
    auth.mockResolvedValue({ user: { id: 'u1' } });
    const engine = vi.fn().mockResolvedValue(Response.json(SAMPLE));
    vi.stubGlobal('fetch', engine);
    const post = (body: unknown) => POST(new Request('https://app.example/api/sandbox/fleet/sample', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ action: 'sample' }) });
    const res = await post({ fleet: 'prod-eu', api_key: 'sk-ant-placeholder-ignored', sandboxFleetId: SANDBOX_ID });
    expect(res.status).toBe(200);
    expect(JSON.parse(String((engine.mock.calls[0][1] as RequestInit).body))).toEqual({ action: 'sandbox_sample_start', fleet_id: 'prod-eu' });
    expect(await res.json()).toMatchObject({ exists: true, sample: true });

    engine.mockResolvedValue(Response.json({ error: 'You’ve used today’s sample runs. Try again tomorrow, or use your own key.', reason: 'limit_fleet' }, { status: 429 }));
    const refused = await post({ fleet: 'prod-eu' });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ reason: 'limit_fleet' });
  });
});
