// Where a Sandbox test's agent sends its calls. Anthropic and OpenAI keys are
// recognised from their sk- prefix, as before. Azure OpenAI, Claude on Azure
// (Foundry) and AWS Bedrock need only the customer's own endpoint: the agent
// keeps sending its own key, and the engine answers with a sandbox proxy key
// (sk-wr-…) that the agent puts in its base URL. Pure, so the rules, the request and the
// recipes are testable without rendering the page.

import { azureOpenAIEndpoint } from '@/lib/azure-endpoint';
import { bedrockMantleEndpoint, bedrockRegion } from '@/lib/bedrock-endpoint';
import { BEDROCK_KEY_ENV } from '@/lib/setup';
import { safeGet, safeSet } from '@/lib/safe-storage';

export type DirectProvider = 'anthropic' | 'openai';
export type CloudProvider = 'azure-openai' | 'foundry' | 'bedrock-mantle';
export type SandboxProvider = DirectProvider | CloudProvider;
export type RecipeLanguage = 'Python' | 'JavaScript';

export const CLOUD_PROVIDERS: readonly CloudProvider[] = ['azure-openai', 'foundry', 'bedrock-mantle'];
export const SANDBOX_PROVIDERS: readonly SandboxProvider[] = ['anthropic', 'openai', ...CLOUD_PROVIDERS];

export function isCloudProvider(v: unknown): v is CloudProvider {
  return typeof v === 'string' && (CLOUD_PROVIDERS as readonly string[]).includes(v);
}

export function isSandboxProvider(v: unknown): v is SandboxProvider {
  return typeof v === 'string' && (SANDBOX_PROVIDERS as readonly string[]).includes(v);
}

export const SANDBOX_PROVIDER_LABELS: Record<SandboxProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'azure-openai': 'Azure OpenAI',
  foundry: 'Claude on Azure (Foundry)',
  'bedrock-mantle': 'AWS Bedrock',
};

/** "Azure OpenAI · acme.openai.azure.com" in the workspace; just the name when the host isn't known. */
export function providerSummary(provider: SandboxProvider, endpointHost?: string | null): string {
  const label = SANDBOX_PROVIDER_LABELS[provider];
  return isCloudProvider(provider) && endpointHost ? `${label} · ${endpointHost}` : label;
}

/** Where to find the key the Start form asks for, for Anthropic and OpenAI. */
export const KEY_HELP: Record<DirectProvider, string> = {
  anthropic: 'Find it in Claude Console → Settings → API keys.',
  openai: 'Find it at platform.openai.com → API keys.',
};

/**
 * What each cloud choice asks for, and where to find it. Only the endpoint:
 * the agent keeps sending its own key, and the test is tied to it by the
 * proxy key in the agent's base URL.
 */
export const CLOUD_FIELDS: Record<CloudProvider, {
  endpointLabel: string;
  endpointPlaceholder: string;
  endpointHelp: string;
  keyNote: string;
}> = {
  'azure-openai': {
    endpointLabel: 'Endpoint',
    endpointPlaceholder: 'https://my-resource.openai.azure.com',
    endpointHelp: 'Azure portal → your Azure OpenAI resource → Keys and Endpoint.',
    keyNote: 'Your agent keeps using its Azure OpenAI key. You don’t paste it here.',
  },
  foundry: {
    endpointLabel: 'Endpoint',
    endpointPlaceholder: 'https://my-resource.services.ai.azure.com/anthropic',
    endpointHelp: 'Foundry portal → your Claude deployment → Target URI. The resource URL works too.',
    keyNote: 'Your agent keeps using its Foundry key. You don’t paste it here.',
  },
  'bedrock-mantle': {
    endpointLabel: 'AWS region',
    endpointPlaceholder: 'us-east-1',
    endpointHelp: 'The region your Claude models run in, as shown in the Bedrock console.',
    keyNote: 'This test needs a Bedrock API key (Bedrock console → API keys). IAM credentials aren’t supported here. Your agent keeps its key; you don’t paste it here.',
  },
};

/**
 * Claude on Foundry is served at https://{resource}.services.ai.azure.com/anthropic,
 * the only host the engine admits for Foundry. The Target URI often carries a
 * path (/anthropic/v1/messages), so any path is dropped.
 */
export function foundryEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const m = /^([a-z0-9][a-z0-9-]*)\.services\.ai\.azure\.com$/i.exec(url.hostname);
  return m ? `https://${m[1].toLowerCase()}.services.ai.azure.com/anthropic` : null;
}

export type CloudStartCheck =
  | { ok: true; provider: CloudProvider; endpoint: string }
  | { ok: false; error: string };

