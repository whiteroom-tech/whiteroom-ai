// Sandbox v2 checks (spec sandbox-v2 §2 steps 4–5, §5): a checking window on
// the Sandbox fleet, judged stage by stage. The browser talks to
// /api/sandbox/checks/<action>, which checks the signed-in user owns the
// production fleet and calls only the engine's sandbox_check_* actions.
//
// Pure parts (the request check and the answer parsing) are shared with the
// BFF, so both agree on what a valid request and a valid answer look like.

import { timeAgo } from '@/lib/format';
import { sandboxPost, SandboxFleetError } from './fleet';

export const SANDBOX_CHECKS_ACTIONS = ['status', 'start', 'stop', 'resume'] as const;
export type SandboxChecksAction = (typeof SANDBOX_CHECKS_ACTIONS)[number];

/** Each BFF action's engine action: Sandbox-only, all of them. */
export const SANDBOX_CHECKS_ENGINE_ACTION: Record<SandboxChecksAction, string> = {
  status: 'sandbox_check_status',
  start: 'sandbox_check_start',
  stop: 'sandbox_check_stop',
  resume: 'sandbox_check_resume',
};

export function isSandboxChecksAction(v: unknown): v is SandboxChecksAction {
  return typeof v === 'string' && (SANDBOX_CHECKS_ACTIONS as readonly string[]).includes(v);
}

/** The seven checks, in the engine's fixed order. */
export const CHECK_IDS = ['spend_cap', 'loop_rate', 'allowlists_keywords', 'pause_stop', 'long_task', 'provider_errors', 'finishes_correctly'] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** Names used when the engine sends none. */
export const CHECK_NAMES: Record<CheckId, string> = {
  spend_cap: 'Spend cap',
  loop_rate: 'Loops and call rate',
  allowlists_keywords: 'Allowlists and keywords',
  pause_stop: 'Pause and stop',
  long_task: 'Long task',
  provider_errors: 'Provider errors',
  finishes_correctly: 'Finishes the job correctly',
};

export const CHECK_STATUSES = ['pending', 'passed', 'failed', 'not_triggered', 'not_checked'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export const CHECK_STAGES = ['observe', 'enforce', 'pause', 'stop', 'errors', 'done'] as const;
export type CheckStage = (typeof CHECK_STAGES)[number];

export interface CheckWindow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  stage: CheckStage;
  injectErrors: boolean;
  calls: number;
}

export interface CheckResult {
  id: CheckId;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface CheckRule {
  ruleId: string;
  ruleType: string;
  check: CheckId | null;
  wouldAct: boolean;
  acted: boolean;
  status: CheckStatus;
  detail: string;
}

export interface CheckState {
  window: CheckWindow | null;
  checks: CheckResult[];
  rules: CheckRule[];
  /** The agent, live: its last call to the Sandbox and its calls outside a check. Absent from an older engine. */
  activity?: { lastCallAt: string | null; callsOutsideWindow24h: number };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const text = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

function windowOf(v: unknown): CheckWindow | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !str(v.id, 128) || !str(v.startedAt, 64) || !oneOf(CHECK_STAGES, v.stage)) return undefined;
  return {
    id: v.id,
    startedAt: v.startedAt,
    endedAt: str(v.endedAt, 64) ? v.endedAt : null,
    stage: v.stage,
    injectErrors: v.injectErrors !== false,
    calls: typeof v.calls === 'number' && Number.isFinite(v.calls) && v.calls >= 0 ? Math.floor(v.calls) : 0,
  };
}

/**
 * The check status answer, with only the fields the page uses, or null when
 * it isn't one. The seven checks always come back in the fixed order, a
 * missing one as "pending".
 */
export function checkStateOf(data: unknown): CheckState | null {
  if (!isObj(data)) return null;
  const window = windowOf(data.window);
  if (window === undefined || !Array.isArray(data.checks)) return null;
  const given = new Map<string, Record<string, unknown>>();
  for (const c of data.checks) if (isObj(c) && oneOf(CHECK_IDS, c.id)) given.set(c.id, c);
  const checks = CHECK_IDS.map((id): CheckResult => {
    const c = given.get(id);
    return {
      id,
      label: c && str(c.label, 80) ? c.label : CHECK_NAMES[id],
      status: c && oneOf(CHECK_STATUSES, c.status) ? c.status : 'pending',
      detail: text(c?.detail),
    };
  });
  const rules = (Array.isArray(data.rules) ? data.rules : []).slice(0, 50).flatMap((r): CheckRule[] => {
    if (!isObj(r) || !str(r.ruleId, 128) || !str(r.ruleType, 64)) return [];
    return [{
      ruleId: r.ruleId,
      ruleType: r.ruleType,
      check: oneOf(CHECK_IDS, r.check) ? r.check : null,
      wouldAct: r.wouldAct === true,
      acted: r.acted === true,
      status: oneOf(CHECK_STATUSES, r.status) ? r.status : 'pending',
      detail: text(r.detail),
    }];
  });
  const a = isObj(data.activity) ? data.activity : null;
  const activity = a ? {
    lastCallAt: str(a.lastCallAt, 40) && Number.isFinite(Date.parse(a.lastCallAt)) ? a.lastCallAt : null,
    callsOutsideWindow24h: Number.isSafeInteger(a.callsOutsideWindow24h) && (a.callsOutsideWindow24h as number) >= 0 ? a.callsOutsideWindow24h as number : 0,
  } : undefined;
  return activity ? { window, checks, rules, activity } : { window, checks, rules };
}

