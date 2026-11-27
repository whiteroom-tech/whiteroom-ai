// Runs against the built SDK (npm run build first; CI builds before testing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { whiteroomFetch, providerUrl } from "../dist/index.js";

const WR = "https://proxy.whiteroom.tech";
const ANTHROPIC = "https://api.anthropic.com";

/** A fake fetch: WhiteRoom answers with `wr`, the provider with 200 "direct". */
function fake(wr) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body });
    if (new URL(String(url)).origin === WR) {
      if (wr instanceof Error) throw wr;
      return wr();
    }
    return new Response(JSON.stringify({ ok: "direct" }), { status: 200 });
  };
  return { f, calls };
}
const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const send = (fetchFn) => fetchFn(`${WR}/v1/messages`, {
  method: "POST",
  headers: { "x-api-key": "sk-placeholder", "x-whiteroom-agent": "a1", "content-type": "application/json" },
  body: JSON.stringify({ model: "m", messages: [] }),
});

test("fail closed is the default: an unreachable WhiteRoom is an error", async () => {
  const { f, calls } = fake(new TypeError("fetch failed"));
  await assert.rejects(send(whiteroomFetch({ fetch: f })), /fetch failed/);
  assert.equal(calls.length, 1);
});

test("fail open: an unreachable WhiteRoom sends the call to the provider", async () => {
  const { f, calls } = fake(new TypeError("fetch failed"));
  const seen = [];
  const res = await send(whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC, onFailOpen: (i) => seen.push(i) }));
  assert.equal(res.status, 200);
  assert.equal(calls[1].url, `${ANTHROPIC}/v1/messages`);
  assert.equal(calls[1].headers.get("x-api-key"), "sk-placeholder");
  assert.equal(calls[1].headers.get("x-whiteroom-agent"), null, "WhiteRoom headers stay with WhiteRoom");
  assert.equal(calls[1].body, calls[0].body);
  assert.deepEqual(seen, [{ url: `${ANTHROPIC}/v1/messages`, reason: "unreachable" }]);
});

test("fail open: a 503 from in front of WhiteRoom (no WhiteRoom body) goes direct", async () => {
  const { f, calls } = fake(() => new Response("<html>Service Unavailable</html>", { status: 503 }));
  const res = await send(whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC }));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test("502 and 504 are passed back, never resent: WhiteRoom may already have sent the call on", async () => {
  for (const status of [502, 504]) {
    const { f, calls } = fake(() => new Response("bad gateway", { status }));
    const res = await send(whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC }));
    assert.equal(res.status, status);
    assert.equal(calls.length, 1);
  }
});

test("a throwing onFailOpen doesn't stop the direct call", async () => {
  const { f } = fake(new TypeError("fetch failed"));
  const res = await send(whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC, onFailOpen: () => { throw new Error("log down"); } }));
  assert.equal(res.status, 200);
});

test("a streamed body is sent whole to the provider", async () => {
  const { f, calls } = fake(new TypeError("fetch failed"));
  const stream = new Response("{\"stream\":true}").body;
  await whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC })(`${WR}/v1/messages`, { method: "POST", body: stream, duplex: "half" });
  assert.equal(new TextDecoder().decode(calls[1].body), '{"stream":true}');
});

test("a Request object works as input", async () => {
  const { f, calls } = fake(new TypeError("fetch failed"));
  const req = new Request(`${WR}/v1/messages`, { method: "POST", body: "{\"a\":1}", headers: { "x-whiteroom-run": "r1", "x-api-key": "sk-placeholder" } });
  const res = await whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC })(req);
  assert.equal(res.status, 200);
  assert.equal(calls[1].url, `${ANTHROPIC}/v1/messages`);
  assert.equal(new TextDecoder().decode(calls[1].body), '{"a":1}');
  assert.equal(calls[1].headers.get("x-whiteroom-run"), null);
});

test("a timeout fails open only when whiteroomTimeoutMs is set", async (t) => {
  // WhiteRoom never answers; it rejects when its signal aborts.
  const hang = () => {
    const calls = [];
    const f = (url, init = {}) => {
      calls.push(String(url));
      if (new URL(String(url)).origin !== WR) return Promise.resolve(new Response("{}", { status: 200 }));
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)));
    };
    return { f, calls };
  };
  // The fake WhiteRoom has no socket to hold the event loop open while it
  // waits for the timer; a real hanging fetch does.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const on = hang();
  const seen = [];
  const res = await send(whiteroomFetch({ fetch: on.f, failOpen: true, providerBaseUrl: ANTHROPIC, whiteroomTimeoutMs: 20, onFailOpen: (i) => seen.push(i.reason) }));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["timeout"]);

  // The caller's own abort still cancels outright, with the timeout set.
  const ctrl = new AbortController();
  const off = hang();
  const p = whiteroomFetch({ fetch: off.f, failOpen: true, providerBaseUrl: ANTHROPIC, whiteroomTimeoutMs: 5_000 })(`${WR}/v1/messages`, { method: "POST", body: "{}", signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p);
  assert.equal(off.calls.length, 1);
});

