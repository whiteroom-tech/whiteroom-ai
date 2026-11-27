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
// "Can't be reached" means only: the request to WhiteRoom failed before any
// reply (DNS, connection, timeout), or the reply was a 502, 503 or 504 that
// didn't come from WhiteRoom itself (a load balancer's error page). Anything
// WhiteRoom answers, including a block, a rest (429), a quota refusal (402) or
// a 503 because rules couldn't be checked, is passed back unchanged. Failing
// open never gets around a rule WhiteRoom is able to enforce.
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
  /** Called whenever a call goes straight to the provider. */
  onFailOpen?: (info: { url: string; reason: string }) => void;
  /** The fetch to wrap. Default the global fetch. */
  fetch?: typeof fetch;
}

const UNREACHABLE_STATUSES = new Set([502, 503, 504]);

/** True when a reply came from the WhiteRoom engine (its error bodies carry a `whiteroom` field). */
async function fromWhiteRoom(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.clone().json();
    return typeof body === "object" && body !== null && "whiteroom" in body;
  } catch {
    return false;
  }
}

/** The same request, addressed to the provider instead of WhiteRoom. */
export function providerUrl(url: string, whiteroomBaseUrl: string, providerBaseUrl: string): string | null {
  const wr = whiteroomBaseUrl.replace(/\/+$/, "");
  if (url !== wr && !url.startsWith(`${wr}/`) && !url.startsWith(`${wr}?`)) return null;
  return providerBaseUrl.replace(/\/+$/, "") + url.slice(wr.length);
}

/** Headers meant for WhiteRoom only. They aren't sent to the provider. */
function withoutWhiteRoomHeaders(headers: HeadersInit | undefined): Headers {
  const h = new Headers(headers);
  for (const name of [...h.keys()]) if (name.startsWith("x-whiteroom-") || name.startsWith("x-wr-")) h.delete(name);
  return h;
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

    const sendDirect = (reason: string) => {
      options.onFailOpen?.({ url: direct, reason });
      return base(direct, { ...init, method, body, signal, headers: withoutWhiteRoomHeaders(headers) });
    };

    let res: Response;
    try {
      res = await base(url, { ...init, method, body, signal, headers });
    } catch (err) {
      // The caller cancelled: don't turn that into a provider call.
      if (signal?.aborted) throw err;
      return sendDirect("unreachable");
    }
    if (UNREACHABLE_STATUSES.has(res.status) && !(await fromWhiteRoom(res))) return sendDirect(`status_${res.status}`);
    return res;
  };
  return wrapped as typeof fetch;
}
