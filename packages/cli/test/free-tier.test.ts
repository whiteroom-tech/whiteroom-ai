// Free tier answers: plain messages for every busy, paused and limit answer,
// busy answers waited out (never for a claim), and a result whose evidence
// wasn't all saved never shown as a pass. Placeholders only (public repo).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { Engine } from "../src/practice/engine.js";
import { copy, reportOf, results, type Report } from "../src/practice/text.js";
import { freeTierCode, freeTierMessage, rerunWontFix, responseCopy, retryAfterSeconds, waitWords } from "../src/responses.js";
import { cli, fixture, KEY, PKG, startStub, testEnv, type Stub } from "./stub.js";

const stubs: Stub[] = [];
const stub = async (...a: Parameters<typeof startStub>) => {
  const s = await startStub(...a);
  stubs.push(s);
  return s;
};
const servers: Array<{ close: () => void; closeAllConnections: () => void }> = [];
after(async () => {
  for (const s of servers) (s.closeAllConnections(), s.close());
  await Promise.all(stubs.map((s) => s.close()));
});
const practice = (s: Stub, extra: string[] = []) => cli(["practice", "run", "--code-stdin", "--url", s.url, ...extra]);

const PAUSED = { error: "x", reason: "free_paused", code: "free_paused", whiteroom: { reason: "free_paused", forwarded: false } };
const busy = (reason: string) => ({ error: "x", whiteroom: { reason, forwarded: false } });
const gate = (reason: string) => ({ error: { type: "quota_exceeded", message: "x" }, whiteroom: { reason, forwarded: false } });
const DAILY = { error: "x", whiteroom: { reason: "sandbox_daily_limit", forwarded: false, resetAt: "2026-11-09T00:00:00.000Z" } };

