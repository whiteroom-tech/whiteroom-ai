// Sandbox v2 rules (spec sandbox-v2 §1 decision 3, §2 step 3, §4, §8.2): the
// normal governance rules, on the Sandbox fleet. The browser talks to
// /api/sandbox/rules/<action>, which checks the signed-in user owns the
// production fleet and calls only the engine's sandbox_rules_* /
// sandbox_rule_* actions — never a production rule write.
//
// Pure parts (the request checks and the answer parsing) are shared with the
// BFF, so both agree on what a valid request and a valid answer look like.

import { fmtDay } from '@/lib/format';
import type { GovernanceMode, GovernanceParams, GovernanceResponse, GovernanceRule, GovernanceRuleType, GovernanceScope } from '@/lib/whiteroom/types';
import { sandboxPost, SandboxFleetError } from './fleet';

export const SANDBOX_RULES_ACTIONS = ['list', 'ready-made', 'copy-production', 'create', 'update', 'delete'] as const;
export type SandboxRulesAction = (typeof SANDBOX_RULES_ACTIONS)[number];

/** Each BFF action's engine action: Sandbox-only, all of them. */
export const SANDBOX_RULES_ENGINE_ACTION: Record<SandboxRulesAction, string> = {
  list: 'sandbox_rules_list',
  'ready-made': 'sandbox_rules_apply_ready_made',
  'copy-production': 'sandbox_rules_copy_production',
  create: 'sandbox_rule_create',
  update: 'sandbox_rule_update',
  delete: 'sandbox_rule_delete',
};

export function isSandboxRulesAction(v: unknown): v is SandboxRulesAction {
  return typeof v === 'string' && (SANDBOX_RULES_ACTIONS as readonly string[]).includes(v);
}

export type SandboxRulesSource = 'ready_made' | 'production_copy' | 'custom' | null;

export interface SandboxRulesState {
  sandboxFleetId: string;
  rules: GovernanceRule[];
  /** Null: no rules set up yet — the page applies the ready-made set once. */
  source: SandboxRulesSource;
  /** When production's rules were copied (production_copy). */
  copiedAt?: string;
  /** Production rule changes since that copy. */
  productionChanged: number;
}

/** The one line on Sandbox and in the confirm dialogs. */
export const SANDBOX_RULES_ONLY = 'These rules apply only to your Sandbox. Your live rules don’t change.';

const RULE_TYPES: readonly GovernanceRuleType[] = ['spend_cap', 'loop_breaker', 'model_allowlist', 'tool_list', 'call_rate', 'keyword'];
const MODES: readonly GovernanceMode[] = ['off', 'watch', 'enforce'];
const RESPONSES: readonly GovernanceResponse[] = ['notify', 'block', 'pause', 'stop'];
const SOURCES: readonly Exclude<SandboxRulesSource, null>[] = ['ready_made', 'production_copy', 'custom'];
const RULE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const AGENT_MAX = 100;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isScope = (v: unknown): v is GovernanceScope =>
  v === 'all' || (Array.isArray(v) && v.length <= AGENT_MAX && v.every((a) => str(a, 128)));

/** One rule of an engine answer, with only the fields the page uses; null when it isn't one. */
export function ruleOf(v: unknown): GovernanceRule | null {
  if (!isObj(v)) return null;
  if (!str(v.id, 128) || !RULE_TYPES.includes(v.ruleType as GovernanceRuleType) || !MODES.includes(v.mode as GovernanceMode) || !isObj(v.params)) return null;
  if (typeof v.version !== 'number' || !Number.isFinite(v.version)) return null;
  return {
    id: v.id,
    fleetId: str(v.fleetId, 160) ? v.fleetId : '',
    ruleType: v.ruleType as GovernanceRuleType,
    params: v.params as unknown as GovernanceParams,
    mode: v.mode as GovernanceMode,
    ...(RESPONSES.includes(v.response as GovernanceResponse) && { response: v.response as GovernanceResponse }),
    ...(typeof v.alsoNotify === 'boolean' && { alsoNotify: v.alsoNotify }),
    appliesTo: isScope(v.appliesTo) ? v.appliesTo : 'all',
    version: v.version,
    changedBy: str(v.changedBy, 256) ? v.changedBy : '',
    changedAt: str(v.changedAt, 64) ? v.changedAt : '',
  };
}

