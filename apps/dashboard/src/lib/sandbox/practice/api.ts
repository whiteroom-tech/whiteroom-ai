// The browser's side of practice tests: the BFF routes in
// app/api/sandbox/practice. The run code is returned by start and new-code
// only; it is held in the page and never stored.

import { KEY_REFUSALS, PRACTICE_UNAVAILABLE, PROXY_KEY_PREFIX_RE } from './model';
import type { PracticeControlCheck, PracticeKeyRefusal, PracticeProviderKey, PracticeResult, PracticeRun, PracticeRunRow, PracticeSource, PracticeSourceProvider, PracticeStart, RunCode } from './types';

/** A refusal from the BFF or the engine, with the engine's reason when it sent one. */
export class PracticeError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string, readonly body?: Record<string, unknown>) {
    super(message);
  }
}

/** Start said the picked Fleet key key is gone: setup reads the keys again. */
export const keyGone = (e: unknown) => e instanceof PracticeError && e.reason === 'key_not_found';

/** Practice tests aren't on for this engine (the BFF's practice_unavailable): nothing to retry. */
export function unavailable(e: unknown): boolean {
  return e instanceof PracticeError && e.reason === PRACTICE_UNAVAILABLE;
}

/**
 * Whether a failed progress read is worth trying again: network errors
 * (status 0), timeouts, rate limits and server errors are; any other refusal
 * (signed out, not the owner, no such test) won't change by asking again.
 */
export function retryable(e: unknown): boolean {
  if (!(e instanceof PracticeError)) return true;
  if (unavailable(e)) return false;
  const { status } = e;
  return status === 0 || status === 408 || status === 429 || status >= 500 || status < 400;
}

async function call<T>(path: string, init?: { body: Record<string, unknown> }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/sandbox/practice${path}`, {
      method: init ? 'POST' : 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: init ? { 'Content-Type': 'application/json' } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new PracticeError('Couldn’t reach WhiteRoom. Check your connection and try again.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data.error === 'string' ? data.error : 'Something went wrong. Try again.';
    throw new PracticeError(message, res.status, typeof data.reason === 'string' ? data.reason : undefined, data);
  }
  return data as T;
}

const q = (fleet: string) => `?fleet=${encodeURIComponent(fleet)}`;

export const listPracticeRuns = (fleet: string) => call<{ runs: PracticeRunRow[] }>(q(fleet)).then((r) => r.runs);
export const getPracticeRun = (fleet: string, id: string) => call<PracticeRun>(`/${id}${q(fleet)}`);
export const getPracticeResult = (fleet: string, id: string) => call<PracticeResult>(`/${id}/report${q(fleet)}`);
const PROVIDERS: readonly PracticeSourceProvider[] = ['direct-anthropic', 'direct-openai', 'proxy-url', 'cloud', 'unknown'];
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const refusal = (v: unknown) => (typeof v === 'string' && Object.hasOwn(KEY_REFUSALS, v) ? (v as PracticeKeyRefusal) : null);

/** A Fleet key key as the picker can show it, or null; one with a refusal this dashboard doesn't know can't be picked. */
function providerKey(k: unknown): PracticeProviderKey | null {
  if (!k || typeof k !== 'object') return null;
  const r = k as Record<string, unknown>;
  const displayPrefix = str(r.displayPrefix);
  const provider = str(r.provider);
  if (!displayPrefix || !PROXY_KEY_PREFIX_RE.test(displayPrefix) || !provider) return null;
  const eligible = r.eligible === true && r.reason == null;
  return {
    displayPrefix, provider, endpointHost: str(r.endpointHost), region: str(r.region), keyHint: str(r.keyHint) ?? '', createdAt: str(r.createdAt) ?? '',
    eligible, reason: eligible ? null : refusal(r.reason) ?? 'unsupported_provider',
  };
}

/** The agent's latest model, where its calls go, the keys setup can pick from, and the control checks a test would make. */
export const sourceModel = (fleet: string, agent: string) =>
  call<Record<string, unknown>>(`/source-model${q(fleet)}&agent=${encodeURIComponent(agent)}`).then((r): PracticeSource => {
    const controls = (r.controls ?? {}) as { checks?: PracticeControlCheck[]; calls?: number };
    return {
      model: str(r.model),
      provider: PROVIDERS.includes(r.provider as PracticeSourceProvider) ? (r.provider as PracticeSourceProvider) : 'unknown',
      directKey: r.directKey === true,
      blocked: r.blocked === 'bedrock_role' ? 'bedrock_role' : null,
      providerKeys: Array.isArray(r.providerKeys) ? r.providerKeys.map(providerKey).filter((k): k is PracticeProviderKey => k !== null) : [],
      controls: { checks: Array.isArray(controls.checks) ? controls.checks : [], calls: Number(controls.calls) || 0 },
    };
  });
export const startPractice = (s: PracticeStart) => call<RunCode & { runId: string }>('/start', { body: { ...s } });
export const newRunCode = (fleet: string, id: string) => call<RunCode>(`/${id}/code`, { body: { fleet } });
export const endPractice = (fleet: string, id: string) => call<{ lifecycle: string }>(`/${id}/end`, { body: { fleet } });
