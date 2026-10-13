// Sandbox polish from walking the flow as a new user: Connect offers "No code
// change" only where it works, says what to put in x-whiteroom-agent, the
// Start form asks for the API key first (fleet token as a side note) and says
// where to find it, and the remembered provider is tagged "Last used".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunStatusResult } from '@/lib/sandbox/api';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { accountSwitched, agentNameNote, FIRST_VISIT, directProviderOf, KeyField, runOptions, PLACEHOLDER_AGENT, setupChoices, shownSetup, TestRunFlow } = await import('@/components/sandbox/TestRunFlow');
const { CHOICES_OWNER_STORAGE, claimSandboxChoices, forgetSandboxChoices, PROVIDER_STORAGE } = await import('@/lib/sandbox/api');
const { ProviderChoices } = await import('@/components/sandbox/CloudProviderParts');
const { ENDPOINTS_STORAGE, KEY_HELP, noCodeSetup, offersNoCode, SANDBOX_PROVIDERS } = await import('@/lib/sandbox/providers');

const opts = { proxyUrl: 'https://proxy.whiteroom.tech/', base: 'https://proxy.whiteroom.tech/sk-wr-test', fleetId: 'sandbox-1234' };
const render = (previewRun: RunStatusResult) => renderToStaticMarkup(createElement(TestRunFlow as FC<NonNullable<Parameters<typeof TestRunFlow>[0]>>, { previewUserId: 'u', previewPastTests: [], previewRun }));
const live = (o: Partial<RunStatusResult> = {}): RunStatusResult => ({ sandboxId: 'live-1', mode: 'connected', expiresInSeconds: 1500, agents: [], auditLog: [], controls: [], ...o });

describe('Connect: No code change only where it works', () => {
  it('is offered exactly where noCodeSetup has something to copy', () => {
    for (const p of SANDBOX_PROVIDERS) expect(offersNoCode(p)).toBe(noCodeSetup(p, opts).code !== null);
    expect(offersNoCode('openai')).toBe(false);
  });

  it('drops the choice for OpenAI and keeps it elsewhere', () => {
    expect(setupChoices('openai')).toEqual(['Python', 'JavaScript']);
    for (const p of ['anthropic', 'azure-openai', 'foundry', 'bedrock-mantle'] as const) expect(setupChoices(p)).toEqual(['Python', 'JavaScript', 'env']);
  });

  it('falls back to Python when No code change was picked but isn’t offered', () => {
    expect(shownSetup('env', 'openai')).toBe('Python');
    expect(shownSetup('JavaScript', 'openai')).toBe('JavaScript');
    expect(shownSetup('env', 'anthropic')).toBe('env');
  });

  it('renders the tab for Anthropic and cloud tests, not for an OpenAI test', () => {
    expect(render(live())).toContain('No code change');
    expect(render(live({ provider: 'anthropic' }))).toContain('No code change');
    expect(render(live({ provider: 'openai' }))).not.toContain('No code change');
    expect(render(live({ provider: 'azure-openai', endpointHost: 'acme.openai.azure.com' }))).toContain('No code change');
  });
});

describe('Connect: the agent name', () => {
  const agent = (agentId: string) => ({ agentId, role: 'worker', status: 'active', watchMinutes: 2, watchCount: 0, totalTasks: 0, totalTokens: 0, pairedWith: null, currentWatch: null });
  it('says to replace the placeholder until an agent has called', () => {
    expect(agentNameNote(live())).toBe(`Put your agent’s own name in place of ${PLACEHOLDER_AGENT}. Any name works.`);
    expect(agentNameNote(null)).not.toBeNull();
    expect(agentNameNote(live({ agents: [agent('support-bot')] }))).toBeNull();
    // Even one that kept the placeholder name: it has called, so the note is done.
    expect(agentNameNote(live({ agents: [agent(PLACEHOLDER_AGENT)] }))).toBeNull();
  });

  it('shows the line under a live test’s code, not once the agent’s own name is in it, nor in a demo', () => {
    const note = 'Put your agent’s own name in place of test-agent.';
    expect(render(live())).toContain(note);
    expect(render(live({ provider: 'bedrock-mantle' }))).toContain(note);
    const named = live({ agents: [{ agentId: 'support-bot', role: 'worker', status: 'active', watchMinutes: 2, watchCount: 0, totalTasks: 0, totalTokens: 0, pairedWith: null, currentWatch: null }] });
    expect(render(named)).not.toContain(note);
    expect(render(live({ mode: 'demo' }))).not.toContain(note);
  });
});

