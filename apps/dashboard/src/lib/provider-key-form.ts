// What the Fleet key page's "Provider keys" form checks before it sends a key,
// and what it sends. Pure, so the rules and the engine payload are testable
// without rendering the page.

import { azureOpenAIEndpoint } from '@/lib/azure-endpoint';
import { bedrockMantleEndpoint } from '@/lib/bedrock-endpoint';

export type ProviderTab = 'direct' | 'azure' | 'aws';

/** The store_key arguments: the engine names the provider itself only for sk-ant- / sk- keys. */
export interface ProviderKeyRequest {
  key: string;
  endpoint?: string;
  provider?: 'azure-openai' | 'bedrock-mantle';
}

export type ProviderKeyCheck = { ok: true; request: ProviderKeyRequest } | { ok: false; error: string };

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  azure: 'Azure OpenAI',
  'azure-openai': 'Azure OpenAI',
  'bedrock-mantle': 'AWS Bedrock',
};

export function providerKeyRequest(tab: ProviderTab, rawKey: string, rawEndpoint: string): ProviderKeyCheck {
  const key = rawKey.trim();
  if (tab === 'azure') {
    if (key.length < 12) return { ok: false, error: 'Enter your Azure API key (from the Azure portal → Keys and Endpoint).' };
    if (!rawEndpoint.trim()) return { ok: false, error: 'Enter your Azure endpoint URL (e.g. https://myresource.openai.azure.com).' };
    const endpoint = azureOpenAIEndpoint(rawEndpoint);
    if (!endpoint) return { ok: false, error: 'Endpoint must be your Azure resource URL (e.g. https://myresource.openai.azure.com).' };
    return { ok: true, request: { key, endpoint, provider: 'azure-openai' } };
  }
  if (tab === 'aws') {
    if (/^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(key)) {
      return { ok: false, error: 'That’s an AWS access key ID. Create a Bedrock API key instead (Bedrock console → API keys).' };
    }
    if (/^[A-Za-z0-9/+]{40}$/.test(key)) {
      return { ok: false, error: 'That looks like an AWS secret access key. Create a Bedrock API key instead (Bedrock console → API keys).' };
    }
    if (/^sk-/.test(key)) {
      return { ok: false, error: 'That looks like an Anthropic or OpenAI key. Add it under the Anthropic or OpenAI tab.' };
    }
    if (key.length < 20) return { ok: false, error: 'Enter your Bedrock API key (Bedrock console → API keys).' };
    if (!rawEndpoint.trim()) return { ok: false, error: 'Enter the AWS region your Bedrock models run in (e.g. us-east-1).' };
    const endpoint = bedrockMantleEndpoint(rawEndpoint);
    if (!endpoint) return { ok: false, error: 'Region must be an AWS region code like us-east-1 or eu-west-1.' };
    return { ok: true, request: { key, endpoint, provider: 'bedrock-mantle' } };
  }
  if (!/^sk-/.test(key) || key.length < 12) {
    return { ok: false, error: 'That does not look like a provider API key (sk-ant-… for Anthropic, sk-… for OpenAI).' };
  }
  return { ok: true, request: { key } };
}

/** Providers whose calls are the Anthropic Messages API, so they use the Anthropic SDK. */
export function isAnthropicWire(provider: string): boolean {
  return provider === 'anthropic' || provider === 'bedrock-mantle';
}

/** The environment line shown with a freshly issued proxy URL. */
export function issuedEnvHint(provider: string, url: string): string {
  if (provider === 'azure' || provider === 'azure-openai') return `export AZURE_OPENAI_ENDPOINT=${url}`;
  if (provider === 'openai') return `export OPENAI_BASE_URL=${url}/v1`;
  return `export ANTHROPIC_BASE_URL=${url}`;
}

/**
 * What the add-key form holds while someone types. The form is mounted per
 * provider tab (key={tab}), so switching tabs starts from EMPTY_KEY_FORM.
 */
export interface KeyFormState {
  value: string;
  endpoint: string;
  status: 'idle' | 'saving' | 'error';
  msg: string;
}

export type KeyFormAction =
  | { type: 'edit'; field: 'value' | 'endpoint'; text: string }
  | { type: 'saving' }
  /** A key was connected: clear what was typed. */
  | { type: 'connected' }
  | { type: 'error'; msg: string };

export const EMPTY_KEY_FORM: KeyFormState = { value: '', endpoint: '', status: 'idle', msg: '' };

export function keyFormReducer(state: KeyFormState, action: KeyFormAction): KeyFormState {
  switch (action.type) {
    case 'edit': return { ...state, [action.field]: action.text, status: 'idle' };
    case 'connected': return { ...state, value: '', endpoint: '', status: 'idle' };
    case 'saving': return { ...state, status: 'saving', msg: '' };
    case 'error': return { ...state, status: 'error', msg: action.msg };
  }
}

/**
 * The naming help shown with a freshly issued key: the SDK its calls use, and
 * whether the Claude Code line applies. Claude Code on a Bedrock key would
 * also need Bedrock model ids configured, so that line is left out there.
 */
export function agentNamingFor(provider: string): { provider: 'anthropic' | 'openai'; claudeCode: boolean } {
  return { provider: isAnthropicWire(provider) ? 'anthropic' : 'openai', claudeCode: provider !== 'bedrock-mantle' };
}