test("fail open never bypasses a WhiteRoom answer", async () => {
  const answers = [
    json(503, { type: "error", error: { message: "rules unavailable" }, whiteroom: { reason: "enforcement_unavailable", forwarded: false } }),
    json(503, { type: "error", error: { message: "switching" }, whiteroom: { reason: "whiteroom_handoff", forwarded: false } }),
    json(403, { type: "error", error: { message: "blocked" }, whiteroom: { reason: "rule" } }),
    json(429, { type: "error", error: { message: "resting" } }),
    json(402, { type: "error", error: { message: "quota" } }),
    json(200, { content: [] }),
  ];
  for (const a of answers) {
    const { f, calls } = fake(a);
    const status = a().status;
    const res = await send(whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC }));
    assert.equal(res.status, status);
    assert.equal(calls.length, 1, `status ${status} must not go direct`);
  }
});

test("a cancelled call isn't retried against the provider", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const { f, calls } = fake(new DOMException("aborted", "AbortError"));
  const fetchFn = whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC });
  await assert.rejects(fetchFn(`${WR}/v1/messages`, { method: "POST", body: "{}", signal: ctrl.signal }));
  assert.equal(calls.length, 1);
});

test("calls to other hosts pass straight through", async () => {
  const { f, calls } = fake(new TypeError("fetch failed"));
  await whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC })(`${ANTHROPIC}/v1/models`);
  assert.equal(calls.length, 1);
  assert.equal(providerUrl(`${WR}.evil.example/v1/messages`, WR, ANTHROPIC), null);
});

test("OpenAI paths map with the /v1 base", () => {
  assert.equal(providerUrl(`${WR}/v1/chat/completions`, `${WR}/v1`, "https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
});

test("failOpen without providerBaseUrl is refused at setup", () => {
  assert.throws(() => whiteroomFetch({ failOpen: true }), /providerBaseUrl/);
});

test("the timeout stops once WhiteRoom answers: a slow streamed reply isn't cut off", async () => {
  const f = (url, init = {}) => {
    const stream = new ReadableStream({
      async start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("part1 "));
        await new Promise((r) => setTimeout(r, 60)); // longer than the timeout below
        if (init.signal?.aborted) return ctrl.error(init.signal.reason);
        ctrl.enqueue(new TextEncoder().encode("part2"));
        ctrl.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  const res = await send(whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC, whiteroomTimeoutMs: 20 }));
  assert.equal(await res.text(), "part1 part2");
});

test("x-wr- headers stay with WhiteRoom too, and query strings carry over", async () => {
  const { f, calls } = fake(new TypeError("fetch failed"));
  await whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC })(`${WR}/v1/messages?beta=true`, {
    method: "POST", body: "{}", headers: { "x-wr-key": "wr_placeholder", "authorization": "Bearer sk-placeholder" },
  });
  assert.equal(calls[1].url, `${ANTHROPIC}/v1/messages?beta=true`);
  assert.equal(calls[1].headers.get("x-wr-key"), null);
  assert.equal(calls[1].headers.get("authorization"), "Bearer sk-placeholder");
  assert.equal(providerUrl(`${WR}?x=1`, WR, ANTHROPIC), `${ANTHROPIC}?x=1`);
});

test("with a timeout set, the caller can still cancel a reply mid-stream", async () => {
  let pulls = 0;
  const f = (_url, init = {}) => {
    const stream = new ReadableStream({
      pull(ctrl) {
        if (init.signal?.aborted) return ctrl.error(init.signal.reason);
        pulls++;
        ctrl.enqueue(new TextEncoder().encode("x"));
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  const ctrl = new AbortController();
  const res = await whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC, whiteroomTimeoutMs: 1_000 })(`${WR}/v1/messages`, { method: "POST", body: "{}", signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read();
  ctrl.abort();
  await assert.rejects(async () => { for (;;) { const r = await reader.read(); if (r.done) break; } });
  assert.ok(pulls < 1000);
});

test("without AbortSignal.any (Node before 20.3), timeout and caller abort still work", async (t) => {
  const original = AbortSignal.any;
  delete AbortSignal.any;
  t.after(() => { AbortSignal.any = original; });
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));

  // Timer fires while WhiteRoom hangs: goes direct.
  const hangOrDirect = (url, init = {}) =>
    new URL(String(url)).origin !== WR
      ? Promise.resolve(new Response("{}", { status: 200 }))
      : new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)));
  const ctrl = new AbortController();
  const res = await whiteroomFetch({ fetch: hangOrDirect, failOpen: true, providerBaseUrl: ANTHROPIC, whiteroomTimeoutMs: 20 })(`${WR}/v1/messages`, { method: "POST", body: "{}", signal: ctrl.signal });
  assert.equal(res.status, 200);

  // Caller aborts while WhiteRoom hangs: rejects, no direct call.
  const ctrl2 = new AbortController();
  const p = whiteroomFetch({ fetch: hangOrDirect, failOpen: true, providerBaseUrl: ANTHROPIC, whiteroomTimeoutMs: 5_000 })(`${WR}/v1/messages`, { method: "POST", body: "{}", signal: ctrl2.signal });
  ctrl2.abort();
  await assert.rejects(p);
});

