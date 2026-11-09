// Asking the engine again when it couldn't answer for a moment.
//
// When the engine restarts it is briefly unavailable (a few seconds), and the
// hosting platform answers in its place: 429 with its own text body, or 502,
// 503, 504. Two retries cover that gap:
//
// - The platform's 429: the request never reached the engine, so it is safe
//   to send again for any call, changes included. Asked again about every
//   second for up to ~5 s (retryPlatform429).
// - 502/503/504 or a network error: the engine may have acted, so only reads
//   are asked again, once, after ~1.5-2 s (withEngineReadRetry).
//
// The engine's own 429 (a plan or rate limit) is JSON with an `error` or
// `reason` and is never retried: asking again gives the same answer.

/** Wait before the read retry: 1.5 s plus up to 0.5 s jitter, so the extra wait stays within 2 s. */
export const ENGINE_RETRY_DELAY_MS = 1_500;
export const ENGINE_RETRY_JITTER_MS = 500;

/** The platform's 429 is asked again after 0.8-1.2 s, for at most this much waiting in all. */
export const PLATFORM_429_DELAY_MS = 800;
export const PLATFORM_429_JITTER_MS = 400;
export const PLATFORM_429_BUDGET_MS = 5_500;

/**
 * A first answer slower than this isn't a brief gap (it's a slow engine or a
 * timeout), so it is not asked again: a page never waits a second full timeout.
 */
export const ENGINE_RETRY_FAST_FAIL_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 429 from the platform rather than the engine: no WhiteRoom JSON body (`error` or `reason`). */
export async function isPlatform429(res: Response): Promise<boolean> {
  if (res.status !== 429) return false;
  const body = await res.clone().json().catch(() => null) as Record<string, unknown> | null;
  return !(body && typeof body === 'object' && (typeof body.error === 'string' || typeof body.reason === 'string'));
}

/**
 * The next wait for a platform 429, or null when it isn't one or the budget
 * (`waited` so far) is spent. For callers with a retry loop of their own (client.ts).
 */
export async function platform429Delay(res: Response, waited: number): Promise<number | null> {
  if (!(await isPlatform429(res))) return null;
  const delay = PLATFORM_429_DELAY_MS + Math.floor(Math.random() * PLATFORM_429_JITTER_MS);
  return waited + delay <= PLATFORM_429_BUDGET_MS ? delay : null;
}

/**
 * Runs `request` and sends it again while the platform answers 429 (it never
 * reached the engine), for up to ~5 s. Safe for any call. `onRetry` is told
 * each time, so a caller can skip its own retry on top.
 */
export async function retryPlatform429(request: () => Promise<Response>, onRetry?: () => void): Promise<Response> {
  for (let waited = 0; ;) {
    const res = await request();
    const delay = await platform429Delay(res, waited);
    if (delay === null) return res;
    await res.body?.cancel().catch(() => {});
    onRetry?.();
    waited += delay;
    await sleep(delay);
  }
}

export interface RetryOptions {
  /** The caller has its own retry for the engine's handoff 503 (see isTransientEngineAnswer). */
  handoffRetried?: boolean;
  /** True once the caller has already retried this request its own way: then it isn't asked again here. */
  retried?: () => boolean;
}

/**
 * Whether a response is the platform answering for an engine that was
 * briefly unavailable: a platform 429, or 502, 503, 504.
 *
 * `handoffRetried`: the caller already retries a 503 the engine marked as a
 * handoff (client.ts), so that one isn't counted again. Other callers leave it
 * unset and get the one retry for it like any other 503.
 */
export async function isTransientEngineAnswer(res: Response, { handoffRetried = false }: RetryOptions = {}): Promise<boolean> {
  if (res.status === 502 || res.status === 504) return true;
  if (res.status === 429) return isPlatform429(res);
  if (res.status !== 503) return false;
  if (!handoffRetried) return true;
  const body = await res.clone().json().catch(() => null) as { whiteroom?: { reason?: unknown } } | null;
  return body?.whiteroom?.reason !== 'whiteroom_handoff';
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
 * Without `retried`, the platform's 429 is first retried as retryPlatform429
 * does; a request that was retried that way isn't asked a further round.
 */
export async function withEngineReadRetry(request: () => Promise<Response>, opts: RetryOptions = {}): Promise<Response> {
  let platformRetried = false;
  const send = opts.retried ? request : () => retryPlatform429(request, () => { platformRetried = true; });
  const retried = () => platformRetried || !!opts.retried?.();
  const started = Date.now();
  let first: Response;
  try {
    first = await send();
  } catch (e) {
    if (timedOut(e) || Date.now() - started > ENGINE_RETRY_FAST_FAIL_MS || retried()) throw e;
    await sleep(retryDelay());
    return send();
  }
  if (Date.now() - started > ENGINE_RETRY_FAST_FAIL_MS || retried() || !(await isTransientEngineAnswer(first, opts))) return first;
  // The first answer is dropped; free its body.
  await first.body?.cancel().catch(() => {});
  await sleep(retryDelay());
  return send();
}
