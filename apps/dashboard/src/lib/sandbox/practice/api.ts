// The browser's side of practice tests: the BFF routes in
// app/api/sandbox/practice. The run code is returned by start and new-code
// only; it is held in the page and never stored.

import type { PracticeResult, PracticeRun, PracticeRunRow, PracticeStart, RunCode } from './types';

/** A refusal from the BFF or the engine, with the engine's reason when it sent one. */
export class PracticeError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string, readonly body?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * Whether a failed progress read is worth trying again: network errors
 * (status 0), timeouts, rate limits and server errors are; any other refusal
 * (signed out, not the owner, no such test) won't change by asking again.
 */
export function retryable(e: unknown): boolean {
  if (!(e instanceof PracticeError)) return true;
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
export const sourceModel = (fleet: string, agent: string) =>
  call<{ model: string | null }>(`/source-model${q(fleet)}&agent=${encodeURIComponent(agent)}`).then((r) => r.model);
export const startPractice = (s: PracticeStart) => call<RunCode & { runId: string }>('/start', { body: { ...s } });
export const newRunCode = (fleet: string, id: string) => call<RunCode>(`/${id}/code`, { body: { fleet } });
export const endPractice = (fleet: string, id: string) => call<{ lifecycle: string }>(`/${id}/end`, { body: { fleet } });
