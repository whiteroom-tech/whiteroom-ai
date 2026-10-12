// Sandbox calls that reach WhiteRoom but fail at the provider (a refused key,
// an unknown model, a rate limit, an unreachable endpoint): the status BFF
// passes the engine's failedCalls through, and the page names the failure and
// what to check instead of "No calls yet". An engine without the field reads
// exactly as before. All placeholders; no real keys.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'https://proxy.example.test' }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: async () => null, tokenFromUserFleets: async () => null }));
const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));

import type { RunStatusResult } from '@/lib/sandbox/api';
import { failedCallNotice, failedCallReason, failedCallsCheckDetail, failedCallsOf, type FailedCalls } from '@/lib/sandbox/failed-calls';
import type { SandboxProvider } from '@/lib/sandbox/providers';
import { activitySummary, checkGuidance } from '@/components/sandbox/TestRunFlow';
import { GET } from '@/app/api/sandbox/status/route';

const failed = (status: number, reason: FailedCalls['last']['reason'] = 'upstream_error', count = 1, message = 'Invalid API key.'): FailedCalls => ({
  count,
  last: { at: '2026-10-12T10:00:00.000Z', agentId: 'test-agent', status, reason, message },
});

const agent = (totalTasks: number) => ({
  agentId: 'test-agent', role: 'worker', status: 'active', watchMinutes: 2, watchCount: 0, totalTasks, totalTokens: 0, pairedWith: null, currentWatch: null,
});

const connect = (status?: 'observed') => [{ controlId: 'core.connect', name: 'x', result: status ? { liveEvidence: { status } } : {} }] as unknown as RunStatusResult['controls'];

const run = (over: Partial<RunStatusResult>): RunStatusResult => ({ sandboxId: 'sb1', mode: 'connected', agents: [agent(0)], controls: connect(), ...over });

describe('failedCallsOf', () => {
  it('is null when the engine leaves the field out (older engine) or reports none', () => {
    expect(failedCallsOf(run({}))).toBeNull();
    expect(failedCallsOf(null)).toBeNull();
    expect(failedCallsOf(run({ failedCalls: { ...failed(401), count: 0 } }))).toBeNull();
  });

  it('is null for a demo and for a malformed field', () => {
    expect(failedCallsOf(run({ mode: 'demo', failedCalls: failed(401) }))).toBeNull();
    expect(failedCallsOf(run({ failedCalls: { count: 2 } as unknown as FailedCalls }))).toBeNull();
    expect(failedCallsOf(run({ failedCalls: { count: '2', last: failed(401).last } as unknown as FailedCalls }))).toBeNull();
  });

  it('reads a reported failure, capping the message at 200 characters', () => {
    const long = failed(401, 'upstream_error', 3, 'x'.repeat(300));
    const f = failedCallsOf(run({ failedCalls: long }));
    expect(f?.count).toBe(3);
    expect(f?.last.message).toHaveLength(200);
  });
});

