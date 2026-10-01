// The base-URL setup lines, shown on Home with no agents and on Fleet key.
// One copy, so the two pages can't drift if the proxy URL changes.
export const PROXY_ORIGIN = 'https://proxy.whiteroom.tech';

export const SETUP_LINES = {
  anthropic: `export ANTHROPIC_BASE_URL=${PROXY_ORIGIN}`,
  openai: `export OPENAI_BASE_URL=${PROXY_ORIGIN}/v1`,
} as const;

export const SETUP_GUIDE_URL = 'https://whiteroom.tech/docs.html';
