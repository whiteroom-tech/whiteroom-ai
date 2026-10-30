import type { SandboxHomePreview } from '@/components/sandbox/v2/SandboxHome';
import type { SandboxRulesPreview } from '@/components/sandbox/v2/SandboxRules';
import type { SandboxChecksPreview } from '@/components/sandbox/v2/SandboxChecks';
import { CHECK_IDS, CHECK_NAMES, type CheckId, type CheckRule, type CheckStage, type CheckStatus } from '@/lib/sandbox/checks';
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

// Step 4: checks. Each check's status and detail, as the engine would send them.
type Results = Partial<Record<CheckId, [CheckStatus, string]>>;
const checkState = (stage: CheckStage | null, results: Results, opts: { calls?: number; ended?: boolean; rules?: CheckRule[] } = {}): SandboxChecksPreview => ({
  state: {
    window: stage && {
      id: 'chk_preview_1', startedAt: new Date(NOW - 6 * 60_000).toISOString(), endedAt: opts.ended ? new Date(NOW - 60_000).toISOString() : null,
      stage, injectErrors: true, calls: opts.calls ?? 14,
    },
    checks: CHECK_IDS.map((id) => ({ id, label: CHECK_NAMES[id], status: results[id]?.[0] ?? 'pending', detail: results[id]?.[1] ?? '' })),
    rules: opts.rules ?? [],
  },
  now: NOW,
});
const OBSERVED: Results = {
  long_task: ['passed', 'A hand-over happened and your agent carried on.'],
  finishes_correctly: ['not_checked', 'Run practice tasks to check this.'],
};
const RULES: CheckRule[] = [
  { ruleId: READY[0].id, ruleType: 'spend_cap', check: 'spend_cap', wouldAct: true, acted: true, status: 'passed', detail: 'Blocked at $0.02. Your agent stopped calling.' },
  { ruleId: READY[3].id, ruleType: 'model_allowlist', check: 'allowlists_keywords', wouldAct: true, acted: true, status: 'passed', detail: 'Refused claude-sonnet-4-5. Your agent backed off.' },
  { ruleId: READY[4].id, ruleType: 'keyword', check: 'allowlists_keywords', wouldAct: false, acted: false, status: 'not_triggered', detail: 'No secrets in this run. Try a prompt that mentions a password.' },
  { ruleId: READY[1].id, ruleType: 'loop_breaker', check: 'loop_rate', wouldAct: false, acted: false, status: 'not_triggered', detail: 'Needs the same call 3 times in a row.' },
  { ruleId: READY[2].id, ruleType: 'call_rate', check: 'loop_rate', wouldAct: false, acted: false, status: 'not_triggered', detail: 'Stayed under 10 calls a minute.' },
];
const ENFORCED: Results = {
  ...OBSERVED,
  spend_cap: ['passed', 'Blocked at $0.02, and your agent stopped calling.'],
  allowlists_keywords: ['passed', 'The model allowlist refused a call, and your agent backed off.'],
  loop_rate: ['not_triggered', 'Your agent didn’t repeat a call. The loop breaker needs the same call 3 times.'],
};
const PAUSED: Results = { ...ENFORCED };
const RESUMED: Results = { ...ENFORCED, pause_stop: ['passed', 'We paused your agent for 5 seconds → it carried on. We stopped it → its calls were refused until it was let go.'] };
const FINISHED: Results = { ...RESUMED, provider_errors: ['failed', 'Your agent retried 6 times in 4 seconds after a provider error. Add a back-off.'] };

const live = (extra: Partial<SandboxHomePreview>): SandboxHomePreview => ({ status: connected(new Date(NOW - 60_000).toISOString()), rules: rules({}), now: NOW, ...extra });

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
  /** Step 4: no check yet, waiting for the agent's first call. */
  'checks-ready': live({ checks: checkState(null, {}) }),
  /** Step 4: just started, no calls yet. */
  'checks-waiting': live({ checks: checkState('observe', {}, { calls: 0 }) }),
  /** Step 4: watching the agent's calls. */
  'checks-observe': live({ checks: checkState('observe', OBSERVED, { calls: 6 }) }),
  /** Step 4: enforcing one rule at a time (spend cap passed, allowlist next). */
  'checks-enforce': live({ checks: checkState('enforce', { ...OBSERVED, spend_cap: ENFORCED.spend_cap }, { rules: RULES.slice(0, 1) }) }),
  /** Step 4: the 10-second pause. */
  'checks-pause': live({ checks: checkState('pause', PAUSED, { rules: RULES }) }),
  /** Step 4: stopped for 5 seconds; the check lifts the stop itself. */
  'checks-stopped': live({ checks: checkState('stop', PAUSED, { rules: RULES }) }),
  /** Step 4: the provider error. */
  'checks-errors': live({ checks: checkState('errors', RESUMED, { rules: RULES }) }),
  /** Step 4: every stage done, the window still open. */
  'checks-done': live({ checks: checkState('done', FINISHED, { rules: RULES }) }),
  /** The report: the window ended. */
  'checks-report': live({ checks: checkState('done', FINISHED, { ended: true, rules: RULES, calls: 31 }) }),
  'checks-report-pass': live({ checks: checkState('done', { ...FINISHED, loop_rate: ['passed', 'Blocked a repeated call, and your agent changed course.'], provider_errors: ['passed', 'Backed off after a 529 and tried again later.'] }, { ended: true, calls: 42 }) }),
  'checks-report-few': live({ checks: checkState('done', {}, { ended: true, calls: 3 }) }),
  /** Step 4: the checks couldn't be read. */
  'checks-error': live({ checks: { state: null, error: 'The Sandbox couldn’t do that right now. Try again in a moment.', now: NOW } }),
  /** The Sandbox card: an agent called outside a check. */
  'outside-window': live({ status: { ...connected(new Date(NOW - 60_000).toISOString()), callsOutsideWindow24h: 42, lastCallOutsideWindowAt: new Date(NOW - 60_000).toISOString() } }),
} satisfies Record<string, SandboxHomePreview>;

export type SandboxV2State = keyof typeof SANDBOX_V2_STATES;
