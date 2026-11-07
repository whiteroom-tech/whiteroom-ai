// Sandbox tests through Azure OpenAI, Claude on Azure (Foundry) and AWS
// Bedrock: the Start form checks the endpoint and builds the one the engine
// admits, the BFF forwards provider + endpoint (for Anthropic or OpenAI, only
// the provider name), and the Connect recipe points each SDK at the proxy URL with
// the test's proxy key. All placeholders; no real keys.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'https://proxy.example.test' }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: async () => null, tokenFromUserFleets: async () => null }));
const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const mockHeaders = vi.fn();
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));

import {
  cloudRecipe, cloudStart, endpointsToStore, endpointToRemember, restorableEndpoints, restorableProvider, saveEndpoints, savedEndpoints, ENDPOINTS_STORAGE, foundryEndpoint, isEndpointError, isUnsupportedProviderError, providerSummary, proxyKeyBase,
  PROXY_KEY_PLACEHOLDER, PROVIDER_UNSUPPORTED, withUnsupported,
} from '@/lib/sandbox/providers';
import { CloudEndpointField, CloudGoLive, CloudTroubleshooting, ProviderChoices, ProxyKeyNotice } from '@/components/sandbox/CloudProviderParts';
import { POST } from '@/app/api/sandbox/runs/route';
import { POST as ROTATE } from '@/app/api/sandbox/[sandboxId]/proxy-key/route';
import { announceProxyKeyRotation, forgetProxyKey, loadProxyKey, PROXY_KEY_ROTATED, proxyKeyAfterStorageEvent, rotatedFor, saveProxyKey } from '@/lib/sandbox/api';

const PROXY_KEY = 'sk-wr-' + '0'.repeat(40);
const BASE = `https://proxy.example.test/${PROXY_KEY}`;

