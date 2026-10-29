import type { SandboxHomePreview } from '@/components/sandbox/v2/SandboxHome';
import type { SandboxRulesPreview } from '@/components/sandbox/v2/SandboxRules';
import { previewReadyMade } from '@/lib/sandbox/rules';
import type { GovernanceRule } from '@/lib/whiteroom/types';

// /dev/sandbox-v2 sample states. Keys are placeholders, never real ones.
const NOW = Date.parse('2026-10-29T15:00:00Z');
const DAY = 86_400_000;
const KEY = { prefix: 'sk-wr-0123456789abcdef...', provider: 'anthropic', keyHint: 'AbCd' };
const connected = (lastCallAt: string | null) => ({
  exists: true as const,
  sandboxFleetId: SANDBOX_ID,
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

const SANDBOX_ID = 'sandbox-00000000-0000-4000-8000-000000000000';
const READY = previewReadyMade(SANDBOX_ID);
const AGENTS = ['support-triage', 'contract-summarizer'];
const rules = (state: Partial<NonNullable<SandboxRulesPreview['state']>> | null, extra: Partial<SandboxRulesPreview> = {}): SandboxRulesPreview => ({
  state: state && { sandboxFleetId: SANDBOX_ID, rules: READY, source: 'ready_made', productionChanged: 0, ...state },
  productionRules: 3,
  agents: AGENTS,
  now: NOW,
  ...extra,
});
/** A copy of production's rules: some in Enforce, one for a single agent. */
const COPIED: GovernanceRule[] = [
  { ...READY[0], id: 'gr_preview_copy_spend', mode: 'enforce', response: 'pause', params: { dailyCap: 25, scope: 'day', unit: 'dollars' } },
  { ...READY[3], id: 'gr_preview_copy_models', mode: 'enforce', response: 'block', alsoNotify: true, params: { allowedModels: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'] } },
  { ...READY[4], id: 'gr_preview_copy_keywords', mode: 'watch', appliesTo: ['support-triage'], params: { keywords: ['password', 'ssn'], where: 'incoming', wholeWord: true } },
];

export const SANDBOX_V2_STATES = {
  /** No Sandbox yet: step 1. */
  'not-connected': { status: { exists: false }, now: NOW },
  /** Right after Connect: the key shown once, and no calls yet. */
  'just-connected': { status: connected(null), issued: ISSUED, now: NOW },
  /** Connected, the agent has called. */
  connected: { status: connected(new Date(NOW - 5 * 60_000).toISOString()), rules: rules({}), now: NOW },
  /** After Rotate key: a new key shown once. */
  rotated: { status: connected(new Date(NOW - 3 * 3_600_000).toISOString()), issued: { ...ISSUED, proxyKey: 'sk-wr-rotated-placeholder', proxyUrl: 'https://proxy.whiteroom.tech/sk-wr-rotated-placeholder' }, now: NOW },
  /** An OpenAI Sandbox right after Connect: the /v1 line. */
  openai: { status: { ...connected(null), key: { ...KEY, provider: 'openai' } }, issued: { ...ISSUED, provider: 'openai' }, now: NOW },
  /** The status couldn't be read. */
  error: { status: null, error: 'Couldn’t reach WhiteRoom. Check your connection and try again.', now: NOW },
  /** An action refused (rotate before any key). */
  refused: { status: connected(null), error: 'This Sandbox has no key yet. Connect a provider key first.', now: NOW },
  /** Step 3: the ready-made set, as applied on the first visit. Production has rules, so Copy shows. */
  'rules-ready-made': { status: connected(new Date(NOW - 5 * 60_000).toISOString()), rules: rules({}), now: NOW },
  /** Step 3: a copy of production's rules, and production changed since. */
  'rules-copy': { status: connected(new Date(NOW - 5 * 60_000).toISOString()), rules: rules({ rules: COPIED, source: 'production_copy', copiedAt: new Date(NOW - 2 * DAY).toISOString(), productionChanged: 2 }), now: NOW },
  /** Step 3: rules changed in the Sandbox; production has none, so no Copy. */
  'rules-custom': { status: connected(new Date(NOW - 5 * 60_000).toISOString()), rules: rules({ rules: [READY[1], { ...READY[0], mode: 'enforce' }], source: 'custom' }, { productionRules: 0 }), now: NOW },
  /** Step 3: every rule removed. */
  'rules-empty': { status: connected(new Date(NOW - 5 * 60_000).toISOString()), rules: rules({ rules: [], source: 'custom' }), now: NOW },
  /** Step 3: a rule open in the editor, in Enforce. */
  'rules-editing': { status: connected(new Date(NOW - 5 * 60_000).toISOString()), rules: rules({ rules: COPIED, source: 'production_copy', copiedAt: new Date(NOW - 2 * DAY).toISOString() }, { editing: 'gr_preview_copy_models' }), now: NOW },
  /** Step 3: the rules couldn't be read. */
  'rules-error': { status: connected(new Date(NOW - 5 * 60_000).toISOString()), rules: rules(null, { error: 'The Sandbox couldn’t do that right now. Try again in a moment.' }), now: NOW },
} satisfies Record<string, SandboxHomePreview>;

export type SandboxV2State = keyof typeof SANDBOX_V2_STATES;