describe("Free tier messages", () => {
  it("503 free_paused, from any field, says Sandbox is paused for Free accounts", () => {
    assert.equal(freeTierMessage({ status: 503, body: PAUSED }), "Sandbox is paused for Free accounts right now. Try again later.");
    assert.equal(freeTierMessage({ status: 503, body: { reason: "free_paused" } }), responseCopy.freePaused);
    assert.equal(freeTierMessage({ status: 503, body: { whiteroom: { reason: "free_paused" } } }), responseCopy.freePaused);
  });

  it("503 busy answers say who is busy and how long to wait, from Retry-After", () => {
    assert.equal(freeTierMessage({ status: 503, body: busy("sandbox_busy"), retryAfter: "30" }), "The Sandbox is busy right now. Try again in 30 seconds.");
    assert.equal(freeTierMessage({ status: 503, body: busy("control_busy"), retryAfter: "1" }), "WhiteRoom is busy right now. Try again in 1 second.");
    assert.equal(freeTierMessage({ status: 503, body: busy("cleanup_busy"), retryAfter: "120" }), "WhiteRoom is busy cleaning up Sandboxes. Try again in 2 minutes.");
    assert.equal(freeTierMessage({ status: 503, body: busy("db_unavailable"), retryAfter: "5" }), "WhiteRoom can't save Sandbox results right now. Try again in 5 seconds.");
    assert.equal(freeTierMessage({ status: 503, body: busy("sandbox_busy") }), "The Sandbox is busy right now. Try again in a minute.");
  });

  it("402 sandbox_daily_limit names the reset time in UTC (the sample start's 429 code too)", () => {
    assert.equal(freeTierMessage({ status: 402, body: DAILY }), "Your Sandbox has used all its calls for today. They reset at 00:00 UTC.");
    assert.equal(freeTierMessage({ status: 429, body: { reason: "limit_fleet", code: "sandbox_daily_limit", resetAt: "2026-11-09T00:00:00.000Z" } }), responseCopy.dailyLimit("00:00"));
    assert.equal(freeTierMessage({ status: 402, body: busy("sandbox_daily_limit") }), responseCopy.dailyLimit("00:00"));
  });

  it("402 quota_exceeded reasons say what to do: pick a plan, update billing, sign up, link again", () => {
    assert.match(freeTierMessage({ status: 402, body: gate("plan_free") })!, /Free plan doesn't include production calls\. Pick a plan in the dashboard/);
    assert.equal(freeTierMessage({ status: 402, body: gate("suspended") }), "This fleet has no active plan. Pick a plan in WhiteRoom (https://app.whiteroom.tech) to switch it back on.");
    assert.doesNotMatch(freeTierMessage({ status: 402, body: gate("suspended") })!, /payment|billing/);
    assert.match(freeTierMessage({ status: 402, body: gate("unclaimed") })!, /isn't linked to a WhiteRoom account yet\. Sign up or sign in/);
    assert.match(freeTierMessage({ status: 402, body: gate("revoked") })!, /no longer linked to a WhiteRoom account\. Link it again/);
    assert.match(freeTierMessage({ status: 402, body: gate("not_available") })!, /can't take production calls yet\. Sign up or sign in/);
  });

  it("anything else isn't a Free tier answer", () => {
    assert.equal(freeTierMessage({ status: 503, body: { error: "x" } }), null);
    assert.equal(freeTierMessage({ status: 503, body: null }), null);
    assert.equal(freeTierMessage({ status: 402, body: gate("something_new") }), null);
    assert.equal(freeTierMessage({ status: 429, body: busy("watch_limit_exceeded") }), null);
    assert.equal(freeTierCode(403, busy("revoked")), null);
  });

  it("uses no codes or internal words", () => {
    const all = JSON.stringify(Object.values(responseCopy).map((v) => (typeof v === "function" ? v("X") : v)));
    assert.doesNotMatch(all, /_busy|_paused|_limit|quota|principal|lane|evidence|engine/i);
  });

  it("Retry-After: one parser; waits kept between 1 and 60 seconds, put in words", () => {
    assert.deepEqual(["0", "1", "2.5", "600", null, "", "soon"].map((h) => retryAfterSeconds(h)), [1, 1, 3, 60, null, null, null]);
    assert.equal(retryAfterSeconds("600", Infinity), 600);
    assert.deepEqual(["1", "45", "60", "90", "300", null, "0"].map(waitWords), ["1 second", "45 seconds", "a minute", "2 minutes", "5 minutes", "a minute", "1 second"]);
  });

  it("a rerun won't fix the daily limit or a plan refusal (exit 2); busy and paused are worth retrying (3)", () => {
    assert.equal(rerunWontFix(402, DAILY), true);
    for (const r of ["plan_free", "suspended", "unclaimed", "revoked", "not_available"]) assert.equal(rerunWontFix(402, gate(r)), true);
    assert.equal(rerunWontFix(503, PAUSED), false);
    for (const r of ["sandbox_busy", "control_busy", "cleanup_busy", "db_unavailable"]) assert.equal(rerunWontFix(503, busy(r)), false);
    assert.equal(rerunWontFix(409, { reason: "expired" }), false);
  });
});

/** Collects what this process writes to stderr until stop() (the CLI's waits print there). */
function captureStderr() {
  const write = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => ((out += String(chunk)), true)) as typeof process.stderr.write;
  return { text: () => out, stop: () => void (process.stderr.write = write) };
}

/** A server that answers each request with `answers[n]` (the last one again after that). */
async function answering(answers: Array<[number, unknown, Record<string, string>?]>) {
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const [status, body, headers] = answers[Math.min(n++, answers.length - 1)];
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, count: () => n };
}

describe("Engine.post and Free tier answers", () => {
  const RA = { "retry-after": "1" };

  it("a busy answer is waited out as Retry-After says, saying so once, then the request goes through", async () => {
    const s = await answering([[503, busy("control_busy"), RA], [503, busy("sandbox_busy"), RA], [200, { ok: true }]]);
    const t0 = Date.now();
    const said = captureStderr();
    const r = await new Engine(s.url).post("/x", {}).finally(said.stop);
    assert.equal(r.status, 200);
    assert.equal(s.count(), 3);
    assert.ok(Date.now() - t0 >= 1900, "waited Retry-After each time");
    assert.equal(said.text().match(/WhiteRoom is busy\. Waiting, then trying again\./g)?.length, 1);
  });

  it("a long busy wait (10 s or more) is announced again", async () => {
    const s = await answering([[503, busy("control_busy"), RA], [503, busy("control_busy"), { "retry-after": "10" }], [200, { ok: true }]]);
    const said = captureStderr();
    const r = await new Engine(s.url).post("/x", {}).finally(said.stop);
    assert.equal(r.status, 200);
    assert.equal(said.text().match(/WhiteRoom is busy/g)?.length, 2);
  });

  it("busy answers are waited out for the whole offline budget, not a few tries, then returned with Retry-After", async () => {
    const s = await answering([[503, busy("db_unavailable"), RA]]);
    const said = captureStderr();
    const t0 = Date.now();
    const r = await new Engine(s.url, 3_500).post("/x", {}, { retryNetwork: true }).finally(said.stop);
    assert.equal(r.status, 503);
    assert.equal(r.retryAfter, "1");
    assert.ok(Date.now() - t0 >= 3_500);
    assert.ok(s.count() >= 4, `sent ${s.count()} times`);
  });

  it("a claim (retryBusy: false) is never sent again by itself", async () => {
    const s = await answering([[503, busy("control_busy"), RA], [200, { ok: true }]]);
    const r = await new Engine(s.url).post("/x", {}, { retryBusy: false });
    assert.equal(r.status, 503);
    assert.equal(s.count(), 1);
  });

  it("free_paused and 402s come back at once, never retried", async () => {
    for (const [status, body] of [[503, PAUSED], [402, DAILY], [402, gate("plan_free")]] as const) {
      const s = await answering([[status, body, { "retry-after": "60" }], [200, { ok: true }]]);
      const r = await new Engine(s.url).post("/x", {}, { retryNetwork: true });
      assert.equal(r.status, status);
      assert.equal(s.count(), 1);
    }
  });
});

describe("results: a pass is shown only when every result was saved", () => {
  const report = () => structuredClone((fixture("tasks.next.done").response as { report: Report }).report);

  it("the contract's result carries evidence complete: Passed, exit 0", () => {
    const rep = report();
    assert.equal(rep.evidence, "complete");
    const r = results(rep);
    assert.equal(r.code, 0);
    assert.match(r.lines[1], /^Passed · /);
  });

  it("a passed verdict with evidence incomplete: Not proven, exit 3, never Passed", () => {
    const r = results({ ...report(), evidence: "incomplete" });
    assert.equal(r.code, 3);
    assert.equal(r.lines[1], "Not proven: some results couldn't be saved. Run it again.");
    assert.ok(!r.lines.some((l) => /^Passed ·/.test(l)));
    assert.match(r.lines.at(-1)!, /click Start test\.$/);
    assert.doesNotMatch(r.lines.join("\n"), /Run it 3 times/);
  });

  for (const evidence of ["pending", undefined] as const) {
    it(`evidence ${evidence ?? "missing"} (an older WhiteRoom): the verdict as it is`, () => {
      const r = results({ ...report(), evidence });
      assert.equal(r.code, 0);
      assert.match(r.lines[1], /^Passed · /);
      assert.doesNotMatch(r.lines.join("\n"), /Not proven/);
    });
  }

  it("an incomplete verdict whose results weren't all saved says so under Didn't finish", () => {
    const rep = { ...report(), verdict: "incomplete" as const, evidence: "incomplete" as const };
    rep.checks[0].status = "not_tested";
    const r = results(rep);
    assert.equal(r.code, 3);
    assert.match(r.lines[1], /^Didn't finish · 1 check couldn't run/);
    assert.equal(r.lines[2], copy.notProven);
  });

  it("--require never turns a not-proven pass into a pass", () => {
    const r = results({ ...report(), evidence: "incomplete" }, ["finishes_job"]);
    assert.notEqual(r.code, 0);
  });

  it("reportOf takes the reply's evidence when the result has none", () => {
    const { evidence: _e, ...rep } = report();
    assert.equal(reportOf({ evidence: "incomplete", report: rep }).evidence, "incomplete");
    assert.equal(reportOf({ evidence: "incomplete", report: report() }).evidence, "complete");
  });

  it("a finished run without its result: a pass whose results weren't all saved says Not proven, never Passed or Didn't finish", () => {
    assert.match(copy.finished("passed", "complete"), /finished: Passed\./);
    assert.match(copy.finished("passed", undefined), /finished: Passed\./);
    assert.equal(copy.finished("passed", "incomplete"), "The practice test finished. Not proven: some results couldn't be saved. Run it again.");
    assert.match(copy.finished("not_passed", "incomplete"), /finished: Didn't pass\./);
    for (const v of ["passed", "not_passed"]) for (const e of ["incomplete", "pending", undefined]) assert.doesNotMatch(copy.finished(v, e), /finished: Didn't finish/);
  });
});

describe("practice run: Free tier answers end to end", () => {
  it("claim refused while Free Sandbox work is paused: plain words, exit 3, sent once", async () => {
    const s = await stub({ route: (p) => (p === "/api/readiness/claim" ? [503, PAUSED, { "retry-after": "60" }] : undefined) });
    const r = await practice(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Sandbox is paused for Free accounts right now\. Try again later\. Your run code still works\./);
    assert.equal(s.count("/api/readiness/claim"), 1);
  });

  it("claim answered busy: says how long to wait, never claims again by itself", async () => {
    const s = await stub({ route: (p) => (p === "/api/readiness/claim" ? [503, busy("control_busy"), { "retry-after": "2" }] : undefined) });
    const r = await practice(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /WhiteRoom is busy right now\. Try again in 2 seconds\. Your run code still works\./);
    assert.equal(s.count("/api/readiness/claim"), 1);
  });

  it("a busy tasks/next is waited out and the test carries on", async () => {
    const s = await stub({ route: (p, _b, n) => (p === "/api/readiness/tasks/next" && n === 1 ? [503, busy("sandbox_busy"), { "retry-after": "1" }] : undefined) });
    const r = await practice(s);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Passed · /);
    assert.match(r.stderr, /WhiteRoom is busy\. Waiting, then trying again\./);
  });

  it("paused mid-run (503 free_paused): plain words, exit 3", async () => {
    const s = await stub({ route: (p, _b, n) => (p === "/api/readiness/tasks/next" && n === 2 ? [503, PAUSED, { "retry-after": "60" }] : undefined) });
    const r = await practice(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Sandbox is paused for Free accounts right now\. Try again later\./);
    assert.equal(s.count("/api/readiness/tasks/next"), 2);
  });

  it("a run cancelled on WhiteRoom's side with no reason it names (409 cancelled, engine_update): neutral words, no guess", async () => {
    const s = await stub({ route: (p, _b, n) => (p === "/api/readiness/tasks/next" && n === 2 ? [409, { lifecycle: "cancelled", reason: "engine_update", tasksFinished: 1, evidence: "incomplete" }] : undefined) });
    const r = await practice(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /This practice test was stopped on WhiteRoom's side\. Run it again later\./);
    assert.doesNotMatch(r.stderr, /was updated|Free accounts/);
  });

  it("a 409 naming free_paused says paused", async () => {
    const s = await stub({ route: (p, _b, n) => (p === "/api/readiness/tasks/next" && n === 2 ? [409, { lifecycle: "cancelled", reason: "free_paused", tasksFinished: 1 }] : undefined) });
    const r = await practice(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Sandbox is paused for Free accounts right now/);
  });

  it("refusals a rerun won't fix exit 2: the daily limit at claim, a plan refusal mid-run", async () => {
    let s = await stub({ route: (p) => (p === "/api/readiness/claim" ? [402, DAILY] : undefined) });
    let r = await practice(s);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /They reset at 00:00 UTC\./);
    assert.doesNotMatch(r.stderr, /run code still works/);
    s = await stub({ route: (p, _b, n) => (p === "/api/readiness/tasks/next" && n === 2 ? [402, gate("plan_free")] : undefined) });
    r = await practice(s);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Pick a plan/);
  });

  it("a result with evidence pending (an older WhiteRoom) shows the verdict as it is", async () => {
    const done = fixture("tasks.next.done").response as any;
    done.report.evidence = "pending";
    const s = await stub({ done });
    const r = await practice(s);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Passed · /m);
  });

  it("a result whose evidence wasn't all saved: Not proven, exit 3, never Passed", async () => {
    const done = fixture("tasks.next.done").response as any;
    done.report.evidence = "incomplete";
    done.evidence = "incomplete";
    const s = await stub({ done });
    const r = await practice(s);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stdout, /Not proven: some results couldn't be saved\. Run it again\./);
    assert.doesNotMatch(r.stdout, /^Passed ·/m);
  });

  const starters = [["JS starter", "node starters/wr-adapter.mjs"], ["Python starter", "python3 starters/wr_adapter.py"]] as const;
  for (const [who, adapter] of starters) {
    it(`${who}: a model call answered busy is waited out with plain words`, async () => {
      const s = await stub({ route: (p, _b, n) => (p === "/v1/messages" && n === 1 ? [503, busy("sandbox_busy"), { "retry-after": "1" }] : undefined) });
      const r = await practice(s, ["--adapter", adapter]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /WhiteRoom is busy right now\. Waiting, then trying again\./);
    });

    it(`${who}: paused or out of daily calls, it stops with plain words instead of waiting`, async () => {
      for (const [status, body, said] of [
        [503, PAUSED, /Sandbox is paused for Free accounts right now\. Try again later\./],
        [402, DAILY, /Your Sandbox has used all its calls for today\. They reset at 00:00 UTC\./],
      ] as const) {
        const s = await stub({ route: (p) => (p === "/v1/messages" ? [status, body, { "retry-after": "60" }] : undefined) });
        const r = await practice(s, ["--adapter", adapter]);
        assert.equal(r.code, 3, r.stderr);
        assert.match(r.stderr, said);
        assert.equal(s.count("/v1/messages"), 1);
      }
    });
  }
});

