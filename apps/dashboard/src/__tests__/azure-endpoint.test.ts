import { describe, it, expect } from 'vitest';
import { azureOpenAIEndpoint } from '../lib/azure-endpoint';

describe('azureOpenAIEndpoint', () => {
  it('keeps an Azure OpenAI resource endpoint as the portal shows it', () => {
    expect(azureOpenAIEndpoint('https://acme.openai.azure.com/')).toBe('https://acme.openai.azure.com');
  });

  it('maps an AI Services / Foundry resource onto its Azure OpenAI host', () => {
    // those resources show a different hostname in the portal but also answer
    // on {name}.openai.azure.com, the host the engine is verified against
    expect(azureOpenAIEndpoint('https://acme.cognitiveservices.azure.com/')).toBe('https://acme.openai.azure.com');
    expect(azureOpenAIEndpoint('https://acme.services.ai.azure.com/')).toBe('https://acme.openai.azure.com');
  });

  it('drops a pasted path and normalizes case', () => {
    expect(azureOpenAIEndpoint('https://Acme.OpenAI.Azure.com/openai/deployments/x')).toBe('https://acme.openai.azure.com');
  });

  it('refuses anything that is not an Azure resource URL', () => {
    expect(azureOpenAIEndpoint('http://acme.openai.azure.com')).toBeNull();
    expect(azureOpenAIEndpoint('https://acme.openai.azure.com.evil.tld')).toBeNull();
    expect(azureOpenAIEndpoint('https://openai.azure.com')).toBeNull();
    expect(azureOpenAIEndpoint('https://api.openai.com')).toBeNull();
    expect(azureOpenAIEndpoint('not a url')).toBeNull();
  });
});