describe('Start your test: the key field', () => {
  const noop = () => {};
  const field = (credential = '', provider: 'anthropic' | 'openai' = 'anthropic') =>
    renderToStaticMarkup(createElement(KeyField, { credential, showKey: false, provider, onChange: noop, onToggleShow: noop }));

  it('asks for the API key, with the fleet token as a side note', () => {
    const empty = field();
    expect(empty).toContain('<label class="');
    expect(empty).toMatch(/for="sandbox-key">Your agent’s API key<\/label>/);
    expect(empty).not.toContain('or a WhiteRoom fleet token');
    expect(empty).toContain('Have a WhiteRoom fleet token? Paste it instead.');
    // Placeholder prefixes stay.
    expect(empty).toContain('placeholder="sk-ant-…, sk-…, or wr_…"');
    // The side note goes once something is pasted.
    expect(field('sk-ant-x')).not.toContain('Have a WhiteRoom fleet token?');
  });

  it('says where to find the key for the provider picked', () => {
    expect(KEY_HELP.anthropic).toBe('Find it in Claude Console → Settings → API keys.');
    expect(KEY_HELP.openai).toBe('Find it at platform.openai.com → API keys.');
    expect(field('', 'anthropic')).toContain(KEY_HELP.anthropic);
    expect(field('', 'openai')).toContain(KEY_HELP.openai);
  });
});

describe('Start your test: the remembered provider', () => {
  const noop = () => {};
  const html = (o: Partial<Parameters<typeof ProviderChoices>[0]>) => renderToStaticMarkup(createElement(ProviderChoices, { value: 'anthropic', unsupported: [], onPick: noop, ...o }));

  it('tags the last used provider, once', () => {
    const out = html({ value: 'bedrock-mantle', lastUsed: 'bedrock-mantle' });
    expect(out.match(/Last used/g)).toHaveLength(1);
    expect(out).toMatch(/AWS Bedrock <span class="wr-tag wr-tag--muted">Last used<\/span>/);
  });

  it('tags nothing on a first visit, or for a provider that isn’t available', () => {
    expect(html({})).not.toContain('Last used');
    expect(html({ lastUsed: null })).not.toContain('Last used');
    expect(html({ lastUsed: 'foundry', unsupported: ['foundry'] })).not.toContain('Last used');
  });
});

describe('the test’s provider after a reload', () => {
  it('comes from the engine for a live Anthropic or OpenAI test', () => {
    expect(directProviderOf(live({ provider: 'openai' }), 'anthropic')).toBe('openai');
    expect(directProviderOf(live({ provider: 'anthropic' }), 'openai')).toBe('anthropic');
  });

  it('falls back to the page’s choice when the engine names none, for a demo, or before a test', () => {
    expect(directProviderOf(live({ provider: null }), 'openai')).toBe('openai');
    expect(directProviderOf(live(), 'anthropic')).toBe('anthropic');
    expect(directProviderOf(live({ mode: 'demo', provider: 'anthropic' }), 'openai')).toBe('openai');
    expect(directProviderOf(null, 'openai')).toBe('openai');
    expect(directProviderOf(live({ provider: 'azure-openai' }), 'bedrock-mantle')).toBe('anthropic');
  });

  it('shows the engine’s provider in Connect', () => {
    const html = render(live({ provider: 'openai' }));
    expect(html).toContain('from openai import OpenAI');
    expect(html).not.toContain('import anthropic');
  });
});