/** Checks a cloud choice's endpoint before it is sent, and builds the endpoint the engine admits. */
export function cloudStart(provider: CloudProvider, rawEndpoint: string): CloudStartCheck {
  const raw = rawEndpoint.trim();
  const fields = CLOUD_FIELDS[provider];
  if (provider === 'bedrock-mantle') {
    if (!raw) return { ok: false, error: 'Enter the AWS region your Bedrock models run in, like us-east-1.' };
    const endpoint = bedrockMantleEndpoint(raw);
    return endpoint ? { ok: true, provider, endpoint } : { ok: false, error: 'Use an AWS region code like us-east-1 or eu-west-1.' };
  }
  if (!raw) return { ok: false, error: `Enter your endpoint, like ${fields.endpointPlaceholder}.` };
  if (provider === 'foundry') {
    const endpoint = foundryEndpoint(raw);
    if (endpoint) return { ok: true, provider, endpoint };
    return { ok: false, error: isAzureOpenAIHost(raw)
      ? 'Claude on Foundry uses your resource’s services.ai.azure.com address. Copy the Target URI from your Claude deployment.'
      : `Use your resource’s https address, like ${fields.endpointPlaceholder}.` };
  }
  const endpoint = azureOpenAIEndpoint(raw);
  return endpoint ? { ok: true, provider, endpoint } : { ok: false, error: `Use your resource’s https address, like ${fields.endpointPlaceholder}.` };
}

/** True when the URL's host is an Azure OpenAI or AI Services resource (not the Foundry host). */
function isAzureOpenAIHost(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return /^[a-z0-9][a-z0-9-]*\.(openai|cognitiveservices)\.azure\.com$/i.test(url.hostname);
}

/** Shown in the recipe when this tab has no proxy key for the test. */
export const PROXY_KEY_PLACEHOLDER = '<your-test-proxy-key>';

/** Where the agent's calls go: the dashboard's proxy URL with the test's proxy key as the first path segment. */
export function proxyKeyBase(proxyUrl: string, proxyKey: string | null | undefined): string {
  return `${proxyUrl.replace(/\/+$/, '')}/${proxyKey || PROXY_KEY_PLACEHOLDER}`;
}

/** Azure OpenAI's GA data-plane version, for the AzureOpenAI client variant. */
export const AZURE_API_VERSION = '2024-10-21';

/** What the start form's endpoint field holds: one value per cloud provider. */
export type CloudEndpoints = Partial<Record<CloudProvider, string>>;

export function withEndpoint(endpoints: CloudEndpoints, provider: CloudProvider, value: string): CloudEndpoints {
  return { ...endpoints, [provider]: value };
}

/** Where the start form keeps its endpoints between reloads (localStorage). */
export const ENDPOINTS_STORAGE = 'wr_sandbox_endpoints';

/**
 * What is kept of a typed endpoint: the region for Bedrock, else the checked
 * address the test would use. Nothing else that was pasted (a query string,
 * a key by mistake) is ever kept; a value that doesn't check out isn't either.
 */
export function endpointToRemember(provider: CloudProvider, raw: string): string | null {
  if (provider === 'bedrock-mantle') return bedrockRegion(raw);
  const check = cloudStart(provider, raw);
  return check.ok ? check.endpoint : null;
}

/** The endpoints to save, as stored text: only the ones worth restoring. */
export function endpointsToStore(endpoints: CloudEndpoints): string {
  const kept: CloudEndpoints = {};
  for (const p of CLOUD_PROVIDERS) {
    const v = endpoints[p] && endpointToRemember(p, endpoints[p]);
    if (v) kept[p] = v;
  }
  return JSON.stringify(kept);
}

/** The endpoints saved by endpointsToStore, checked again; anything unreadable is dropped. */
export function restorableEndpoints(saved: string | null): CloudEndpoints {
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved ?? 'null');
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: CloudEndpoints = {};
  for (const p of CLOUD_PROVIDERS) {
    const v = (parsed as Record<string, unknown>)[p];
    const kept = typeof v === 'string' ? endpointToRemember(p, v) : null;
    if (kept) out[p] = kept;
  }
  return out;
}

/** The start form's endpoints saved on this browser, checked again. */
export function savedEndpoints(): CloudEndpoints {
  return restorableEndpoints(safeGet(ENDPOINTS_STORAGE));
}

/** Saves the start form's endpoints. Not secrets: only checked addresses and regions are kept. */
export function saveEndpoints(endpoints: CloudEndpoints): void {
  safeSet(ENDPOINTS_STORAGE, endpointsToStore(endpoints));
}

