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
  // AbortSignal.timeout doesn't hold the event loop open, and the fake
  // WhiteRoom has no socket that would; a real hanging fetch does.
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
