// What your agent does when WhiteRoom can't be reached: wait for it (fail
// closed, the default) or send the call straight to the model provider (fail
// open).
//
// Pass the returned function as the `fetch` option of the Anthropic or OpenAI
// SDK, with that SDK's base URL pointed at WhiteRoom as usual:
//
//   import Anthropic from "@anthropic-ai/sdk";
//   import { whiteroomFetch } from "@whiteroom-ai/sdk";
//
//   const client = new Anthropic({
//     baseURL: "https://proxy.whiteroom.tech",
//     fetch: whiteroomFetch({ failOpen: true, providerBaseUrl: "https://api.anthropic.com" }),
//   });
//
// "Can't be reached" means only: the request to WhiteRoom failed with no reply
// (DNS, refused or dropped connection), or a 503 came back that WhiteRoom
// didn't send (the platform in front of it had no instance to serve it).
// Anything WhiteRoom answers, including a block, a rest (429), a quota refusal
// (402) or a 503 because rules couldn't be checked, is passed back unchanged,
// so failing open never gets around a rule WhiteRoom is able to enforce.
//
// 502 and 504 are passed back too: they can mean WhiteRoom already sent the
// call to the provider, and sending it again would run it twice. A dropped
// connection carries the same small risk; that's the trade fail open makes.
// A timeout fails open only if you set whiteroomTimeoutMs, for the same reason.
//
// A call sent straight to the provider isn't governed or recorded by
// WhiteRoom. onFailOpen is called each time so you can log it.

export interface WhiteRoomFetchOptions {
  /** Send calls straight to the provider when WhiteRoom can't be reached. Default false (fail closed). */
  failOpen?: boolean;
  /** The provider's own base URL, e.g. https://api.anthropic.com or https://api.openai.com/v1. Required when failOpen is true. */
  providerBaseUrl?: string;
  /** WhiteRoom's base URL as given to the provider SDK. Default https://proxy.whiteroom.tech. */
  whiteroomBaseUrl?: string;
  /** Called whenever a call goes straight to the provider. An error it throws is ignored. */
  onFailOpen?: (info: { url: string; reason: string }) => void;
  /**
   * Give up on WhiteRoom after this many milliseconds and send the call direct.
   * Off by default: after a timeout WhiteRoom may already have sent the call
   * on, so the model could run it twice. Your own abort signal still cancels
   * the call outright.
   */
  whiteroomTimeoutMs?: number;
  /** The fetch to wrap. Default the global fetch. */
  fetch?: typeof fetch;
}

/**
 * True when the WhiteRoom engine handled the reply: it adds its security
 * headers to every response, including a provider's own error it passes back,
 * and its own errors carry a `whiteroom` body field. A 503 with neither came
 * from the platform in front of WhiteRoom.
 */
async function fromWhiteRoom(res: Response): Promise<boolean> {
  if (res.headers.get("x-frame-options") === "DENY" && res.headers.has("permissions-policy")) return true;
  try {
    const body: unknown = await res.clone().json();
    return typeof body === "object" && body !== null && "whiteroom" in body;
  } catch {
    return false;
  }
}

/** Drops trailing slashes (a loop, not a regex: no slow cases on long input). */
function trimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

/** The same request, addressed to the provider instead of WhiteRoom. */
export function providerUrl(url: string, whiteroomBaseUrl: string, providerBaseUrl: string): string | null {
  const wr = trimSlashes(whiteroomBaseUrl);
  if (url !== wr && !url.startsWith(`${wr}/`) && !url.startsWith(`${wr}?`)) return null;
  return trimSlashes(providerBaseUrl) + url.slice(wr.length);
}

/** Headers meant for WhiteRoom only. They aren't sent to the provider. */
function withoutWhiteRoomHeaders(headers: HeadersInit | undefined): Headers {
  const h = new Headers(headers);
  for (const name of [...h.keys()]) if (name.startsWith("x-whiteroom-") || name.startsWith("x-wr-")) h.delete(name);
  return h;
}

/**
 * A signal that aborts when the caller's does or the timer fires. It stays
 * tied to the caller's signal for the whole call, so the caller can still
 * cancel a reply mid-stream. AbortSignal.any (Node 20.3+) is used where it
 * exists; the fallback's listener on the caller is removed when the caller
 * aborts or the response body ends (`release`).
 */