describe('cloudStart (Start your test form)', () => {
  it('Azure OpenAI: normalises the resource URL to openai.azure.com', () => {
    expect(cloudStart('azure-openai', ' https://Acme.openai.azure.com/openai/deployments/x ')).toEqual({
      ok: true, provider: 'azure-openai', endpoint: 'https://acme.openai.azure.com',
    });
    expect(cloudStart('azure-openai', 'https://acme.cognitiveservices.azure.com')).toMatchObject({ ok: true, endpoint: 'https://acme.openai.azure.com' });
  });

  it('Foundry: services.ai.azure.com only, always with /anthropic', () => {
    expect(cloudStart('foundry', 'https://acme.services.ai.azure.com/anthropic/v1/messages')).toEqual({
      ok: true, provider: 'foundry', endpoint: 'https://acme.services.ai.azure.com/anthropic',
    });
    expect(foundryEndpoint('https://acme.services.ai.azure.com')).toBe('https://acme.services.ai.azure.com/anthropic');
    const wrongHost = cloudStart('foundry', 'https://acme.openai.azure.com');
    expect(wrongHost.ok).toBe(false);
    if (!wrongHost.ok) expect(wrongHost.error).toContain('uses your resource’s services.ai.azure.com address');
    const notAzure = cloudStart('foundry', 'https://acme.openai.azure.com.evil.test');
    expect(notAzure.ok).toBe(false);
    if (!notAzure.ok) expect(notAzure.error).not.toContain('services.ai.azure.com address');
  });

  it('Bedrock: region → Mantle endpoint (same builder as the Fleet key page)', () => {
    expect(cloudStart('bedrock-mantle', 'eu-west-1')).toEqual({
      ok: true, provider: 'bedrock-mantle', endpoint: 'https://bedrock-mantle.eu-west-1.api.aws/anthropic',
    });
  });

  it('refuses empty, http, credentialed, off-host and malformed endpoints with a message', () => {
    const bad: [Parameters<typeof cloudStart>[0], string][] = [
      ['azure-openai', ''], ['azure-openai', 'http://acme.openai.azure.com'], ['azure-openai', 'https://acme.evil.test'],
      ['azure-openai', 'acme'], ['foundry', ''], ['foundry', 'https://user:pw@acme.services.ai.azure.com'],
      ['foundry', 'https://acme.services.ai.azure.com:8443'], ['bedrock-mantle', ''], ['bedrock-mantle', 'us-east'],
      ['bedrock-mantle', 'https://bedrock-runtime.us-east-1.amazonaws.com'],
    ];
    for (const [p, v] of bad) {
      const r = cloudStart(p, v);
      expect(r.ok, `${p} ${v}`).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
  });
});

describe('cloudRecipe (Connect)', () => {
  for (const lang of ['Python', 'JavaScript'] as const) {
    it(`${lang}: every recipe names the agent and uses the proxy key, never the fleet header`, () => {
      for (const p of ['azure-openai', 'foundry', 'bedrock-mantle'] as const) {
        const code = cloudRecipe(p, BASE, 'billing-bot', lang);
        expect(code).toContain('x-whiteroom-agent');
        expect(code).toContain('billing-bot');
        expect(code).toContain(BASE);
        expect(code).not.toContain('x-whiteroom-fleet');
      }
    });
  }

  it('Azure OpenAI: OpenAI client on /openai/v1 with the Azure key, plus the AzureOpenAI variant', () => {
    const py = cloudRecipe('azure-openai', BASE, 'a', 'Python');
    expect(py).toContain(`base_url="${BASE}/openai/v1"`);
    expect(py).toContain('api_key=os.environ["AZURE_OPENAI_API_KEY"]');
    expect(py).toContain(`azure_client = AzureOpenAI(\n    azure_endpoint="${BASE}"`);
    expect(py.match(/^client = /gm)).toHaveLength(1);
    expect(py).toContain('# Option A');
    expect(py).toContain('# Option B');
    expect(py).toContain("Responses API calls aren't tested yet.");
    expect(py).toContain('api_version="2024-10-21"');
    const js = cloudRecipe('azure-openai', BASE, 'a', 'JavaScript');
    expect(js).toContain(`baseURL: "${BASE}/openai/v1"`);
    expect(js).toContain('apiKey: process.env.AZURE_OPENAI_API_KEY');
    expect(js).toContain(`new AzureOpenAI({\n  endpoint: "${BASE}"`);
  });

  it('Foundry: Anthropic SDK with the proxy URL as base', () => {
    const py = cloudRecipe('foundry', BASE, 'a', 'Python');
    expect(py).toContain('anthropic.Anthropic(');
    expect(py).toContain(`base_url="${BASE}",`);
    expect(py).toContain('ANTHROPIC_FOUNDRY_API_KEY');
    const js = cloudRecipe('foundry', BASE, 'a', 'JavaScript');
    expect(js).toContain(`new Anthropic({\n  baseURL: "${BASE}",`);
    expect(py).toContain('Using AnthropicFoundry? Pass base_url= (above) instead of resource=.');
  });

  it('Bedrock: Anthropic SDK, Bedrock API key, anthropic.<model> ids', () => {
    for (const lang of ['Python', 'JavaScript'] as const) {
      const code = cloudRecipe('bedrock-mantle', BASE, 'a', lang);
      expect(code).toContain('AWS_BEARER_TOKEN_BEDROCK');
      expect(code).toContain('anthropic.claude-haiku-4-5');
      expect(code).not.toContain('us.anthropic.');
      expect(code).not.toContain('-v1:0');
    }
  });

  it('builds the base from the configured proxy URL, with a placeholder when the key is gone', () => {
    expect(proxyKeyBase('https://staging-proxy.example.test/', PROXY_KEY)).toBe(`https://staging-proxy.example.test/${PROXY_KEY}`);
    expect(proxyKeyBase('https://proxy.example.test', null)).toBe(`https://proxy.example.test/${PROXY_KEY_PLACEHOLDER}`);
  });
});

describe('providerSummary', () => {
  it('shows the provider and host for cloud tests, the name otherwise', () => {
    expect(providerSummary('azure-openai', 'acme.openai.azure.com')).toBe('Azure OpenAI · acme.openai.azure.com');
    expect(providerSummary('foundry', null)).toBe('Claude on Azure (Foundry)');
    expect(providerSummary('anthropic', 'ignored.example')).toBe('Anthropic');
  });
});

describe('isEndpointError', () => {
  it('matches provider/endpoint refusals only', () => {
    expect(isEndpointError('Provider "azure-openai" requires an endpoint')).toBe(true);
    expect(isEndpointError('Invalid endpoint: must use https')).toBe(true);
    expect(isEndpointError('Unknown provider "x"')).toBe(false);
  });
});

describe('isUnsupportedProviderError', () => {
  it('matches the engine’s unknown-provider refusals only', () => {
    expect(isUnsupportedProviderError('Unknown provider "foundry". Supported providers: anthropic, openai.')).toBe(true);
    expect(isUnsupportedProviderError('provider must be one of: anthropic, openai')).toBe(true);
    expect(isUnsupportedProviderError('Invalid endpoint: host not allowed')).toBe(false);
    expect(isUnsupportedProviderError(undefined)).toBe(false);
  });
});

describe('POST /api/sandbox/runs', () => {
  const fetchMock = vi.fn();
  const engineBodies = () => fetchMock.mock.calls.map(c => JSON.parse(c[1].body as string));

  function engineReplies(...replies: { status?: number; body: unknown }[]) {
    for (const r of replies) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } }));
    }
  }

  const post = (body: unknown) => POST(new Request('https://app.example.test/api/sandbox/runs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WR_SANDBOX_SERVICE_SECRET', 'placeholder-service-secret');
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    mockHeaders.mockResolvedValue(new Map([['origin', 'https://app.example.test'], ['host', 'app.example.test']]));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('Anthropic/OpenAI with no provider named: the engine request is exactly as before (no provider, no endpoint)', async () => {
    for (const apiKey of ['sk-ant-placeholder', 'sk-proj-placeholder']) {
      fetchMock.mockReset();
      engineReplies({ body: { success: true, sandboxId: 'sb1', fleetToken: 'wr_placeholder' } });
      const res = await post({ mode: 'connected', apiKey, selectedCatalogIds: [], policyMode: 'observe' });
      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({
        action: 'create_sandbox', user_id: 'dashboard:u1', is_trial: false, api_key: apiKey,
        selected_catalog_ids: [], policy_mode: 'observe',
      }));
    }
  });

  it('a named Anthropic or OpenAI provider is forwarded for a connected test, so status reports it back', async () => {
    engineReplies({ body: { success: true, sandboxId: 'sb1' } }, { body: { success: true, sandboxId: 'sb2' } });
    await post({ mode: 'connected', apiKey: 'sk-ant-placeholder', provider: 'anthropic' });
    await post({ mode: 'connected', provider: 'openai' });
    expect(engineBodies().map(b => b.provider)).toEqual(['anthropic', 'openai']);
    expect(engineBodies()[0]).not.toHaveProperty('endpoint');
  });

  it('refuses a demo: the Sandbox demo is the pre-flight sample report now, and starts no test', async () => {
    engineReplies({ body: { success: true, sandboxId: 'sb1' } });
    expect((await post({ mode: 'demo' })).status).toBe(400);
    expect(engineBodies()).toEqual([]);
  });

  it.each([
    ['azure-openai', 'https://acme.openai.azure.com'],
    ['foundry', 'https://acme.services.ai.azure.com/anthropic'],
    ['bedrock-mantle', 'https://bedrock-mantle.us-east-1.api.aws/anthropic'],
  ])('%s: forwards provider and endpoint, no key, and returns the proxy key', async (provider, endpoint) => {
    engineReplies({ body: { success: true, sandboxId: 'sb1', fleetToken: 'wr_placeholder', provider, proxyKey: PROXY_KEY } });
    const res = await post({ mode: 'connected', provider, endpoint, selectedCatalogIds: [], policyMode: 'observe' });
    expect(res.status).toBe(200);
    expect((await res.json()).proxyKey).toBe(PROXY_KEY);
    const sent = engineBodies()[0];
    expect(sent).toMatchObject({ action: 'create_sandbox', is_trial: false, provider, endpoint });
    expect(sent).not.toHaveProperty('api_key');
  });

  it.each([
    ['cloud with an api key', { mode: 'connected', provider: 'foundry', endpoint: 'https://acme.services.ai.azure.com/anthropic', apiKey: 'placeholder-key-000000000000000000' }],
    ['cloud demo', { mode: 'demo', provider: 'foundry', endpoint: 'https://acme.services.ai.azure.com/anthropic' }],
    ['cloud without mode', { provider: 'foundry', endpoint: 'https://acme.services.ai.azure.com/anthropic' }],
    ['cloud without endpoint', { mode: 'connected', provider: 'azure-openai' }],
    ['http endpoint', { mode: 'connected', provider: 'azure-openai', endpoint: 'http://acme.openai.azure.com' }],
    ['endpoint too long', { mode: 'connected', provider: 'azure-openai', endpoint: 'https://acme.openai.azure.com/' + 'a'.repeat(600) }],
    ['endpoint on anthropic', { mode: 'connected', provider: 'anthropic', apiKey: 'sk-ant-placeholder', endpoint: 'https://acme.openai.azure.com' }],
    ['endpoint with no provider', { mode: 'connected', apiKey: 'sk-ant-placeholder', endpoint: 'https://acme.openai.azure.com' }],
    ['engine-identity provider', { mode: 'connected', provider: 'bedrock-sigv4', endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com' }],
    ['non-sk key without a cloud provider', { mode: 'connected', apiKey: 'ABSKplaceholder' }],
  ])('rejects %s before calling the engine', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin request', async () => {
    mockHeaders.mockResolvedValue(new Map([['origin', 'https://evil.example'], ['host', 'app.example.test']]));
    const res = await post({ mode: 'connected', provider: 'foundry', endpoint: 'https://acme.services.ai.azure.com/anthropic' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an engine that names the provider unknown gets a plain message and a code', async () => {
    engineReplies({ status: 400, body: { error: 'Unknown provider "foundry". Supported providers: anthropic, openai.' } });
    const res = await post({ mode: 'connected', provider: 'foundry', endpoint: 'https://acme.services.ai.azure.com/anthropic' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(PROVIDER_UNSUPPORTED);
    expect(body.error).toMatch(/aren’t available yet/);
  });

  it('an engine that ignores provider (no proxy key) has its test ended and is reported unsupported', async () => {
    engineReplies(
      { body: { success: true, sandboxId: 'sb9', fleetToken: 'wr_placeholder' } },
      { body: { success: true } },
    );
    const res = await post({ mode: 'connected', provider: 'azure-openai', endpoint: 'https://acme.openai.azure.com' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(PROVIDER_UNSUPPORTED);
    expect(engineBodies()[1]).toMatchObject({ action: 'destroy_sandbox', sandbox_id: 'sb9', user_id: 'dashboard:u1' });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer wr_placeholder');
    expect(fetchMock.mock.calls[1][1].headers['x-wr-sandbox-secret']).toBe('placeholder-service-secret');
  });

  it('a 200 that carries an engine error passes through, with no cleanup', async () => {
    engineReplies({ body: { error: 'You already have an active sandbox. End it first.' } });
    const res = await post({ mode: 'connected', provider: 'foundry', endpoint: 'https://acme.services.ai.azure.com/anthropic' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ error: 'You already have an active sandbox. End it first.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Provider "foundry" requires an endpoint — its hostname carries your own resource or region.',
    'Invalid endpoint: host not allowed for foundry',
  ])('an endpoint refusal (%s) becomes a plain message', async (engineError) => {
    engineReplies({ status: 400, body: { error: engineError } });
    const res = await post({ mode: 'connected', provider: 'foundry', endpoint: 'https://acme.services.ai.azure.com/anthropic' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'That endpoint doesn’t match Claude on Azure (Foundry). Check it and try again.' });
  });

  it('other engine refusals pass through unchanged', async () => {
    engineReplies({ status: 429, body: { error: 'Too many tests. Try again in a minute.' } });
    const res = await post({ mode: 'connected', provider: 'azure-openai', endpoint: 'https://acme.openai.azure.com' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many tests. Try again in a minute.' });
  });

  it('POST /api/sandbox/[id]/proxy-key asks the engine for a fresh key for this owner', async () => {
    engineReplies({ body: { success: true, proxyKey: PROXY_KEY } });
    const res = await ROTATE(new Request('https://app.example.test/api/sandbox/sb1/proxy-key', { method: 'POST' }), { params: Promise.resolve({ sandboxId: 'sb1' }) });
    expect(res.status).toBe(200);
    expect(engineBodies()[0]).toEqual({ action: 'rotate_sandbox_proxy_key', user_id: 'dashboard:u1', sandbox_id: 'sb1' });
    const bad = await ROTATE(new Request('https://app.example.test/x', { method: 'POST' }), { params: Promise.resolve({ sandboxId: '../x' }) });
    expect(bad.status).toBe(400);
  });
});

describe('proxy key storage', () => {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const area = (m: Map<string, string>) => ({
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  });
  beforeEach(() => {
    local.clear(); session.clear();
    vi.stubGlobal('window', { localStorage: area(local), sessionStorage: area(session) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lives in sessionStorage, for its own test only', () => {
    saveProxyKey('sb1', PROXY_KEY);
    expect([...local.keys()]).toEqual([]);
    expect(loadProxyKey('sb1')).toBe(PROXY_KEY);
    expect(loadProxyKey('sb2')).toBeNull();
    expect(loadProxyKey(undefined)).toBeNull();
    forgetProxyKey();
    expect(loadProxyKey('sb1')).toBeNull();
  });

  it('ignores anything that is not a WhiteRoom proxy key', () => {
    saveProxyKey('sb1', 'not-a-proxy-key');
    expect(loadProxyKey('sb1')).toBeNull();
  });

  it('a rotate in another tab drops the shown key with a new value (so the page re-renders)', () => {
    const shown = { sandboxId: 'sb1', proxyKey: PROXY_KEY };
    expect(proxyKeyAfterStorageEvent(shown, PROXY_KEY_ROTATED, 'sb1:1700000000000')).toBeNull();
    expect(proxyKeyAfterStorageEvent(shown, PROXY_KEY_ROTATED, 'sb2:1700000000000')).toBe(shown);
    expect(proxyKeyAfterStorageEvent(shown, 'wr_sandbox_token', 'sb1:1')).toBe(shown);
    expect(proxyKeyAfterStorageEvent(null, PROXY_KEY_ROTATED, 'sb1:1')).toBeNull();
  });

  it('a rotate tells other tabs which test, without the key', () => {
    announceProxyKeyRotation('sb1');
    const v = local.get(PROXY_KEY_ROTATED) ?? null;
    expect(v).not.toContain('sk-wr-');
    expect(rotatedFor(v, 'sb1')).toBe(true);
    expect(rotatedFor(v, 'sb10')).toBe(false);
    expect(rotatedFor(v, undefined)).toBe(false);
  });
});

describe('cloud UI parts', () => {
  const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
  const noop = () => {};

  it('provider choices are named radios; a refused provider is disabled and says so', () => {
    const out = html(h(ProviderChoices, { value: 'anthropic', unsupported: ['foundry'], onPick: noop }));
    expect(out).toContain('<fieldset');
    expect(out).toContain('Where your agent’s model runs');
    expect(out.match(/type="radio"/g)).toHaveLength(5);
    expect(out.match(/disabled=""/g)).toHaveLength(1);
    const foundry = out.match(/<input[^>]*value="foundry"[^>]*>/)?.[0] ?? '';
    expect(foundry).toContain('disabled');
    expect(out).toContain('Not available yet');
    expect(out).not.toContain('Provider follows your key');
    expect(html(h(ProviderChoices, { value: 'openai', unsupported: [], followsKey: true, onPick: noop }))).toContain('Provider follows your key.');
  });

  it('restores only a known provider the engine hasn’t refused', () => {
    expect(restorableProvider('foundry', [])).toBe('foundry');
    expect(restorableProvider('openai', ['foundry'])).toBe('openai');
    expect(restorableProvider('foundry', ['foundry'])).toBeNull();
    expect(restorableProvider('bedrock-sigv4', [])).toBeNull();
    expect(restorableProvider(null, [])).toBeNull();
  });

  it('a refused provider falls back to Anthropic and stays listed once', () => {
    expect(withUnsupported([], 'bedrock-mantle')).toEqual({ unsupported: ['bedrock-mantle'], provider: 'anthropic' });
    expect(withUnsupported(['bedrock-mantle'], 'bedrock-mantle').unsupported).toEqual(['bedrock-mantle']);
  });

  it('endpoint field: help by default, the error (aria-invalid) when there is one', () => {
    const help = html(h(CloudEndpointField, { provider: 'bedrock-mantle', value: '', error: '', onChange: noop, onSubmit: noop }));
    expect(help).toContain('AWS region');
    expect(help).toContain('IAM credentials aren’t supported here.');
    expect(help).not.toContain('aria-invalid');
    const bad = html(h(CloudEndpointField, { provider: 'azure-openai', value: 'x', error: 'Use your resource’s https address.', onChange: noop, onSubmit: noop }));
    expect(bad).toContain('aria-invalid="true"');
    expect(bad).toContain('Use your resource’s https address.');
  });

  it('the recovery notice offers a new proxy URL and warns the old one stops', () => {
    const out = html(h(ProxyKeyNotice, { onRecover: noop }));
    expect(out).toContain('Get a new proxy URL');
    expect(out).toContain('Your agent’s current URL stops working as soon as you do.');
    expect(html(h(ProxyKeyNotice, { onRecover: noop, disabled: true }))).toContain('disabled=""');
  });

  it('troubleshooting and go-live copy per provider', () => {
    expect(html(h(CloudTroubleshooting, { provider: 'azure-openai' }))).toContain('/openai/v1');
    expect(html(h(CloudTroubleshooting, { provider: 'foundry', endpointHost: 'acme.services.ai.azure.com' }))).toContain('acme.services.ai.azure.com');
    expect(html(h(CloudGoLive, { provider: 'foundry' }))).toContain('can’t be added on Fleet key yet');
    expect(html(h(CloudGoLive, { provider: 'bedrock-mantle' }))).toContain('href="/fleet-key"');
  });
});

describe('start form endpoints across a reload', () => {
  it('keeps the region for Bedrock and the checked address for Azure and Foundry', () => {
    expect(endpointToRemember('bedrock-mantle', ' EU-West-1 ')).toBe('eu-west-1');
    expect(endpointToRemember('azure-openai', 'https://acme.cognitiveservices.azure.com/openai/deployments/x')).toBe('https://acme.openai.azure.com');
    expect(endpointToRemember('foundry', 'https://acme.services.ai.azure.com/anthropic/v1/messages')).toBe('https://acme.services.ai.azure.com/anthropic');
  });

  it('never keeps anything else that was pasted: query strings, keys, half-typed values', () => {
    const stored = endpointsToStore({
      'azure-openai': 'https://acme.openai.azure.com/?api-key=placeholder-secret',
      foundry: 'sk-ant-placeholder',
      'bedrock-mantle': 'ABSKplaceholderplaceholder',
    });
    expect(stored).not.toContain('placeholder');
    expect(JSON.parse(stored)).toEqual({ 'azure-openai': 'https://acme.openai.azure.com' });
    expect(endpointsToStore({ 'bedrock-mantle': 'us-ea' })).toBe('{}');
  });

  it('round-trips, and drops unreadable or unknown saved values', () => {
    const saved = endpointsToStore({ 'azure-openai': 'https://acme.openai.azure.com', 'bedrock-mantle': 'us-east-1' });
    expect(restorableEndpoints(saved)).toEqual({ 'azure-openai': 'https://acme.openai.azure.com', 'bedrock-mantle': 'us-east-1' });
    expect(restorableEndpoints(null)).toEqual({});
    expect(restorableEndpoints('not json')).toEqual({});
    expect(restorableEndpoints('[1,2]')).toEqual({});
    expect(restorableEndpoints(JSON.stringify({ anthropic: 'x', foundry: 'https://evil.test', 'bedrock-mantle': 7 }))).toEqual({});
  });

  it('the start form saves to and restores from this browser', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    try {
      expect(savedEndpoints()).toEqual({});
      saveEndpoints({ 'azure-openai': 'https://acme.openai.azure.com/?api-key=placeholder-secret', 'bedrock-mantle': 'https://bedrock-mantle.us-west-2.api.aws' });
      expect(store.get(ENDPOINTS_STORAGE)).not.toContain('placeholder');
      expect(savedEndpoints()).toEqual({ 'azure-openai': 'https://acme.openai.azure.com', 'bedrock-mantle': 'us-west-2' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
