// Sandbox v2 helper (spec sandbox-v2 §6): `whiteroom sandbox listen` on the
// user's machine runs their agent when the dashboard queues a task. The
// browser talks to /api/sandbox/helper/<action>, which checks the signed-in
// user owns the production fleet and calls only the engine's
// sandbox_helper_* actions. What's sent is task data only (a prompt), never a
// command: the agent command is fixed on the user's machine.
//
// A helper code is shown once: it lives in page state only.

import { CLI_VERSION } from './practice/model';
import { sandboxPost, SandboxFleetError } from './fleet';

export const SANDBOX_HELPER_ACTIONS = ['status', 'code', 'run', 'disconnect'] as const;
export type SandboxHelperAction = (typeof SANDBOX_HELPER_ACTIONS)[number];

/** Each BFF action's engine action: Sandbox-only, all of them. */
export const SANDBOX_HELPER_ENGINE_ACTION: Record<SandboxHelperAction, string> = {
  status: 'sandbox_helper_status',
  code: 'sandbox_helper_code',
  run: 'sandbox_helper_run',
  disconnect: 'sandbox_helper_disconnect',
};

export function isSandboxHelperAction(v: unknown): v is SandboxHelperAction {
  return typeof v === 'string' && (SANDBOX_HELPER_ACTIONS as readonly string[]).includes(v);
}

export const PROMPT_MAX = 4000;

/** The command the page shows: the agent command stays a placeholder the user fills in. */
export const LISTEN_COMMAND = `npx @whiteroom-ai/cli@${CLI_VERSION} sandbox listen --adapter "<your agent command>"`;

export interface HelperTask {
  id: string;
  prompt: string;
  /** Null while it hasn't finished. */
  ok: boolean | null;
  summary: string;
  /** When it finished, or else when it was queued. */
  at: string | null;
}

export interface HelperStatus {
  connected: boolean;
  host: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  queued: number;
  running: boolean;
  recent: HelperTask[];
  /** A code that's waiting to be used (never the code itself). */
  code: { expiresAt: string; triesLeft: number | null } | null;
  tasksThisHour: number;
  tasksPerHour: number;
}

