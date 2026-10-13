// The CLI's requests to WhiteRoom's /api/readiness routes (spec §4, §7):
// plain fetch, paced to 60 a minute (§4 Run), with WhiteRoom's own waits
// (an IP-limit 429, a 503 while it switches servers) retried.

import { copy, warn } from "./text.js";

/** The CLI's own requests stay at or under this many a minute; WhiteRoom allows 120 per IP. */
const PER_MINUTE = 60;
/** How long the CLI keeps retrying while WhiteRoom can't be reached or asks it to wait. */
export const OFFLINE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 90_000;

const sent: number[] = [];
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** Waits until one more request keeps the last minute at or under PER_MINUTE. */
export async function pace(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (sent.length && sent[0] <= now - 60_000) sent.shift();
    if (sent.length < PER_MINUTE) { sent.push(now); return; }
    await sleep(sent[0] + 60_000 - now);
  }
}

/** A reply from WhiteRoom; `body` is null when it wasn't JSON. */
export interface Reply {
  status: number;
  /** The route's JSON, read field by field by the caller. */
  body: any;
}

/**
 * A reply that tried to send the CLI somewhere else. Requests that carry the
 * key or the session never follow a redirect (`redirect: "error"`): nothing is
 * resent, and the caller stops with plain copy.
 */
export const REDIRECTED = 0;
export const isRedirectError = (err: unknown) => /redirect/i.test(String((err as { cause?: { message?: string } })?.cause?.message ?? ""));

/** WhiteRoom couldn't be reached (or kept asking the CLI to wait) for OFFLINE_MS. */
export class Unreachable extends Error {}
/** The session's stop signal fired (Ctrl+C, or WhiteRoom ended the test). */
export class Stopped extends Error {}

/** 429s that are answers, not a request to wait. */
const ANSWERS_429 = new Set(["busy", "tool_limit", "starts_today", "owner_busy"]);

export class Engine {
  session: string | null = null;
  /** Aborts any request in flight when the session stops. */
  signal: AbortSignal | null = null;
  /** `offlineMs`: how long to keep retrying (tests shorten it). */
  constructor(readonly origin: string, private readonly offlineMs = OFFLINE_MS) {}

  private send(path: string, body: unknown, timeoutMs: number, signal: AbortSignal | null): Promise<Response> {
    const ac = new AbortController();
    const abort = () => ac.abort();
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    return fetch(this.origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.session && { authorization: `Bearer ${this.session}` }) },
      body: JSON.stringify(body),
      redirect: "error",
      signal: ac.signal,
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  }

  /** Ends the run (best effort, one try, not paced): after Ctrl+C or a crashed adapter. */
  async cancel(): Promise<void> {
    await this.send("/api/readiness/cancel", {}, 5_000, null).catch(() => null);
  }

  /**
   * POSTs to a route. WhiteRoom's waits (503, a 429 that isn't an answer) are
   * retried as Retry-After says. `retryNetwork`: also retry a network error or
   * another 5xx, for requests that are safe to repeat; otherwise those throw
   * Unreachable. A redirect is returned as status REDIRECTED, never followed.
   */
  async post(path: string, body: unknown, o: { retryNetwork?: boolean } = {}): Promise<Reply> {
    const started = Date.now();
    let warned = false;
    for (;;) {
      await pace();
      if (this.signal?.aborted) throw new Stopped();
      let res: Response;
      try {
        res = await this.send(path, body, REQUEST_TIMEOUT_MS, this.signal);
      } catch (err) {
        if (this.signal?.aborted) throw new Stopped();
        if (isRedirectError(err)) return { status: REDIRECTED, body: { reason: "redirected" } };
        if (!o.retryNetwork || Date.now() - started > this.offlineMs) throw new Unreachable();
        if (!warned) warn(copy.offline);
        warned = true;
        await sleep(Math.min(5_000, this.offlineMs), this.signal ?? undefined);
        continue;
      }
      const json = await res.json().catch(() => null);
      if (res.status >= 500 && res.status !== 503) {
        // It may have been handled: only a request that is safe to repeat is sent again.
        if (!o.retryNetwork || Date.now() - started > this.offlineMs) throw new Unreachable();
        await sleep(Math.min(5_000, this.offlineMs), this.signal ?? undefined);
        continue;
      }
      const wait = res.status === 503 || (res.status === 429 && !ANSWERS_429.has(json?.reason));
      if (wait) {
        if (Date.now() - started > this.offlineMs) throw new Unreachable();
        const after = res.headers.get("retry-after");
        await sleep(after === null ? 5_000 : Math.min(Math.max(Number(after) || 0, 1), 60) * 1000, this.signal ?? undefined);
        continue;
      }
      return { status: res.status, body: json };
    }
  }
}
