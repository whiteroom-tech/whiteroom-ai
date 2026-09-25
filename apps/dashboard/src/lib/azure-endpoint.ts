/**
 * The Azure OpenAI endpoint for whatever resource URL was pasted.
 *
 * The portal shows different hostnames depending on the resource kind — an
 * Azure OpenAI resource shows {name}.openai.azure.com, an AI Services / Foundry
 * resource shows {name}.cognitiveservices.azure.com or
 * {name}.services.ai.azure.com. All of them also answer on
 * {name}.openai.azure.com, which is the host the engine's Azure OpenAI path
 * is verified against, and any path pasted along with the URL is dropped.
 */
export function azureOpenAIEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const m = /^([a-z0-9][a-z0-9-]*)\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/i.exec(url.hostname);
  return m ? `https://${m[1].toLowerCase()}.openai.azure.com` : null;
}