describe("fleet commands: Free tier refusals in plain words", () => {
  it("a 402 with a plan reason says what to do instead of the raw error", async () => {
    const s = await stub({ route: (p) => (p === "/api/white-room" ? [402, gate("plan_free")] : undefined) });
    const r = await cli(["register", "agent-1", "--url", s.url, "--key", "wr_placeholder"], { env: testEnv() });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Free plan doesn't include production calls\. Pick a plan/);
    assert.doesNotMatch(r.stderr, /Error 402/);
  });
});

/** `whiteroom sandbox listen` against a server answering the helper claim (and `next`) with Free tier answers. */
describe("sandbox listen: Free tier answers", () => {
  const SANDBOX_KEY = `sk-wr-${"a".repeat(40)}`;
  const HELPER_CODE = `wrhc_${"H".repeat(43)}`;
  const listen = (url: string, extra: Record<string, string> = {}) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "sandbox", "listen", "--code-stdin", "--url", url, "--adapter", "node starters/wr-adapter.mjs"], {
      cwd: PKG, env: testEnv({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `${url}/${SANDBOX_KEY}`, ...extra }),
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.resume();
    child.stdin.end(`${HELPER_CODE}\n`);
    return new Promise<{ code: number | null; stderr: string }>((r) => child.on("close", (code) => r({ code, stderr })));
  };
  async function helperStub(claim: [number, unknown, Record<string, string>?], next?: [number, unknown, Record<string, string>?]) {
    const seen: string[] = [];
    let origin = "";
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const path = (req.url ?? "/").split("?")[0];
        seen.push(path);
        const [status, body, headers] = path.endsWith("/claim") ? claim
          : path.endsWith("/next") && next ? next
          : [200, { connected: false }];
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(status === 200 && path.endsWith("/claim") ? { ...(body as object), proxyUrl: origin } : body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url: origin, seen };
  }

  it("claim refused while paused or busy: plain words, exit 2, claimed once", async () => {
    for (const [answer, said] of [
      [[503, PAUSED, { "retry-after": "60" }], /Sandbox is paused for Free accounts right now\. Try again later\. Your helper code still works/],
      [[503, busy("control_busy"), { "retry-after": "3" }], /WhiteRoom is busy right now\. Try again in 3 seconds\. Your helper code still works/],
    ] as const) {
      const s = await helperStub(answer as [number, unknown, Record<string, string>]);
      const r = await listen(s.url);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, said);
      assert.equal(s.seen.filter((p) => p.endsWith("/claim")).length, 1);
    }
  });

  const CLAIMED: [number, unknown] = [200, { session: `wrhs_${"S".repeat(43)}`, provider: "anthropic" }];
  const NEW_CODE = /The helper disconnected and this code is used\. In the Sandbox page .*click Run agent to get a new code/;

  it("paused while listening: plain words, disconnects, says the code is used, exit 3", async () => {
    const s = await helperStub(CLAIMED, [503, PAUSED, { "retry-after": "60" }]);
    const r = await listen(s.url);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /Sandbox is paused for Free accounts right now\. Try again later\./);
    assert.match(r.stderr, NEW_CODE);
    assert.ok(s.seen.includes("/api/sandbox-helper/disconnect"));
    assert.doesNotMatch(r.stderr, /Update the CLI/);
  });

  it("busy while listening: waited out with a line, and once it gives up, disconnects and says the code is used (3)", async () => {
    const s = await helperStub(CLAIMED, [503, busy("control_busy"), { "retry-after": "1" }]);
    const r = await listen(s.url, { WHITEROOM_TEST_OFFLINE_MS: "2500" });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /WhiteRoom is busy\. Waiting, then trying again\./);
    assert.match(r.stderr, /WhiteRoom is busy right now\. Try again in 1 second\./);
    assert.match(r.stderr, NEW_CODE);
    assert.ok(s.seen.filter((p) => p.endsWith("/next")).length >= 2);
    assert.ok(s.seen.includes("/api/sandbox-helper/disconnect"));
  });

  it("the daily limit while listening is a refusal a rerun won't fix (2)", async () => {
    const s = await helperStub(CLAIMED, [402, DAILY]);
    const r = await listen(s.url);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /They reset at 00:00 UTC\./);
    assert.ok(s.seen.includes("/api/sandbox-helper/disconnect"));
  });
});
