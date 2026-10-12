// Sandbox tests through Azure OpenAI, Claude on Azure (Foundry) and AWS
// Bedrock: the Start form checks the endpoint and builds the one the engine
// admits, the BFF forwards provider + endpoint (and nothing new for Anthropic
// or OpenAI), and the Connect recipe points each SDK at the proxy URL with
// the test's proxy key. All placeholders; no real keys.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'https://proxy.example.test' }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: async () => null, tokenFromUserFleets: async () => null }));
const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const mockHeaders = vi.fn();
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));

import {
  cloudRecipe, cloudStart, foundryEndpoint, isUnsupportedProviderError, providerSummary, proxyKeyBase,
  PROXY_KEY_PLACEHOLDER, PROVIDER_UNSUPPORTED,
} from '@/lib/sandbox/providers';
import { POST } from '@/app/api/sandbox/runs/route';
import { POST as ROTATE } from '@/app/api/sandbox/[sandboxId]/proxy-key/route';
import { loadProxyKey, saveProxyKey } from '@/lib/sandbox/api';

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
    if (!wrongHost.ok) expect(wrongHost.error).toMatch(/services\.ai\.azure\.com/);
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
    expect(py).toContain(`AzureOpenAI(\n    azure_endpoint="${BASE}"`);
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
  });

  it('Bedrock: Anthropic SDK, Bedrock API key, anthropic.<model> ids', () => {
    for (const lang of ['Python', 'JavaScript'] as const) {
      const code = cloudRecipe('bedrock-mantle', BASE, 'a', lang);
      expect(code).toContain('AWS_BEARER_TOKEN_BEDROCK');
      expect(code).toContain('anthropic.claude-haiku-4-5');
      expect(code).not.toMatch(/us\.anthropic|-v\d:\d/);
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
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
    mockHeaders.mockResolvedValue(new Map([['origin', 'https://app.example.test'], ['host', 'app.example.test']]));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Anthropic/OpenAI: the engine request is exactly as before (no provider, no endpoint)', async () => {
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

  it('a named anthropic provider is not forwarded either', async () => {
    engineReplies({ body: { success: true, sandboxId: 'sb1' } });
    await post({ mode: 'connected', apiKey: 'sk-ant-placeholder', provider: 'anthropic' });
    expect(engineBodies()[0]).not.toHaveProperty('provider');
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
  });

  it('other engine refusals pass through unchanged', async () => {
    engineReplies({ status: 400, body: { error: 'Invalid endpoint: host not allowed' } });
    const res = await post({ mode: 'connected', provider: 'azure-openai', endpoint: 'https://acme.openai.azure.com' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid endpoint: host not allowed' });
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
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is kept for its own test only', () => {
    saveProxyKey('sb1', PROXY_KEY);
    expect(loadProxyKey('sb1')).toBe(PROXY_KEY);
    expect(loadProxyKey('sb2')).toBeNull();
    expect(loadProxyKey(undefined)).toBeNull();
  });

  it('ignores anything that is not a WhiteRoom proxy key', () => {
    saveProxyKey('sb1', 'not-a-proxy-key');
    expect(loadProxyKey('sb1')).toBeNull();
  });
});
