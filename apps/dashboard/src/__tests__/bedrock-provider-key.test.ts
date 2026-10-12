// Claude on AWS Bedrock from the Fleet key page: the form takes a Bedrock API
// key and a region, sends the engine provider bedrock-mantle with the Mantle
// endpoint it admits, and the recipe points the Anthropic SDK at the proxy URL.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bedrockMantleEndpoint, bedrockRegion } from '@/lib/bedrock-endpoint';
import { PROVIDER_LABELS, isAnthropicWire, issuedEnvHint, providerKeyRequest } from '@/lib/provider-key-form';
import { AGENT_HEADER, AGENT_PLACEHOLDER, BEDROCK_LINES, BEDROCK_NOTES, PROXY_ORIGIN } from '@/lib/setup';
import { storeProviderKey } from '@/lib/whiteroom/client';

const BEDROCK_KEY = 'ABSKexampleexampleexampleexample0000';

describe('bedrockMantleEndpoint', () => {
  it('builds the Mantle Messages base from a region', () => {
    expect(bedrockMantleEndpoint('us-east-1')).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic');
    expect(bedrockMantleEndpoint(' EU-West-1 ')).toBe('https://bedrock-mantle.eu-west-1.api.aws/anthropic');
    expect(bedrockMantleEndpoint('ap-southeast-2')).toBe('https://bedrock-mantle.ap-southeast-2.api.aws/anthropic');
    expect(bedrockMantleEndpoint('us-gov-west-1')).toBe('https://bedrock-mantle.us-gov-west-1.api.aws/anthropic');
  });

  it('takes the region from a pasted Mantle URL, dropping its path', () => {
    expect(bedrockRegion('https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages')).toBe('us-west-2');
    expect(bedrockMantleEndpoint('https://bedrock-mantle.us-west-2.api.aws')).toBe('https://bedrock-mantle.us-west-2.api.aws/anthropic');
  });

  it('refuses anything that is not a region or a Mantle URL', () => {
    for (const bad of [
      '', 'us-east', 'useast1', 'us_east_1',
      'https://bedrock-runtime.us-east-1.amazonaws.com',
      'http://bedrock-mantle.us-east-1.api.aws',
      'https://bedrock-mantle.api.aws',
      'https://bedrock-mantle.us-east-1.api.aws.evil.tld',
      'https://s3.us-east-1.api.aws',
    ]) {
      expect(bedrockMantleEndpoint(bad), bad).toBeNull();
    }
  });
});

describe('providerKeyRequest, AWS Bedrock tab', () => {
  it('sends bedrock-mantle with the Mantle endpoint for the region', () => {
    expect(providerKeyRequest('aws', `  ${BEDROCK_KEY} `, 'us-east-1')).toEqual({
      ok: true,
      request: { key: BEDROCK_KEY, endpoint: 'https://bedrock-mantle.us-east-1.api.aws/anthropic', provider: 'bedrock-mantle' },
    });
  });

  it('accepts a short-term bedrock-api-key- key', () => {
    const shortTerm = 'bedrock-api-key-exampleexampleexample0000';
    const check = providerKeyRequest('aws', shortTerm, 'us-west-2');
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.request).toMatchObject({ key: shortTerm, provider: 'bedrock-mantle' });
  });

  it('asks for the key, then the region', () => {
    const noKey = providerKeyRequest('aws', '', 'us-east-1');
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.error).toMatch(/Bedrock API key/);
    const noRegion = providerKeyRequest('aws', BEDROCK_KEY, '  ');
    expect(noRegion.ok).toBe(false);
    if (!noRegion.ok) expect(noRegion.error).toMatch(/region/);
    const badRegion = providerKeyRequest('aws', BEDROCK_KEY, 'virginia');
    expect(badRegion.ok).toBe(false);
    if (!badRegion.ok) expect(badRegion.error).toMatch(/us-east-1/);
  });

  it('points out an AWS access key ID or a key for another tab', () => {
    const iam = providerKeyRequest('aws', 'AKIAEXAMPLEEXAMPLE00', 'us-east-1');
    expect(iam.ok).toBe(false);
    if (!iam.ok) expect(iam.error).toMatch(/access key ID/);
    const ant = providerKeyRequest('aws', 'sk-ant-exampleexampleexample', 'us-east-1');
    expect(ant.ok).toBe(false);
    if (!ant.ok) expect(ant.error).toMatch(/Anthropic or OpenAI tab/);
  });
});

describe('providerKeyRequest, existing tabs unchanged', () => {
  it('Azure still sends azure-openai with the normalized resource URL', () => {
    expect(providerKeyRequest('azure', 'azurekeyexample0000', 'https://acme.cognitiveservices.azure.com/')).toEqual({
      ok: true,
      request: { key: 'azurekeyexample0000', endpoint: 'https://acme.openai.azure.com', provider: 'azure-openai' },
    });
    expect(providerKeyRequest('azure', 'azurekeyexample0000', 'us-east-1').ok).toBe(false);
  });

  it('direct keys name no provider, so the engine reads the prefix', () => {
    expect(providerKeyRequest('direct', 'sk-ant-example0000', '')).toEqual({ ok: true, request: { key: 'sk-ant-example0000' } });
    expect(providerKeyRequest('direct', BEDROCK_KEY, '').ok).toBe(false);
  });
});

