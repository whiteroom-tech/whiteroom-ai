// Calls that reached WhiteRoom but didn't come back from the provider: it
// refused them (a bad key, an unknown model, a rate limit) or couldn't be
// reached. The engine reports them on the Sandbox status as failedCalls; an
// older engine leaves the field out, and the page then reads as it did before.

import { isCloudProvider, SANDBOX_PROVIDER_LABELS, type SandboxProvider } from './providers';
import type { FailedCalls, RunStatusResult } from './api';

export type { FailedCalls };

/** The run's failed calls, or null when there are none, the run is a demo, or the field is missing or malformed. */
export function failedCallsOf(run: RunStatusResult | null | undefined): FailedCalls | null {
  const f = run?.mode === 'demo' ? undefined : run?.failedCalls;
  if (!f || typeof f.count !== 'number' || !(f.count > 0) || !f.last || typeof f.last !== 'object') return null;
  const { status, reason, message } = f.last;
  return {
    count: Math.floor(f.count),
    last: {
      at: typeof f.last.at === 'string' ? f.last.at : '',
      agentId: typeof f.last.agentId === 'string' ? f.last.agentId : '',
      status: typeof status === 'number' ? status : 0,
      reason: reason === 'upstream_unreachable' ? 'upstream_unreachable' : 'upstream_error',
      message: typeof message === 'string' ? message.trim().slice(0, 200) : '',
    },
  };
}

type Kind = 'auth' | 'not_found' | 'rate_limit' | 'unreachable' | 'server' | 'request';

function kindOf(f: FailedCalls): Kind {
  const { reason, status } = f.last;
  if (reason === 'upstream_unreachable') return 'unreachable';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'request';
}

/** "1 call", "3 calls". */
export function callCount(n: number): string {
  return `${n} call${n === 1 ? '' : 's'}`;
}

/** The region of a Bedrock test, from its Mantle host. */
function bedrockRegionOf(endpointHost: string | null | undefined): string | null {
  return /^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/.exec(endpointHost ?? '')?.[1] ?? null;
}

/** Why the last call failed, in a few words: "Azure OpenAI refused the key (HTTP 401)". */
export function failedCallReason(f: FailedCalls, provider: SandboxProvider): string {
  const label = SANDBOX_PROVIDER_LABELS[provider];
  const status = f.last.status;
  const reason: Record<Kind, string> = {
    auth: `${label} refused the key (HTTP ${status})`,
    not_found: `${label} couldn’t find the model (HTTP 404)`,
    rate_limit: `${label} hit a rate limit or quota (HTTP 429)`,
    unreachable: `${label} couldn’t be reached`,
    server: `${label} returned an error (HTTP ${status})`,
    request: `${label} refused the request (HTTP ${status})`,
  };
  return reason[kindOf(f)];
}

/** Checks › Your agent connects, before any call has come back: "1 call failed — Azure OpenAI refused the key (HTTP 401)." */
export function failedCallsCheckDetail(f: FailedCalls, provider: SandboxProvider): string {
  return `${callCount(f.count)} failed — ${failedCallReason(f, provider)}.`;
}

/**
 * What went wrong with the last failed call, and what to check next, for the
 * "Its first call went through" step and the summary banner.
 */
export function failedCallNotice(f: FailedCalls, provider: SandboxProvider, endpointHost?: string | null): { what: string; next: string } {
  const label = SANDBOX_PROVIDER_LABELS[provider];
  const kind = kindOf(f);
  const said = f.last.message ? `: ${f.last.message}` : '.';
  const what = kind === 'unreachable'
    ? `Your agent’s call reached WhiteRoom, but ${label} couldn’t be reached${said}`
    : kind === 'server'
      ? `Your agent’s call reached WhiteRoom, but ${label} returned an error (HTTP ${f.last.status})${said}`
      : `Your agent’s call reached WhiteRoom, but ${label} refused it (HTTP ${f.last.status})${said}`;
  return { what, next: nextStep(kind, provider, endpointHost) };
}

function nextStep(kind: Kind, provider: SandboxProvider, endpointHost?: string | null): string {
  const label = SANDBOX_PROVIDER_LABELS[provider];
  const host = endpointHost ? ` (${endpointHost})` : '';
  const region = provider === 'bedrock-mantle' ? bedrockRegionOf(endpointHost) : null;
  const inRegion = region ? ` (${region})` : '';
  switch (kind) {
    case 'auth':
      if (provider === 'azure-openai') return `Check your agent’s key is for the Azure OpenAI resource this test started with${host}.`;
      if (provider === 'foundry') return `Check your agent’s key is for the Foundry resource this test started with${host}.`;
      if (provider === 'bedrock-mantle') return `Check your agent sends a Bedrock API key with access to Claude in the region this test started with${inRegion}. Short-term keys expire within 12 hours.`;
      return `Check your agent uses the same ${label} key you started this test with, and that the key is still active.`;
    case 'not_found':
      if (provider === 'azure-openai') return 'Check the model your agent asks for is your Azure deployment name, and the address matches the code above.';
      if (provider === 'foundry') return 'Check the model your agent asks for is your Foundry deployment name.';
      if (provider === 'bedrock-mantle') return `Check the model is a Bedrock model id available in${region ? ` ${region}` : ' your region'}, like anthropic.claude-haiku-4-5.`;
      return `Check the model name your agent asks for is one your ${label} key can use.`;
    case 'rate_limit':
      return `Your ${label} account hit a rate limit or quota. Wait a minute or check your quota, then run the task again.`;
    case 'unreachable':
      if (provider === 'bedrock-mantle') return `Check Claude is available on Bedrock in the region this test started with${inRegion}.`;
      if (isCloudProvider(provider)) return `Check the endpoint this test started with${host} is right and the resource is running.`;
      return 'This is usually brief. Run the task again in a minute.';
    case 'server':
      return `${label} had a problem on its side. Run the task again in a minute.`;
    case 'request':
      return 'Check the model name and settings your agent sends.';
  }
}