describe('failed call copy, per provider and status', () => {
  it('names the provider and the status', () => {
    expect(failedCallsCheckDetail(failed(401), 'azure-openai')).toBe('1 call failed — Azure OpenAI refused the key (HTTP 401).');
    expect(failedCallsCheckDetail(failed(403, 'upstream_error', 2), 'anthropic')).toBe('2 calls failed — Anthropic refused the key (HTTP 403).');
    expect(failedCallReason(failed(404), 'foundry')).toBe('Claude on Azure (Foundry) couldn’t find the model (HTTP 404)');
    expect(failedCallReason(failed(429), 'openai')).toBe('OpenAI hit a rate limit or quota (HTTP 429)');
    expect(failedCallReason(failed(502, 'upstream_unreachable'), 'bedrock-mantle')).toBe('AWS Bedrock couldn’t be reached');
    expect(failedCallReason(failed(503), 'anthropic')).toBe('Anthropic returned an error (HTTP 503)');
    expect(failedCallReason(failed(400), 'openai')).toBe('OpenAI refused the request (HTTP 400)');
  });

  it('says the call reached WhiteRoom and quotes the provider', () => {
    expect(failedCallNotice(failed(401), 'azure-openai', 'acme.openai.azure.com').what)
      .toBe('Your agent’s call reached WhiteRoom, but Azure OpenAI refused it (HTTP 401): Invalid API key.');
    expect(failedCallNotice(failed(502, 'upstream_unreachable', 1, ''), 'foundry').what)
      .toBe('Your agent’s call reached WhiteRoom, but Claude on Azure (Foundry) couldn’t be reached.');
  });

  it.each<[SandboxProvider, number, FailedCalls['last']['reason'], string | null, RegExp]>([
    ['azure-openai', 401, 'upstream_error', 'acme.openai.azure.com', /key is for the Azure OpenAI resource this test started with \(acme\.openai\.azure\.com\)/],
    ['foundry', 403, 'upstream_error', 'acme.services.ai.azure.com', /key is for the Foundry resource this test started with \(acme\.services\.ai\.azure\.com\)/],
    ['bedrock-mantle', 401, 'upstream_error', 'bedrock-mantle.us-east-1.api.aws', /Bedrock API key with access to Claude in the region this test started with \(us-east-1\)/],
    ['anthropic', 401, 'upstream_error', null, /same Anthropic key you started this test with/],
    ['openai', 403, 'upstream_error', null, /same OpenAI key you started this test with/],
    ['azure-openai', 404, 'upstream_error', 'acme.openai.azure.com', /Azure deployment name/],
    ['foundry', 404, 'upstream_error', null, /Foundry deployment name/],
    ['bedrock-mantle', 404, 'upstream_error', 'bedrock-mantle.eu-west-1.api.aws', /Bedrock model id available in eu-west-1/],
    ['anthropic', 404, 'upstream_error', null, /model name/],
    ['openai', 429, 'upstream_error', null, /rate limit or quota/],
    ['azure-openai', 502, 'upstream_unreachable', 'acme.openai.azure.com', /endpoint this test started with \(acme\.openai\.azure\.com\) is right/],
    ['bedrock-mantle', 502, 'upstream_unreachable', 'bedrock-mantle.us-west-2.api.aws', /Claude is available on Bedrock in the region this test started with \(us-west-2\)/],
    ['anthropic', 502, 'upstream_unreachable', null, /Run the task again/],
  ])('%s HTTP %i (%s): next step', (provider, status, reason, host, next) => {
    expect(failedCallNotice(failed(status, reason), provider, host).next).toMatch(next);
  });
});

describe('Checks › Your agent connects', () => {
  it('without failures: "No calls yet", as before', () => {
    const g = checkGuidance('core.connect', undefined, run({}), 'anthropic');
    expect(g.detail).toBe('No calls yet.');
    expect(g.failed).toBeUndefined();
  });

  it('with failures and no call back: the failure and what to check', () => {
    const g = checkGuidance('core.connect', undefined, run({ failedCalls: failed(401, 'upstream_error', 2) }), 'azure-openai');
    expect(g.detail).toBe('2 calls failed — Azure OpenAI refused the key (HTTP 401).');
    expect(g.action).toMatch(/Azure OpenAI resource/);
    expect(g.failed).toBe(true);
  });

  it('once a call succeeds, success leads and the failures are a note', () => {
    const r = run({ agents: [agent(3)], controls: connect('observed'), failedCalls: failed(401, 'upstream_error', 2) });
    expect(checkGuidance('core.connect', 'observed', r, 'anthropic').detail).toBe('3 calls went through WhiteRoom and got a normal reply. 2 calls failed.');
    expect(checkGuidance('core.connect', 'observed', run({ agents: [agent(1)], controls: connect('observed') }), 'anthropic').detail)
      .toBe('1 call went through WhiteRoom and got a normal reply.');
  });
});

describe('Activity header', () => {
  it('counts failed calls next to the calls that came back', () => {
    expect(activitySummary(run({ failedCalls: failed(401) }))).toBe('1 agent · 0 calls · 1 failed · newest first');
    expect(activitySummary(run({}))).toBe('1 agent · 0 calls · newest first');
    expect(activitySummary(run({ agents: [], failedCalls: failed(401) }))).toBe('0 agents · 0 calls · 1 failed · newest first');
    expect(activitySummary(run({ agents: [] }))).toBeNull();
  });
});

describe('GET /api/sandbox/status', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  const engineReplies = (body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

  it('passes failedCalls through to the page unchanged', async () => {
    const failedCalls = failed(401, 'upstream_error', 2, 'Access denied due to invalid subscription key.');
    engineReplies({ success: true, sandboxId: 'sb1', failedCalls });
    const res = await GET(new Request('https://app.example.test/api/sandbox/status', { headers: { 'x-fleet-token': 'wr_placeholder' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).failedCalls).toEqual(failedCalls);
  });

  it('an engine without the field: no failedCalls in the response', async () => {
    engineReplies({ success: true, sandboxId: 'sb1' });
    const res = await GET(new Request('https://app.example.test/api/sandbox/status', { headers: { 'x-fleet-token': 'wr_placeholder' } }));
    const body = await res.json();
    expect(body).not.toHaveProperty('failedCalls');
    expect(failedCallsOf(body)).toBeNull();
  });
});
