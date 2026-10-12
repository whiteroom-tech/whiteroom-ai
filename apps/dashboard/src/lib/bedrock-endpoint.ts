/**
 * The Bedrock Mantle endpoint for an AWS region, or for a Mantle URL pasted
 * in place of one.
 *
 * Claude on Bedrock with a Bedrock API key is served by the Mantle Messages
 * API at https://bedrock-mantle.{region}.api.aws/anthropic. The engine only
 * admits that host shape, and appends /v1/messages to the stored base, so
 * asking for the region alone keeps people from pasting a bedrock-runtime URL
 * or a path the engine would double up.
 */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const MANTLE_HOST = /^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/;

export function bedrockRegion(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (REGION.test(v)) return v;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const m = MANTLE_HOST.exec(url.hostname);
  return m && REGION.test(m[1]) ? m[1] : null;
}

export function bedrockMantleEndpoint(raw: string): string | null {
  const region = bedrockRegion(raw);
  return region ? `https://bedrock-mantle.${region}.api.aws/anthropic` : null;
}