describe('issued key', () => {
  it('labels Bedrock keys and gives the Anthropic base URL line', () => {
    expect(PROVIDER_LABELS['bedrock-mantle']).toBe('AWS Bedrock');
    expect(isAnthropicWire('bedrock-mantle')).toBe(true);
    expect(isAnthropicWire('azure-openai')).toBe(false);
    expect(issuedEnvHint('bedrock-mantle', `${PROXY_ORIGIN}/sk-wr-x`)).toBe(`export ANTHROPIC_BASE_URL=${PROXY_ORIGIN}/sk-wr-x`);
  });
});

describe('storeProviderKey payload', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('names bedrock-mantle and the endpoint for store_key', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, proxyUrl: `${PROXY_ORIGIN}/sk-wr-x`, provider: 'bedrock-mantle' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const check = providerKeyRequest('aws', BEDROCK_KEY, 'eu-west-1');
    if (!check.ok) throw new Error(check.error);
    const { key, endpoint, provider } = check.request;
    await storeProviderKey({ fleetId: 'f', apiKey: 'sk-wr-test', fleetToken: 'wr_test' }, key, endpoint, provider);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      action: 'store_key',
      api_key: BEDROCK_KEY,
      llm_endpoint: 'https://bedrock-mantle.eu-west-1.api.aws/anthropic',
      provider: 'bedrock-mantle',
    });
  });
});

describe('Bedrock recipe', () => {
  const proxy = `${PROXY_ORIGIN}/<your-proxy-key>`;

  it('points the Anthropic SDK at the proxy URL with the Bedrock API key', () => {
    expect(BEDROCK_LINES.baseUrl).toBe(`export ANTHROPIC_BASE_URL=${proxy}`);
    expect(BEDROCK_LINES.apiKey).toBe('export ANTHROPIC_API_KEY=<your-bedrock-api-key>');
    expect(BEDROCK_LINES.python).toContain('anthropic.Anthropic(');
    expect(BEDROCK_LINES.python).toContain(`base_url="${proxy}"`);
    expect(BEDROCK_LINES.python).toContain('api_key="<your-bedrock-api-key>"');
    expect(BEDROCK_LINES.typescript).toContain('new Anthropic({');
    expect(BEDROCK_LINES.typescript).toContain(`baseURL: "${proxy}"`);
    expect(BEDROCK_LINES.typescript).toContain('apiKey: "<your-bedrock-api-key>"');
  });

  it('leaves /v1 off the base URL, since the SDK adds /v1/messages', () => {
    for (const code of [BEDROCK_LINES.baseUrl, BEDROCK_LINES.python, BEDROCK_LINES.typescript]) {
      expect(code).not.toContain('<your-proxy-key>/v1');
    }
  });

  it('uses Bedrock model ids and the optional agent header', () => {
    expect(BEDROCK_LINES.python).toContain('model="anthropic.claude-haiku-4-5"');
    expect(BEDROCK_LINES.typescript).toContain('model: "anthropic.claude-haiku-4-5"');
    for (const code of [BEDROCK_LINES.python, BEDROCK_LINES.typescript]) {
      expect(code).toContain(`"${AGENT_HEADER}": "${AGENT_PLACEHOLDER}"`);
      expect(code).toMatch(/optional if your agent has a system prompt/);
    }
    expect(BEDROCK_LINES.python).toContain('default_headers=');
    expect(BEDROCK_LINES.typescript).toContain('defaultHeaders:');
  });

  it('uses Mantle model ids: no region prefix, no version suffix', () => {
    for (const code of [BEDROCK_LINES.python, BEDROCK_LINES.typescript, BEDROCK_NOTES.model]) {
      const ids = code.match(/[\w.-]*anthropic\.claude[\w.:-]*/g) ?? [];
      expect(ids.length, code).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id).toMatch(/^anthropic\./);
        expect(id).not.toMatch(/-v\d+:\d+$/);
        expect(id).not.toMatch(/^(us|eu|apac|global|us-gov)\./);
      }
    }
  });

  it('explains Bedrock keys and regions', () => {
    expect(BEDROCK_NOTES.key).toMatch(/ABSK/);
    expect(BEDROCK_NOTES.key).toMatch(/bedrock-api-key-/);
    expect(BEDROCK_NOTES.key).toMatch(/12 hours/);
    expect(BEDROCK_NOTES.region).toMatch(/region where Claude is available/);
    expect(BEDROCK_NOTES.custody).toMatch(/sends its own key on each call/);
  });
});