test("without AbortSignal.any, the fallback removes its listeners when the reply ends, and keeps url", async (t) => {
  const original = AbortSignal.any;
  delete AbortSignal.any;
  t.after(() => { AbortSignal.any = original; });

  const ctrl = new AbortController();
  let added = 0, removed = 0;
  const add = ctrl.signal.addEventListener.bind(ctrl.signal), remove = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.addEventListener = (...a) => { added++; return add(...a); };
  ctrl.signal.removeEventListener = (...a) => { removed++; return remove(...a); };

  const f = async (url) => {
    const r = new Response("done", { status: 200 });
    Object.defineProperty(r, "url", { value: String(url) });
    return r;
  };
  const res = await whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC, whiteroomTimeoutMs: 1_000 })(`${WR}/v1/messages`, { method: "POST", body: "{}", signal: ctrl.signal });
  assert.equal(res.url, `${WR}/v1/messages`);
  assert.equal(await res.text(), "done");
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test("a provider's 503 passed back by WhiteRoom isn't resent (engine headers mark it)", async () => {
  const engineHeaders = { "content-type": "application/json", "x-frame-options": "DENY", "permissions-policy": "camera=(), microphone=(), geolocation=()" };
  const { f, calls } = fake(() => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 503, headers: engineHeaders }));
  const res = await send(whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC }));
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1);
});

test("a Request's redirect and credentials settings carry over", async () => {
  const seen = [];
  const f = async (url, init = {}) => { seen.push(init); throw new TypeError("fetch failed"); };
  const req = new Request(`${WR}/v1/messages`, { method: "POST", body: "{}", redirect: "error", credentials: "omit" });
  await assert.rejects(whiteroomFetch({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC })(req));
  assert.equal(seen[0].redirect, "error");
  assert.equal(seen[1].credentials, "omit");
});

test("a WhiteRoom 503 is recognised by its body alone, and a bare 503 by neither", async () => {
  const bodyOnly = fake(json(503, { type: "error", error: { message: "x" }, whiteroom: { reason: "db_unavailable" } }));
  assert.equal((await send(whiteroomFetch({ fetch: bodyOnly.f, failOpen: true, providerBaseUrl: ANTHROPIC }))).status, 503);
  assert.equal(bodyOnly.calls.length, 1);
  const headerHalf = fake(() => new Response("busy", { status: 503, headers: { "x-frame-options": "DENY" } }));
  assert.equal((await send(whiteroomFetch({ fetch: headerHalf.f, failOpen: true, providerBaseUrl: ANTHROPIC }))).status, 200);
  assert.equal(headerHalf.calls.length, 2, "one engine header alone isn't enough");
});

test("without AbortSignal.any, cancelling or a failing body also releases the listeners", async (t) => {
  const original = AbortSignal.any;
  delete AbortSignal.any;
  t.after(() => { AbortSignal.any = original; });
  const watch = () => {
    const ctrl = new AbortController();
    const counts = { added: 0, removed: 0 };
    const add = ctrl.signal.addEventListener.bind(ctrl.signal), remove = ctrl.signal.removeEventListener.bind(ctrl.signal);
    ctrl.signal.addEventListener = (...a) => { counts.added++; return add(...a); };
    ctrl.signal.removeEventListener = (...a) => { counts.removed++; return remove(...a); };
    return { ctrl, counts };
  };
  const endless = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([1])); } }), { status: 200 });
  const broken = async () => new Response(new ReadableStream({ pull(c) { c.error(new Error("reset")); } }), { status: 200 });
  const opts = (f) => ({ fetch: f, failOpen: true, providerBaseUrl: ANTHROPIC, whiteroomTimeoutMs: 1_000 });

  const a = watch();
  const r1 = await whiteroomFetch(opts(endless))(`${WR}/v1/messages`, { method: "POST", body: "{}", signal: a.ctrl.signal });
  await r1.body.cancel();
  assert.deepEqual(a.counts, { added: 1, removed: 1 });

  const b = watch();
  const r2 = await whiteroomFetch(opts(broken))(`${WR}/v1/messages`, { method: "POST", body: "{}", signal: b.ctrl.signal });
  await assert.rejects(r2.text());
  assert.deepEqual(b.counts, { added: 1, removed: 1 });
});