/** Headers as a literal nested one level inside a client constructor call. */
export function headersLiteral(headers: Record<string, string>, indent: 2 | 4): string {
  return JSON.stringify(headers, null, indent).replace(/\n/g, `\n${' '.repeat(indent)}`);
}

/**
 * The client setup for a cloud test. Every call is named with
 * x-whiteroom-agent; the test itself is named by the proxy key in the URL, so
 * no fleet header is needed. Keys come from the environment, as in the
 * Anthropic and OpenAI recipes.
 */
export function cloudRecipe(provider: CloudProvider, base: string, agentId: string, language: RecipeLanguage): string {
  const headers = { 'x-whiteroom-agent': agentId };
  const py = headersLiteral(headers, 4);
  const js = headersLiteral(headers, 2);
  const q = JSON.stringify;

  if (provider === 'azure-openai') {
    const v1 = `${base}/openai/v1`;
    return language === 'Python'
      ? `# Option A: the OpenAI client\nimport os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url=${q(v1)},\n    api_key=os.environ["AZURE_OPENAI_API_KEY"],\n    default_headers=${py}\n)\n# Use this client for your agent's chat.completions calls,\n# with your Azure deployment name as the model.\n# Responses API calls aren't tested yet.\n\n# Option B: if your agent uses the AzureOpenAI client\nfrom openai import AzureOpenAI\n\nazure_client = AzureOpenAI(\n    azure_endpoint=${q(base)},\n    api_version=${q(AZURE_API_VERSION)},\n    default_headers=${py}\n)\n# Uses AZURE_OPENAI_API_KEY from your environment.`
      : `// Option A: the OpenAI client\nimport OpenAI from 'openai';\n\nconst client = new OpenAI({\n  baseURL: ${q(v1)},\n  apiKey: process.env.AZURE_OPENAI_API_KEY,\n  defaultHeaders: ${js}\n});\n// Use this client for your agent's chat.completions calls,\n// with your Azure deployment name as the model.\n// Responses API calls aren't tested yet.\n\n// Option B: if your agent uses the AzureOpenAI client\nimport { AzureOpenAI } from 'openai';\n\nconst azureClient = new AzureOpenAI({\n  endpoint: ${q(base)},\n  apiVersion: ${q(AZURE_API_VERSION)},\n  defaultHeaders: ${js}\n});\n// Uses AZURE_OPENAI_API_KEY from your environment.`;
  }

  const env = provider === 'foundry' ? 'ANTHROPIC_FOUNDRY_API_KEY' : BEDROCK_KEY_ENV;
  const model = provider === 'foundry'
    ? { py: '# with your Foundry deployment name as the model.\n# Using AnthropicFoundry? Pass base_url= (above) instead of resource=.', js: '// with your Foundry deployment name as the model.\n// Using AnthropicFoundry? Pass baseURL (above) instead of resource.' }
    : { py: '# with a Bedrock model id as the model, like anthropic.claude-haiku-4-5.', js: '// with a Bedrock model id as the model, like anthropic.claude-haiku-4-5.' };
  return language === 'Python'
    ? `import os\nimport anthropic\n\nclient = anthropic.Anthropic(\n    base_url=${q(base)},\n    api_key=os.environ["${env}"],\n    default_headers=${py}\n)\n# Use this client for your agent's messages calls,\n${model.py}`
    : `import Anthropic from '@anthropic-ai/sdk';\n\nconst client = new Anthropic({\n  baseURL: ${q(base)},\n  apiKey: process.env.${env},\n  defaultHeaders: ${js}\n});\n// Use this client for your agent's messages calls,\n${model.js}`;
}

/** The engine names an unsupported provider this way (an engine without cloud Sandbox support). */
export function isUnsupportedProviderError(message: unknown): boolean {
  return typeof message === 'string' && /^(Unknown provider\b|provider must be one of\b)/.test(message);
}

export const PROVIDER_UNSUPPORTED = 'provider_unsupported';

export function unsupportedProviderMessage(provider: CloudProvider): string {
  return `Tests with ${SANDBOX_PROVIDER_LABELS[provider]} aren’t available yet. Use an Anthropic or OpenAI key for now.`;
}