/** The rules answer (list, ready-made, copy), or null when it isn't one. */
export function rulesStateOf(data: unknown): SandboxRulesState | null {
  if (!isObj(data) || !str(data.sandboxFleetId, 128) || !Array.isArray(data.rules)) return null;
  // Only a missing source means "none set up yet"; one this page doesn't know is treated as the user's own, never replaced.
  const source = data.source === null || data.source === undefined ? null : SOURCES.includes(data.source as Exclude<SandboxRulesSource, null>) ? (data.source as SandboxRulesSource) : 'custom';
  const changed = typeof data.productionChanged === 'number' && Number.isInteger(data.productionChanged) && data.productionChanged > 0 ? data.productionChanged : 0;
  return {
    sandboxFleetId: data.sandboxFleetId,
    rules: data.rules.map(ruleOf).filter((r): r is GovernanceRule => r !== null),
    source,
    ...(str(data.copiedAt, 64) && { copiedAt: data.copiedAt }),
    productionChanged: changed,
  };
}

/** What the source line says, and whether to offer Copy again. */
export function sourceLine(state: Pick<SandboxRulesState, 'source' | 'copiedAt' | 'productionChanged'>, now = Date.now()): { text: string; changed: string | null } {
  if (state.source === 'ready_made') return { text: 'Ready-made set — easy to trip on a short run. All start in Watch.', changed: null };
  if (state.source === 'production_copy') {
    const day = state.copiedAt ? fmtDay(state.copiedAt, now) : '';
    const n = state.productionChanged;
    return {
      text: day ? `Copy of your production rules from ${day}` : 'Copy of your production rules',
      changed: n > 0 ? `Production has ${n} newer ${n === 1 ? 'change' : 'changes'}` : null,
    };
  }
  if (state.source === 'custom') return { text: 'Your own Sandbox rules.', changed: null };
  return { text: 'No Sandbox rules yet.', changed: null };
}

/** The ready-made set, for /dev previews only: what the engine applies (spec §4), all in Watch. The page never sends it. */
export function previewReadyMade(sandboxFleetId: string): GovernanceRule[] {
  const base = { fleetId: sandboxFleetId, mode: 'watch' as const, response: 'block' as const, appliesTo: 'all' as const, version: 1, changedBy: 'WhiteRoom', changedAt: '2026-10-29T14:00:00.000Z' };
  return [
    { ...base, id: 'gr_preview_spend', ruleType: 'spend_cap', params: { dailyCap: 0.02, scope: 'run', unit: 'dollars' } },
    { ...base, id: 'gr_preview_loop', ruleType: 'loop_breaker', params: { threshold: 3, scope: 'run', ignoreTools: [] } },
    { ...base, id: 'gr_preview_rate', ruleType: 'call_rate', params: { maxCalls: 10 } },
    { ...base, id: 'gr_preview_models', ruleType: 'model_allowlist', params: { allowedModels: ['claude-haiku-4-5-20251001'] } },
    { ...base, id: 'gr_preview_keywords', ruleType: 'keyword', params: { keywords: ['api key', 'password', 'token'], where: 'both', wholeWord: true } },
  ];
}

// ── Requests ──

export interface SandboxRuleFields {
  mode?: GovernanceMode;
  response?: GovernanceResponse;
  alsoNotify?: boolean;
  params?: GovernanceParams;
  appliesTo?: GovernanceScope;
  description?: string;
}

export type RuleCheck = { ok: true; request: Record<string, unknown> } | { ok: false; error: string };

/** The engine fields of a create or update, from known fields only (snake_case, as the engine takes them). */
function ruleFields(b: Record<string, unknown>): RuleCheck {
  const out: Record<string, unknown> = {};
  if (b.mode !== undefined) { if (!MODES.includes(b.mode as GovernanceMode)) return { ok: false, error: 'Invalid request.' }; out.mode = b.mode; }
  if (b.response !== undefined) { if (!RESPONSES.includes(b.response as GovernanceResponse)) return { ok: false, error: 'Invalid request.' }; out.response = b.response; }
  if (b.alsoNotify !== undefined) { if (typeof b.alsoNotify !== 'boolean') return { ok: false, error: 'Invalid request.' }; out.also_notify = b.alsoNotify; }
  // A rule's settings differ by type; the engine checks them with Controls' own validation (governance buildRule), as it does for production rules.
  if (b.params !== undefined) { if (!isObj(b.params)) return { ok: false, error: 'Invalid request.' }; out.params = b.params; }
  if (b.appliesTo !== undefined) { if (!isScope(b.appliesTo)) return { ok: false, error: 'Invalid request.' }; out.applies_to = b.appliesTo; }
  if (b.description !== undefined) { if (!str(b.description, 200)) return { ok: false, error: 'Invalid request.' }; out.description = b.description; }
  return { ok: true, request: out };
}