/** A call this recent means the agent is calling now. */
export const CALLING_MS = 60_000;

const ago = (ms: number, now: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${Math.max(1, s)} s ago` : timeAgo(now - ms, now);
};

/**
 * Step 4's live line: is the agent calling, and is this run being checked? Null before the
 * engine says (an older engine) or before any call while waiting for the first.
 */
export function activityLine(state: CheckState, now = Date.now()): { calling: boolean; text: string } | null {
  const a = state.activity;
  if (!a?.lastCallAt) return null;
  const since = Math.max(0, now - Date.parse(a.lastCallAt));
  const calling = since < CALLING_MS;
  const w = state.window;
  const last = `last call ${ago(since, now)}`;
  if (w && !w.endedAt) {
    const checked = `${w.calls} ${w.calls === 1 ? 'call' : 'calls'} checked`;
    return calling
      ? { calling, text: `Your agent is calling the Sandbox · ${last} · ${checked}` }
      : { calling, text: `Your agent stopped calling · ${last} · ${checked}. The check carries on when it calls again.` };
  }
  return calling
    ? { calling, text: `Your agent is calling the Sandbox · ${last}. This check has finished; its next run starts a new one.` }
    : { calling, text: `Your agent’s ${last}. A new check starts on its next run.` };
}

export type StartCheck = { ok: true; request: { inject_errors?: boolean } } | { ok: false; error: string };

/** What Start may send: the provider-error toggle only. */
export function startCheck(body: Record<string, unknown>): StartCheck {
  if (body.injectErrors === undefined) return { ok: true, request: {} };
  if (typeof body.injectErrors !== 'boolean') return { ok: false, error: 'Invalid request.' };
  return { ok: true, request: { inject_errors: body.injectErrors } };
}

// ── Wording ──

/** The order rules are enforced in (spec §5 stage 2). */
const ENFORCE_ORDER: CheckId[] = ['spend_cap', 'allowlists_keywords', 'loop_rate'];

/** The live stage line in plain words. */
export function stageLine(state: CheckState): string {
  const w = state.window;
  if (!w) return '';
  if (w.endedAt) return 'Done';
  switch (w.stage) {
    case 'observe': return 'Watching your agent’s calls…';
    case 'enforce': {
      const now = ENFORCE_ORDER.map((id) => state.checks.find((c) => c.id === id)).find((c) => c?.status === 'pending');
      return now ? `Testing ${now.label}…` : 'Testing your rules…';
    }
    case 'pause': return 'Paused your agent for 5 seconds…';
    case 'stop': return 'Your agent is stopped for 5 seconds, then it can call again. Resume lets it go now.';
    case 'errors': return 'Sending a provider error…';
    case 'done': return 'Done. Stop checking to see your report.';
  }
}

export const STATUS_WORDS: Record<CheckStatus, string> = {
  pending: 'Waiting',
  passed: 'Passed',
  failed: 'Failed',
  not_triggered: 'Not triggered by this run',
  not_checked: 'Not checked',
};

/** The window is open: the page polls and shows the live list. */
export const isOpen = (state: CheckState | null) => !!state?.window && !state.window.endedAt;

// ── Browser calls (through the BFF) ──

const call = (action: SandboxChecksAction, body: Record<string, unknown>) => sandboxPost(`/api/sandbox/checks/${action}`, body);

function mustState(data: unknown): CheckState {
  const state = checkStateOf(data);
  if (!state) throw new SandboxFleetError('WhiteRoom sent an answer the dashboard couldn’t read. Try again.', 502);
  return state;
}

export async function getCheckState(fleet: string, sandboxFleetId: string): Promise<CheckState> {
  return mustState(await call('status', { fleet, sandboxFleetId }));
}

/** Start, Stop or Resume; then the current state (the answer's own, or a fresh read). */
/** Start (Check again, provider-error test on), Stop or Resume. */
export async function checkAction(action: Exclude<SandboxChecksAction, 'status'>, fleet: string, sandboxFleetId: string): Promise<CheckState> {
  const data = await call(action, { fleet, sandboxFleetId });
  return checkStateOf(data) ?? getCheckState(fleet, sandboxFleetId);
}