/** The engine's refusals of an endpoint for its provider (wrong host shape, not allowed). */
export function isEndpointError(message: unknown): boolean {
  return typeof message === 'string' && /^(Provider "|Invalid endpoint)/.test(message);
}

export function endpointMismatchMessage(provider: CloudProvider): string {
  return `That endpoint doesn’t match ${SANDBOX_PROVIDER_LABELS[provider]}. Check it and try again.`;
}

/**
 * The provider to restore from storage on load: a known one that this page
 * hasn't seen the engine refuse. Anything else starts from the default.
 */
export function restorableProvider(saved: string | null, unsupported: readonly CloudProvider[]): SandboxProvider | null {
  if (!isSandboxProvider(saved)) return null;
  return isCloudProvider(saved) && unsupported.includes(saved) ? null : saved;
}

/** After the engine refuses a provider: that choice is disabled, and the form falls back to Anthropic. */
export function withUnsupported(list: readonly CloudProvider[], provider: CloudProvider): { unsupported: CloudProvider[]; provider: SandboxProvider } {
  return { unsupported: list.includes(provider) ? [...list] : [...list, provider], provider: 'anthropic' };
}

/**
 * Whether Connect offers "No code change" for this provider: only where
 * noCodeSetup has something that works to copy. An OpenAI test needs the
 * x-whiteroom-fleet header, which the OpenAI SDK can't take from the
 * environment, so it isn't offered there.
 */
export function offersNoCode(provider: SandboxProvider): boolean {
  return provider !== 'openai';
}

/**
 * Connect › No code change: environment variables in place of the client
 * setup, where they can carry everything this test needs.
 *
 * - A cloud test is named by the proxy key in its URL, so the base-URL
 *   variable is enough for an agent with a system prompt (WhiteRoom names it
 *   from that). One without needs x-whiteroom-agent, which these SDKs can't
 *   take from the environment.
 * - An Anthropic or OpenAI test is named by the x-whiteroom-fleet header:
 *   without it, calls go to the key's own fleet, not this test. Neither SDK
 *   reads headers from the environment. Claude Code does
 *   (ANTHROPIC_CUSTOM_HEADERS), so it is the one direct case shown.
 *
 * `code` is null when there is nothing that works to copy.
 */
export function noCodeSetup(provider: SandboxProvider, opts: { proxyUrl: string; base: string; fleetId: string }): { lead: string; code: string | null; note?: string } {
  const unnamed = 'Agents without a system prompt also need the x-whiteroom-agent header, so use the Python or JavaScript setup for them.';
  switch (provider) {
    case 'anthropic':
      return {
        lead: 'This test needs the x-whiteroom-fleet header, and the Anthropic SDK can’t read headers from environment variables, so most agents need the Python or JavaScript setup. Claude Code can: it reads extra headers from ANTHROPIC_CUSTOM_HEADERS.',
        code: `# Claude Code\nexport ANTHROPIC_BASE_URL=${opts.proxyUrl.replace(/\/+$/, '')}\nexport ANTHROPIC_CUSTOM_HEADERS="x-whiteroom-fleet: ${opts.fleetId}"\n# Uses the Anthropic API key you started this test with.`,
      };
    case 'openai':
      return {
        lead: 'This test needs the x-whiteroom-fleet header, and the OpenAI SDK can’t read headers from environment variables. Use the Python or JavaScript setup for this test.',
        code: null,
      };
    case 'azure-openai':
      return {
        lead: 'No code change if your agent uses the AzureOpenAI client and reads its endpoint from the environment.',
        code: `export AZURE_OPENAI_ENDPOINT=${opts.base}\n# AZURE_OPENAI_API_KEY and your api-version stay as they are.`,
        note: unnamed,
      };
    case 'foundry':
      return {
        lead: 'No code change if your agent uses the Anthropic client and reads its settings from the environment. With AnthropicFoundry, use the Python or JavaScript setup.',
        code: `export ANTHROPIC_BASE_URL=${opts.base}\nexport ANTHROPIC_API_KEY="$ANTHROPIC_FOUNDRY_API_KEY"\n# Use your Foundry deployment name as the model.`,
        note: unnamed,
      };
    case 'bedrock-mantle':
      return {
        lead: 'No code change if your agent uses the Anthropic client and reads its settings from the environment.',
        code: `export ANTHROPIC_BASE_URL=${opts.base}\nexport ANTHROPIC_API_KEY="$${BEDROCK_KEY_ENV}"\n# Use a Bedrock model id as the model, like anthropic.claude-haiku-4-5.`,
        note: unnamed,
      };
  }
}

export type KeyKind = 'anthropic' | 'openai' | 'fleet' | 'account' | 'unknown' | 'empty';

/** What a pasted value is, from its prefix: an Anthropic or OpenAI key, a WhiteRoom key (fleet wr_ or account sk-wr-), or neither. */
export function detectKey(value: string): KeyKind {
  const v = value.trim();
  if (!v) return 'empty';
  if (v.startsWith('wr_')) return 'fleet';
  if (v.startsWith('sk-wr-')) return 'account';
  if (v.startsWith('sk-ant-')) return 'anthropic';
  if (v.startsWith('sk-')) return 'openai';
  return 'unknown';
}
