import { afterEach, describe, expect, it, vi } from 'vitest';

// PROXY_ORIGIN is read when lib/setup loads (NEXT_PUBLIC_* is baked in at
// build time), so each case loads a fresh copy with the variable set.
async function loadSetup(proxyUrl?: string) {
  vi.resetModules();
  if (proxyUrl) vi.stubEnv('NEXT_PUBLIC_PROXY_URL', proxyUrl);
  return import('@/lib/setup');
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('setup lines and the build-time proxy URL', () => {
  it('uses the production engine when the build sets no URL', async () => {
    const setup = await loadSetup();
    expect(setup.PROXY_ORIGIN).toBe('https://proxy.whiteroom.tech');
    expect(setup.SETUP_LINES.anthropic).toBe('export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech');
  });

  it("points staging and EU builds' setup lines at their own engine", async () => {
    const setup = await loadSetup('https://eu.proxy.whiteroom.tech');
    expect(setup.SETUP_LINES.anthropic).toBe('export ANTHROPIC_BASE_URL=https://eu.proxy.whiteroom.tech');
    expect(setup.SETUP_LINES.openai).toBe('export OPENAI_BASE_URL=https://eu.proxy.whiteroom.tech/v1');
  });

  it('keeps the Bedrock role recipe on the prod engine, matching its prod principal', async () => {
    const setup = await loadSetup('https://eu.proxy.whiteroom.tech');
    expect(setup.BEDROCK_ROLE_SERVER_ID).toBe('proxy.whiteroom.tech');
    expect(setup.BEDROCK_ROLE_PRINCIPAL_ARN).toContain('whiteroom-engine-prod');
    const python = setup.BEDROCK_ROLE_LINES.python('us-east-1');
    expect(python).toContain('endpoint_url="https://proxy.whiteroom.tech"');
    expect(python).toContain('proxy_base_url="https://proxy.whiteroom.tech"');
    expect(python).not.toContain('eu.proxy');
  });
});