describe('sign-out on a shared browser', () => {
  const local = new Map<string, string>();
  beforeEach(() => {
    local.clear();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => { local.set(k, v); }, removeItem: (k: string) => { local.delete(k); } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('forgets the last provider and endpoints, and nothing else', () => {
    local.set(PROVIDER_STORAGE, 'bedrock-mantle');
    local.set(ENDPOINTS_STORAGE, '{"bedrock-mantle":"us-east-1"}');
    local.set('wr_theme', 'dark');
    local.set(CHOICES_OWNER_STORAGE, 'u1');
    forgetSandboxChoices();
    expect([...local.keys()]).toEqual(['wr_theme']);
  });

  it('drops another account’s choices when the page loads for someone else, even with no sign-out', () => {
    local.set(PROVIDER_STORAGE, 'bedrock-mantle');
    local.set(ENDPOINTS_STORAGE, '{"bedrock-mantle":"us-east-1"}');
    local.set(CHOICES_OWNER_STORAGE, 'u1');
    expect(claimSandboxChoices('u2')).toBe(true);
    expect(local.get(PROVIDER_STORAGE)).toBeUndefined();
    expect(local.get(ENDPOINTS_STORAGE)).toBeUndefined();
    expect(local.get(CHOICES_OWNER_STORAGE)).toBe('u2');
  });

  it('keeps the same account’s choices, and claims unowned ones', () => {
    local.set(PROVIDER_STORAGE, 'openai');
    local.set(CHOICES_OWNER_STORAGE, 'u1');
    expect(claimSandboxChoices('u1')).toBe(false);
    expect(local.get(PROVIDER_STORAGE)).toBe('openai');
    local.delete(CHOICES_OWNER_STORAGE);
    expect(claimSandboxChoices('u3')).toBe(false);
    expect(local.get(CHOICES_OWNER_STORAGE)).toBe('u3');
  });
});

describe('Starting a test: what is sent', () => {
  it('a live Anthropic or OpenAI test names its provider and sends the pasted key', () => {
    expect(runOptions('connected', 'openai', ' sk-abc ').opts).toMatchObject({ mode: 'connected', apiKey: 'sk-abc', provider: 'openai' });
    expect(runOptions('connected', 'anthropic', 'sk-ant-abc').opts).toMatchObject({ apiKey: 'sk-ant-abc', provider: 'anthropic' });
  });
  it('a fleet token goes as the token, not as a key', () => {
    const r = runOptions('connected', 'anthropic', 'wr_tok');
    expect(r.pastedToken).toBe('wr_tok');
    expect(r.opts.apiKey).toBeUndefined();
  });
  it('a demo names no provider and sends no key', () => {
    const r = runOptions('demo', 'openai', 'sk-abc');
    expect(r.opts).not.toHaveProperty('provider');
    expect(r.opts.apiKey).toBeUndefined();
    expect(r.pastedToken).toBeUndefined();
  });
  it('a cloud test sends only its endpoint and provider', () => {
    const r = runOptions('connected', 'azure-openai', 'sk-abc', { provider: 'azure-openai', endpoint: 'https://acme.openai.azure.com' });
    expect(r.opts).toMatchObject({ provider: 'azure-openai', endpoint: 'https://acme.openai.azure.com' });
    expect(r.opts.apiKey).toBeUndefined();
  });
});

describe('Another account on this browser', () => {
  it('forgets the previous account’s choices only on a real switch', () => {
    expect(accountSwitched('u1', 'u2')).toBe(true);
    expect(accountSwitched(undefined, 'u2')).toBe(false); // first sign-in
    expect(accountSwitched('u1', undefined)).toBe(false); // signed out
    expect(accountSwitched('u1', 'u1')).toBe(false);
  });

  it('a switch starts the form over like a first visit: Anthropic, no endpoints, no Last used', () => {
    expect(FIRST_VISIT).toEqual({ provider: 'anthropic', endpoints: {}, lastUsed: null });
    expect(renderToStaticMarkup(createElement(ProviderChoices, { value: FIRST_VISIT.provider, unsupported: [], onPick: () => {}, lastUsed: FIRST_VISIT.lastUsed }))).not.toContain('Last used');
  });
});