/** A create's engine fields: a known rule type and the rule's own fields. */
export function ruleCreateCheck(b: Record<string, unknown>): RuleCheck {
  if (!RULE_TYPES.includes(b.ruleType as GovernanceRuleType)) return { ok: false, error: 'Invalid request.' };
  const f = ruleFields(b);
  return f.ok ? { ok: true, request: { rule_type: b.ruleType, ...f.request } } : f;
}

/** An update's engine fields: the rule, the version it was read at, and what changed. */
export function ruleUpdateCheck(b: Record<string, unknown>): RuleCheck {
  if (!str(b.ruleId, 128) || !RULE_ID_RE.test(b.ruleId)) return { ok: false, error: 'Invalid request.' };
  if (b.ifVersion !== undefined && !(typeof b.ifVersion === 'number' && Number.isInteger(b.ifVersion) && b.ifVersion >= 0)) return { ok: false, error: 'Invalid request.' };
  const f = ruleFields(b);
  if (!f.ok) return f;
  // An update that changes nothing isn't sent.
  if (!Object.keys(f.request).length) return { ok: false, error: 'Nothing to change.' };
  return { ok: true, request: { rule_id: b.ruleId, ...(b.ifVersion !== undefined && { if_version: b.ifVersion }), ...f.request } };
}

/** A delete's engine fields: the rule only. */
export function ruleDeleteCheck(b: Record<string, unknown>): RuleCheck {
  if (!str(b.ruleId, 128) || !RULE_ID_RE.test(b.ruleId)) return { ok: false, error: 'Invalid request.' };
  return { ok: true, request: { rule_id: b.ruleId } };
}

// ── Browser calls (through the BFF) ──

const unreadable = () => new SandboxFleetError('WhiteRoom sent an answer the dashboard couldn’t read. Try again.', 502);
const post = (action: SandboxRulesAction, fleet: string, sandboxFleetId: string, body: Record<string, unknown> = {}) =>
  sandboxPost(`/api/sandbox/rules/${action}`, { fleet, sandboxFleetId, ...body });

async function stateCall(action: 'list' | 'ready-made' | 'copy-production', fleet: string, sandboxFleetId: string): Promise<SandboxRulesState> {
  const state = rulesStateOf(await post(action, fleet, sandboxFleetId));
  if (!state) throw unreadable();
  return state;
}

export const listSandboxRules = (fleet: string, sandboxFleetId: string) => stateCall('list', fleet, sandboxFleetId);
export const applyReadyMadeRules = (fleet: string, sandboxFleetId: string) => stateCall('ready-made', fleet, sandboxFleetId);
export const copyProductionRules = (fleet: string, sandboxFleetId: string) => stateCall('copy-production', fleet, sandboxFleetId);

async function ruleCall(action: 'create' | 'update', fleet: string, sandboxFleetId: string, body: Record<string, unknown>): Promise<GovernanceRule> {
  const rule = ruleOf((await post(action, fleet, sandboxFleetId, body)).rule);
  if (!rule) throw unreadable();
  return rule;
}

export const createSandboxRule = (fleet: string, sandboxFleetId: string, rule: { ruleType: GovernanceRuleType } & SandboxRuleFields) =>
  ruleCall('create', fleet, sandboxFleetId, { ...rule });
export const updateSandboxRule = (fleet: string, sandboxFleetId: string, ruleId: string, changes: SandboxRuleFields & { ifVersion?: number }) =>
  ruleCall('update', fleet, sandboxFleetId, { ruleId, ...changes });
export async function deleteSandboxRule(fleet: string, sandboxFleetId: string, ruleId: string): Promise<void> {
  await post('delete', fleet, sandboxFleetId, { ruleId });
}