/** A helper code, shown once. */
export interface HelperCode {
  code: string;
  codeExpiresAt: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const strOrNull = (v: unknown, max = 64) => (str(v, max) ? v : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const CODE_RE = /^[A-Za-z0-9-]{4,64}$/;
const TASK_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function taskOf(v: unknown): HelperTask | null {
  // The engine names it taskId (phase 5); id is accepted too.
  const id = isObj(v) ? (str(v.taskId, 128) ? v.taskId : str(v.id, 128) ? v.id : null) : null;
  if (!isObj(v) || typeof id !== 'string' || !TASK_ID_RE.test(id)) return null;
  const prompt = typeof v.promptPreview === 'string' ? v.promptPreview : typeof v.prompt === 'string' ? v.prompt : '';
  return {
    id,
    prompt: prompt.slice(0, 200),
    ok: typeof v.ok === 'boolean' ? v.ok : null,
    summary: typeof v.summary === 'string' ? v.summary.slice(0, 500) : '',
    at: strOrNull(v.finishedAt) ?? strOrNull(v.startedAt) ?? strOrNull(v.queuedAt) ?? strOrNull(v.createdAt),
  };
}

/** The helper status answer, with only the fields the page uses, or null when it isn't one. */
export function helperStatusOf(data: unknown): HelperStatus | null {
  if (!isObj(data) || typeof data.connected !== 'boolean') return null;
  const code = isObj(data.code) && str(data.code.expiresAt, 64)
    ? { expiresAt: data.code.expiresAt, triesLeft: typeof data.code.triesLeft === 'number' ? count(data.code.triesLeft) : null }
    : null;
  return {
    connected: data.connected,
    host: data.connected && str(data.host, 255) ? data.host : null,
    connectedAt: strOrNull(data.connectedAt),
    lastSeenAt: strOrNull(data.lastSeenAt),
    queued: count(data.queued),
    running: data.running === true || isObj(data.running),
    recent: (Array.isArray(data.recent) ? data.recent : []).slice(0, 20).map(taskOf).filter((t): t is HelperTask => t !== null),
    code,
    tasksThisHour: count(data.tasksThisHour),
    tasksPerHour: count(data.tasksPerHour) || 30,
  };
}

/** The once-shown code of a code answer, or null. */
export function helperCodeOf(data: unknown): HelperCode | null {
  if (!isObj(data) || !str(data.code, 64) || !CODE_RE.test(data.code) || !str(data.codeExpiresAt, 64)) return null;
  return { code: data.code, codeExpiresAt: data.codeExpiresAt };
}

/** The run answer, or null. */
export function runAnswerOf(data: unknown): { taskId: string; duplicate: boolean } | null {
  if (!isObj(data) || !str(data.taskId, 128) || !TASK_ID_RE.test(data.taskId)) return null;
  return { taskId: data.taskId, duplicate: data.duplicate === true };
}

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export type RunCheck = { ok: true; request: { task: { kind: 'prompt'; prompt: string }; request_id: string } } | { ok: false; error: string };

/** What Run agent may send: a prompt of at most 4,000 characters, and the click's request ID. */
export function runCheck(body: Record<string, unknown>): RunCheck {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'Type what your agent should do.' };
  if (prompt.length > PROMPT_MAX) return { ok: false, error: `Keep it under ${PROMPT_MAX.toLocaleString('en-US')} characters.` };
  if (typeof body.requestId !== 'string' || !REQUEST_ID_RE.test(body.requestId)) return { ok: false, error: 'Invalid request.' };
  return { ok: true, request: { task: { kind: 'prompt', prompt }, request_id: body.requestId } };
}

// ── Wording ──

/** A refused Run agent, in plain words. */
export function runRefusal(e: unknown): string {
  if (!(e instanceof SandboxFleetError)) return 'That didn’t work. Check your connection and try again.';
  if (e.status === 429) {
    if (e.reason === 'queue_full') return 'Your helper already has tasks waiting. Try again when they finish.';
    const mins = e.retryAfter ? Math.max(1, Math.ceil(e.retryAfter / 60)) : null;
    return mins ? `That’s the limit for this hour. Try again in ${mins} min.` : 'That’s the limit for this hour. Try again later.';
  }
  if (e.status === 409 && e.reason === 'no_helper') return 'Your helper isn’t connected. Start it again where your agent runs.';
  return e.message;
}

/** The click's request ID: the same one is reused if that click is sent again. */
export function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── Browser calls (through the BFF) ──

const call = (action: SandboxHelperAction, body: Record<string, unknown>) => sandboxPost(`/api/sandbox/helper/${action}`, body);
const unreadable = () => new SandboxFleetError('WhiteRoom sent an answer the dashboard couldn’t read. Try again.', 502);

export async function getHelperStatus(fleet: string, sandboxFleetId: string): Promise<HelperStatus> {
  const status = helperStatusOf(await call('status', { fleet, sandboxFleetId }));
  if (!status) throw unreadable();
  return status;
}

export async function getHelperCode(fleet: string, sandboxFleetId: string): Promise<HelperCode> {
  const code = helperCodeOf(await call('code', { fleet, sandboxFleetId }));
  if (!code) throw unreadable();
  return code;
}

export async function runHelperTask(fleet: string, sandboxFleetId: string, prompt: string, requestId: string): Promise<{ taskId: string; duplicate: boolean }> {
  const answer = runAnswerOf(await call('run', { fleet, sandboxFleetId, prompt, requestId }));
  if (!answer) throw unreadable();
  return answer;
}

export async function disconnectHelper(fleet: string, sandboxFleetId: string): Promise<HelperStatus> {
  const status = helperStatusOf(await call('disconnect', { fleet, sandboxFleetId }));
  if (!status) throw unreadable();
  return status;
}
