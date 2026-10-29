import type { SandboxHomePreview } from '@/components/sandbox/v2/SandboxHome';

// /dev/sandbox-v2 sample states. Keys are placeholders, never real ones.
const NOW = Date.parse('2026-10-29T15:00:00Z');
const DAY = 86_400_000;
const KEY = { prefix: 'sk-wr-0123456789abcdef...', provider: 'anthropic', keyHint: 'AbCd' };
const connected = (lastCallAt: string | null) => ({
  exists: true as const,
  sandboxFleetId: 'sandbox-00000000-0000-4000-8000-000000000000',
  createdAt: new Date(NOW - 2 * DAY).toISOString(),
  lastCallAt,
  expiresAt: new Date((lastCallAt ? Date.parse(lastCallAt) : NOW - 2 * DAY) + 14 * DAY).toISOString(),
  key: KEY,
});
const ISSUED = {
  proxyKey: 'sk-wr-preview-placeholder',
  proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-preview-placeholder',
  provider: 'anthropic',
  keyHint: 'AbCd',
};

export const SANDBOX_V2_STATES = {
  /** No Sandbox yet: step 1. */
  'not-connected': { status: { exists: false }, now: NOW },
  /** Right after Connect: the key shown once, and no calls yet. */
  'just-connected': { status: connected(null), issued: ISSUED, now: NOW },
  /** Connected, the agent has called. */
  connected: { status: connected(new Date(NOW - 5 * 60_000).toISOString()), now: NOW },
  /** After Rotate key: a new key shown once. */
  rotated: { status: connected(new Date(NOW - 3 * 3_600_000).toISOString()), issued: { ...ISSUED, proxyKey: 'sk-wr-rotated-placeholder', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-rotated-placeholder' }, now: NOW },
  /** An OpenAI Sandbox right after Connect: the /v1 line. */
  openai: { status: { ...connected(null), key: { ...KEY, provider: 'openai' } }, issued: { ...ISSUED, provider: 'openai' }, now: NOW },
  /** The status couldn't be read. */
  error: { status: null, error: 'Couldn’t reach WhiteRoom. Check your connection and try again.', now: NOW },
  /** An action refused (rotate before any key). */
  refused: { status: connected(null), error: 'This Sandbox has no key yet. Connect a provider key first.', now: NOW },
} satisfies Record<string, SandboxHomePreview>;

export type SandboxV2State = keyof typeof SANDBOX_V2_STATES;
