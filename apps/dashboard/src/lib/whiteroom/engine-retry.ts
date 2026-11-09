// One retry for a read the engine couldn't answer for a moment.
//
// When the engine restarts it is briefly unavailable (a few seconds), and the
// hosting platform answers in its place: 429 with its own text body, or 502,
// 503, 504. A read asked again a couple of seconds later almost always works,
// so pages show their data instead of an error.
//
// Only for reads: asking again can never change anything. Never wrap a call
// that changes something (create, store, pause, rule changes).

/** Wait before the retry: 1.5 s plus up to 0.5 s jitter, so the extra wait stays within 2 s. */
export const ENGINE_RETRY_DELAY_MS = 1_500;
export const ENGINE_RETRY_JITTER_MS = 500;

/**
 * A first answer slower than this isn't a brief gap (it's a slow engine or a
 * timeout), so it is not asked again: a page never waits a second full timeout.
 */
export const ENGINE_RETRY_FAST_FAIL_MS = 5_000;

export interface RetryOptions {
  /** The caller has its own retry for the engine's handoff 503 (see isTransientEngineAnswer). */
  handoffRetried?: boolean;
}

/**
 * Whether a response is the platform answering for an engine that was
 * briefly unavailable. The engine's own 429 (a plan or rate limit) is JSON
 * with an `error` or `reason` and stands: asking again gives the same answer.
 *
 * `handoffRetried`: the caller already retries a 503 the engine marked as a
 * handoff (client.ts), so that one isn't counted again. Other callers leave it
 * unset and get the one retry for it like any other 503.
 */
export async function isTransientEngineAnswer(res: Response, { handoffRetried = false }: RetryOptions = {}): Promise<boolean> {
  if (res.status === 502 || res.status === 504) return true;
  if (res.status !== 429 && res.status !== 503) return false;
  if (res.status === 503 && !handoffRetried) return true;
  const body = await res.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (res.status === 503) {
    const nested = body?.whiteroom as Record<string, unknown> | undefined;
    return nested?.reason !== 'whiteroom_handoff';
  }
  const engineOwn = !!body && typeof body === 'object' && (typeof body.error === 'string' || typeof body.reason === 'string');
  return !engineOwn;
}

/** A timeout or abort: the request already used its full time, so it isn't asked again. */
function timedOut(e: unknown): boolean {
  for (let err = e; err instanceof Error; err = (err as { cause?: unknown }).cause) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  }
  return false;
}

function retryDelay(): number {
  return ENGINE_RETRY_DELAY_MS + Math.floor(Math.random() * ENGINE_RETRY_JITTER_MS);
}

/**
 * Runs `request` (a read), and once more after a short wait when it failed
 * fast with a network error or a transient answer. The second outcome is
 * returned (or thrown) as it is, so callers keep their own error paths.
 */
export async function withEngineReadRetry(request: () => Promise<Response>, opts: RetryOptions = {}): Promise<Response> {
  const started = Date.now();
  let first: Response;
  try {
    first = await request();
  } catch (e) {
    if (timedOut(e) || Date.now() - started > ENGINE_RETRY_FAST_FAIL_MS) throw e;
    await new Promise((r) => setTimeout(r, retryDelay()));
    return request();
  }
  if (Date.now() - started > ENGINE_RETRY_FAST_FAIL_MS || !(await isTransientEngineAnswer(first, opts))) return first;
  // The first answer is dropped; free its body.
  await first.body?.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, retryDelay()));
  return request();
}
