// Sandbox polish from walking the flow as a new user: Connect offers "No code
// change" only where it works, says what to put in x-whiteroom-agent, the
// Start form asks for the API key first (fleet token as a side note) and says
// where to find it, and the remembered provider is tagged "Last used".

import { describe, expect, it, vi } from 'vitest';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RunStatusResult } from '@/lib/sandbox/api';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { agentNameNote, PLACEHOLDER_AGENT, setupChoices, shownSetup, TestRunFlow } = await import('@/components/sandbox/TestRunFlow');
const { ProviderChoices } = await import('@/components/sandbox/CloudProviderParts');
const { KEY_HELP, noCodeSetup, offersNoCode, SANDBOX_PROVIDERS } = await import('@/lib/sandbox/providers');

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
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

  it('renders the tab for Anthropic and cloud tests', () => {
    expect(render(live())).toContain('No code change');
    expect(render(live({ provider: 'azure-openai', endpointHost: 'acme.openai.azure.com' }))).toContain('No code change');
  });
});

describe('Connect: the agent name', () => {
  it('says to replace the placeholder while the code shows it', () => {
    expect(agentNameNote(PLACEHOLDER_AGENT)).toBe('Put your agent’s own name in place of test-agent. Any name works.');
    expect(agentNameNote('support-bot')).toBeNull();
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
  const src = read('../components/sandbox/TestRunFlow.tsx');
  it('asks for the API key, with the fleet token as a side note', () => {
    expect(src).toContain('htmlFor="sandbox-key">Your agent’s API key</label>');
    expect(src).not.toContain('or a WhiteRoom fleet token</span>');
    expect(src).toContain('Have a WhiteRoom fleet token? Paste it instead.');
    // Placeholder prefixes stay.
    expect(src).toContain('placeholder="sk-ant-…, sk-…, or wr_…"');
  });

  it('says where to find each key', () => {
    expect(KEY_HELP.anthropic).toBe('Find it at console.anthropic.com → API keys.');
    expect(KEY_HELP.openai).toBe('Find it at platform.openai.com → API keys.');
    expect(src).toContain('KEY_HELP[directProvider]');
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