function callSignal(caller: AbortSignal, timer: AbortSignal): { signal: AbortSignal; release: () => void } {
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any([caller, timer]), release: () => {} };
  const ctrl = new AbortController();
  if (caller.aborted) ctrl.abort(caller.reason);
  else if (timer.aborted) ctrl.abort(timer.reason);
  const onCaller = () => ctrl.abort(caller.reason);
  const onTimer = () => ctrl.abort(timer.reason);
  caller.addEventListener("abort", onCaller, { once: true });
  timer.addEventListener("abort", onTimer, { once: true });
  return { signal: ctrl.signal, release: () => { caller.removeEventListener("abort", onCaller); timer.removeEventListener("abort", onTimer); } };
}

/** The same response, calling `release` once its body has been read, cancelled or failed. */
function releaseWhenDone(res: Response, release: () => void): Response {
  if (!res.body) { release(); return res; }
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) { release(); ctrl.close(); } else ctrl.enqueue(value);
      } catch (err) { release(); ctrl.error(err); }
    },
    cancel(reason) { release(); return reader.cancel(reason); },
  });
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  // A new Response loses where the reply came from; keep it for callers that read it.
  Object.defineProperty(out, "url", { value: res.url });
  Object.defineProperty(out, "redirected", { value: res.redirected });
  return out;
}

export function whiteroomFetch(options: WhiteRoomFetchOptions = {}): typeof fetch {
  const base = options.fetch ?? fetch;
  const failOpen = options.failOpen === true;
  if (failOpen && !options.providerBaseUrl) throw new Error("whiteroomFetch: providerBaseUrl is required when failOpen is true.");
  const wrBase = options.whiteroomBaseUrl ?? "https://proxy.whiteroom.tech";

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!failOpen) return base(input, init);

    // Keep what's needed to send the call again: a Request body can only be read once.
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const direct = providerUrl(url, wrBase, options.providerBaseUrl!);
    if (!direct) return base(input, init);
    let body = init?.body ?? (req && req.body ? await req.clone().arrayBuffer() : undefined);
    // A stream can only be read once, and the call may be sent twice.
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) body = await new Response(body).arrayBuffer();
    const method = init?.method ?? req?.method;
    const headers = init?.headers ?? req?.headers;
    const signal = init?.signal ?? req?.signal;
    // A Request's other settings (redirect, credentials, cache…) carry over to both calls.
    const fromReq: RequestInit = req
      ? { redirect: req.redirect, credentials: req.credentials, cache: req.cache, referrer: req.referrer, referrerPolicy: req.referrerPolicy, integrity: req.integrity, keepalive: req.keepalive, mode: req.mode }
      : {};

    const sendDirect = (reason: string) => {
      try {
        options.onFailOpen?.({ url: direct, reason });
      } catch {
        // A logging hook mustn't stop the call it is logging.
      }
      return base(direct, { ...fromReq, ...init, method, body, signal: signal ?? undefined, headers: withoutWhiteRoomHeaders(headers) });
    };

    // The timeout covers only the wait for WhiteRoom to start answering. It's
    // cleared once headers arrive, so a long streamed reply isn't cut off.
    const timeoutMs = options.whiteroomTimeoutMs;
    const timer = timeoutMs ? new AbortController() : null;
    const timerId = timer ? setTimeout(() => timer.abort(new DOMException("WhiteRoom didn't answer in time", "TimeoutError")), timeoutMs) : undefined;
    const combined = timer && signal ? callSignal(signal, timer.signal) : null;
    const wrSignal = combined?.signal ?? timer?.signal ?? signal ?? undefined;

    let res: Response;
    try {
      res = await base(url, { ...fromReq, ...init, method, body, signal: wrSignal, headers });
    } catch (err) {
      combined?.release();
      // The caller cancelled: don't turn that into a provider call.
      if (signal?.aborted) throw err;
      return sendDirect(timer?.signal.aborted ? "timeout" : "unreachable");
    } finally {
      clearTimeout(timerId);
    }
    if (res.status === 503 && !(await fromWhiteRoom(res))) {
      combined?.release();
      await res.body?.cancel().catch(() => {});
      return sendDirect("status_503");
    }
    return combined ? releaseWhenDone(res, combined.release) : res;
  };
  return wrapped as typeof fetch;
}
