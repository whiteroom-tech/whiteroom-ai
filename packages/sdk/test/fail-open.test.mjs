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
    if (String(url).startsWith(WR)) {
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
