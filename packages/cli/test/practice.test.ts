// `whiteroom practice run` end to end: the CLI (from source) against the
// stub engine, which answers with the R4 contract fixtures.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CATALOG } from "../src/practice/catalog.js";
import { alive, ATTEMPT_PROXY_KEY, cli, CLOUD, CODE, fixture, KEY, OPENAI_KEY, SESSION, startStub, testEnv, waitFor, type CloudProvider, type Stub } from "./stub.js";

const dir = mkdtempSync(join(tmpdir(), "wr-cli-test-"));
/** A throwaway adapter script; returns its path. */
const script = (name: string, code: string) => {
  const p = join(dir, name);
  writeFileSync(p, code);
  return p;
};
const stubs: Stub[] = [];
const stub = async (...a: Parameters<typeof startStub>) => {
  const s = await startStub(...a);
  stubs.push(s);
  return s;
};
after(() => Promise.all(stubs.map((s) => s.close())));
const run = (s: Stub, extra: string[] = [], o: Parameters<typeof cli>[1] = {}) => cli(["practice", "run", "--code-stdin", "--url", s.url, ...extra], o);

/** Template A done right: the two qualifying tickets escalated to their teams, and named in the answer. */
function assertTemplateA(s: Stub) {
  assert.deepEqual(s.escalations, [{ ticketId: "T-1", team: "billing" }, { ticketId: "T-2", team: "platform" }]);
  assert.equal(s.finals.length, 1);
  assert.equal(s.finals[0].ended, "final");
  assert.match(s.finals[0].output!, /T-1 and T-2/);
  assert.deepEqual(s.contractErrors, []);
}

describe("practice run: the sample agent and the starters complete Template A", () => {
  it("sample agent (= JS starter), Anthropic key: passes, waits in plain words while WhiteRoom saves a summary", async () => {
    const s = await stub({ summaryFirst: true });
    const r = await run(s);
    assert.equal(r.code, 0, r.stderr);
    assertTemplateA(s);
    assert.match(r.stdout, /Using the key in ANTHROPIC_API_KEY \(ends 91c0\)\./);
    assert.match(r.stdout, /Sending your key to 127\.0\.0\.1:\d+ to start the practice test\./);
    assert.match(r.stdout, /Practice task 1 of 1: Finishes a job correctly/);
    assert.match(r.stdout, /Passed · all 11 checks · 3 runs/);
    assert.match(r.stdout, /not as a certificate/);
    assert.match(r.stdout, /app\.whiteroom\.tech\/sandbox/);
    assert.match(r.stderr, /WhiteRoom is saving a summary of your agent's memory\. Waiting 2 s/);
    assert.doesNotMatch(r.stdout + r.stderr, /watch_limit_exceeded|handover|compress|context/i);
    // The sample agent reports itself as such; the key went only to the claim, tasks/next and model calls.
    assert.equal(JSON.parse(s.seen.find((x) => x.path === "/api/readiness/claim")!.body).cli.adapter, "sample agent");
  });

  it("JS starter via --adapter, OpenAI key: chat completions on base_url/v1", async () => {
    const s = await stub();
    const r = await run(s, ["--adapter", "node starters/wr-adapter.mjs"], { env: testEnv({ OPENAI_API_KEY: OPENAI_KEY }) });
    assert.equal(r.code, 0, r.stderr);
    assertTemplateA(s);
    assert.ok(s.count("/v1/chat/completions") >= 6);
    assert.equal(s.count("/v1/messages"), 0);
  });

  it("Python starter via --adapter, Anthropic key", async () => {
    const s = await stub({ summaryFirst: true });
    const r = await run(s, ["--adapter", "python3 starters/wr_adapter.py"]);
    assert.equal(r.code, 0, r.stderr);
    assertTemplateA(s);
    assert.match(r.stderr, /WhiteRoom is saving a summary of your agent's memory\. Waiting 2 s/);
  });
});

describe("practice run: the model the practice test was started with", () => {
  it("the sample agent uses the practice task's model", async () => {
    const s = await stub({ taskModel: "claude-sonnet-4-5" });
    const r = await run(s);
    assert.equal(r.code, 0, r.stderr);
    assertTemplateA(s);
    assert.ok(s.models.length > 0);
    assert.deepEqual([...new Set(s.models)], ["claude-sonnet-4-5"]);
  });

  it("the sample agent keeps its own model when none was chosen", async () => {
    const s = await stub({ taskModel: null });
    const r = await run(s);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([...new Set(s.models)], ["claude-haiku-4-5"]);
  });

  it("the JS starter with an OpenAI key keeps its own model when none was chosen", async () => {
    const s = await stub({ taskModel: null });
    const r = await run(s, ["--adapter", "node starters/wr-adapter.mjs"], { env: testEnv({ OPENAI_API_KEY: OPENAI_KEY }) });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([...new Set(s.models)], ["gpt-4o-mini"]);
  });

  it("the Python starter uses the practice task's model, and its own when none was chosen", async () => {
    const chosen = await stub({ taskModel: "gpt-4.1-mini" });
    let r = await run(chosen, ["--adapter", "python3 starters/wr_adapter.py"], { env: testEnv({ OPENAI_API_KEY: OPENAI_KEY }) });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([...new Set(chosen.models)], ["gpt-4.1-mini"]);
    const none = await stub({ taskModel: null });
    r = await run(none, ["--adapter", "python3 starters/wr_adapter.py"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([...new Set(none.models)], ["claude-haiku-4-5"]);
  });

  it("the adapter's task line carries the model, or null", async () => {
    const seen = join(dir, "task-line.json");
    const adapter = script("echo-model.mjs", `import { createInterface } from "node:readline"; import { writeFileSync } from "node:fs";
const it = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const msg = JSON.parse((await it.next()).value);
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ model: msg.model, has: "model" in msg }));
console.log(JSON.stringify({ type: "final", output: "done" }));`);
    const s = await stub({ taskModel: null });
    const r = await run(s, ["--adapter", `node ${adapter}`]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), { model: null, has: true });
  });
});

describe("practice run: the starters and the fleet's controls", () => {
  it("a call blocked by a control ends the agent's answer plainly instead of crashing", async () => {
    const block = { error: { type: "permission_error", message: "Blocked by WhiteRoom governance." }, whiteroom: { error: "governance_block", reason: "model_not_allowed", retryable: false } };
    const s = await stub({ route: (p) => (p === "/v1/messages" ? [403, block] : undefined) });
    const r = await run(s);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(s.finals.map((f) => [f.ended, f.output]), [["final", "Stopped: one of my WhiteRoom controls blocked the model call."]]);
  });

  for (const [who, extra] of [["JS starter", []], ["Python starter", ["--adapter", "python3 starters/wr_adapter.py"]]] as const) {
    it(`${who}: a 410 (the practice fleet is gone) ends the agent's answer plainly instead of crashing`, async () => {
      const s = await stub({ route: (p) => (p === "/v1/messages" ? [410, { error: "Gone." }] : undefined) });
      const r = await run(s, [...extra]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(s.finals.map((f) => [f.ended, f.output]), [["final", "Stopped: WhiteRoom closed this practice task."]]);
    });

    it(`${who}: never follows a redirect, so the key never reaches another host`, async () => {
      const other = await stub();
      const s = await stub({ route: (p) => (p === "/v1/messages" ? [302, {}, { location: `${other.url}${p}` }] : undefined) });
      const r = await run(s, [...extra]);
      assert.equal(r.code, 3);
      assert.equal(s.count("/v1/messages"), 1);
      assert.equal(other.seen.length, 0);
    });
  }
});

describe("practice run: control checks", () => {
  it("sends each planned call with the key and reports WhiteRoom's answer back", async () => {
    const s = await stub({ plan: ["controls"] });
    const r = await run(s);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Checking your controls/);
    const calls = s.seen.filter((x) => x.path === "/v1/messages");
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.headers["x-api-key"], KEY);
      assert.equal(c.headers["x-wr-readiness-attempt"], "a-1");
    }
    assert.deepEqual(s.controlResults, [{ status: 403, reason: "model_not_allowed", ruleId: "gr_allow" }, { status: 200, reason: null, ruleId: null }]);
    assert.deepEqual(s.contractErrors, []);
  });

  it("never sends the key to another host, even if WhiteRoom names one", async () => {
    const s = await stub({
      plan: ["controls"],
      route: (path) => {
        if (path !== "/api/readiness/controls/next") return undefined;
        const f = fixture("controls.next.request");
        (f.response as any).request.url = "https://attacker.example/v1/messages";
        return [200, f.response];
      },
    });
    const r = await run(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /another host/);
  });
});

describe("practice run: a practice task on another host", () => {
  it("is refused before the adapter starts, so the key never goes there", async () => {
    const marker = join(dir, "adapter-started");
    const adapter = script("marker-adapter.mjs", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "1");`);
    const s = await stub({
      route: (path) => {
        if (path !== "/api/readiness/tasks/next") return undefined;
        const f = fixture("tasks.next.task.A");
        Object.assign((f.response as any).task, { attemptId: "a-1", deadline: new Date(Date.now() + 60_000).toISOString(), baseUrl: "https://attacker.example" });
        return [200, f.response];
      },
    });
    const r = await run(s, ["--adapter", `node ${adapter}`]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /another host, so the CLI stopped before sending your key there/);
    assert.equal(existsSync(marker), false);
    assert.equal(s.count("/v1/messages"), 0);
  });
});

describe("practice run: cloud providers through a Fleet key provider key (R7, §17)", () => {
  const ROUTE: Record<CloudProvider, string> = {
    "azure-openai": `/${ATTEMPT_PROXY_KEY}/openai/v1/chat/completions`,
    foundry: `/${ATTEMPT_PROXY_KEY}/v1/messages`,
    "bedrock-mantle": `/${ATTEMPT_PROXY_KEY}/v1/messages`,
  };
  const HEADER: Record<CloudProvider, string> = { "azure-openai": "api-key", foundry: "x-api-key", "bedrock-mantle": "authorization" };
  const MODEL = fixture("r7.tasks.next.task").response as { task: { model: string } };
  const env = (p: CloudProvider) => testEnv({ [CLOUD[p].keyVar]: CLOUD[p].key });

  for (const provider of Object.keys(CLOUD) as CloudProvider[]) {
    for (const [who, extra] of [["sample agent", []], ["Python starter", ["--adapter", "python3 starters/wr_adapter.py"]]] as const) {
      it(`${provider}, ${who}: the key from ${CLOUD[provider].keyVar}, in that provider's header, on its route, with the chosen model`, async () => {
        const s = await stub({ cloud: provider });
        const r = await run(s, [...extra], { env: env(provider) });
        assert.equal(r.code, 0, r.stderr);
        assertTemplateA(s);
        assert.match(r.stdout, new RegExp(`Using the key in ${CLOUD[provider].keyVar} \\(ends ${CLOUD[provider].key.slice(-4)}\\)\\.`));
        assert.ok(s.calls.length >= 6);
        assert.deepEqual([...new Set(s.calls.map((c) => `${c.path} ${c.keyHeader}`))], [`${ROUTE[provider]} ${HEADER[provider]}`]);
        assert.deepEqual([...new Set(s.models)], [MODEL.task.model]);
      });
    }
  }

  it("the adapter gets the key only in the run's provider variable, and an OpenAI-style base URL for Azure", async () => {
    const seen = join(dir, "cloud-env.json");
    const spy = script("cloud-env.mjs", `import { createInterface } from "node:readline"; import { writeFileSync } from "node:fs";
const it = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const msg = JSON.parse((await it.next()).value);
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ vars: Object.keys(process.env).filter((k) => /API_KEY|BEARER_TOKEN/.test(k)).sort(), base: msg.base_url }));
console.log(JSON.stringify({ type: "final", output: "done" }));`);
    const s = await stub({ cloud: "azure-openai" });
    const r = await run(s, ["--adapter", `node ${spy}`], { env: env("azure-openai") });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), { vars: ["AZURE_OPENAI_API_KEY"], base: `${s.url}/${ATTEMPT_PROXY_KEY}/openai/v1` });
  });

  it("control checks send the key in the provider's header (Azure: api-key, nothing else)", async () => {
    const s = await stub({ cloud: "azure-openai", plan: ["controls"] });
    const r = await run(s, [], { env: env("azure-openai") });
    assert.equal(r.code, 0, r.stderr);
    const calls = s.seen.filter((x) => x.path === ROUTE["azure-openai"]);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.headers["api-key"], CLOUD["azure-openai"].key);
      assert.equal(c.headers.authorization, undefined);
      assert.equal(c.headers["x-api-key"], undefined);
    }
    assert.deepEqual(s.controlResults, [{ status: 403, reason: "model_not_allowed", ruleId: "gr_allow" }, { status: 200, reason: null, ruleId: null }]);
  });

  it("the wrong key names the Fleet key key it should be (exit 2, nothing else sent)", async () => {
    const s = await stub({ cloud: "azure-openai" });
    const r = await run(s, [], { env: testEnv({ AZURE_OPENAI_API_KEY: "azure-placeholder-other-key-91c0" }) });
    assert.equal(r.code, 2);
    const hint = (fixture("r7.claim.key_mismatch").response as { keyHint: string }).keyHint;
    assert.ok(r.stderr.includes(`The key in AZURE_OPENAI_API_KEY (ends 91c0) isn't the Azure OpenAI key saved on Fleet key (key ending ${hint}).`), r.stderr);
    assert.match(r.stderr, /Nothing was charged\. If you've changed keys, add the new one on Fleet key, then start a new test in the dashboard and pick that key\./);
    assert.deepEqual(s.seen.map((x) => x.path), ["/api/readiness/claim"]);
  });

  it("a short-term Bedrock key: refused before anything is sent, and in WhiteRoom's answer too (exit 2)", async () => {
    const s = await stub({ cloud: "bedrock-mantle" });
    const short = "bedrock-api-key-placeholder-short-term";
    let r = await run(s, [], { env: testEnv({ AWS_BEARER_TOKEN_BEDROCK: short }) });
    assert.equal(r.code, 2);
    // The catalog's words, as the dashboard shows them.
    assert.ok(r.stderr.includes(CATALOG.keyRefusals.short_term_key), r.stderr);
    assert.equal(s.seen.length, 0);
    const answered = await stub({ route: (p) => (p === "/api/readiness/claim" ? [fixture("r7.claim.short_term_key").status, fixture("r7.claim.short_term_key").response] : undefined) });
    r = await run(answered, [], { env: env("bedrock-mantle") });
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes(CATALOG.keyRefusals.short_term_key), r.stderr);
  });

  it("several provider variables set: names them and sends nothing; --key-env picks one, as the dashboard's command does", async () => {
    const s = await stub({ cloud: "foundry" });
    const all = testEnv({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_FOUNDRY_API_KEY: CLOUD.foundry.key, AWS_BEARER_TOKEN_BEDROCK: CLOUD["bedrock-mantle"].key });
    let r = await run(s, [], { env: all });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ANTHROPIC_API_KEY, ANTHROPIC_FOUNDRY_API_KEY and AWS_BEARER_TOKEN_BEDROCK are all set\. Add --key-env with the one your agent uses/);
    assert.equal(s.seen.length, 0);
    r = await run(s, ["--key-env", "ANTHROPIC_FOUNDRY_API_KEY"], { env: all });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(s.seen[0].body).key, CLOUD.foundry.key);
    // Only a provider key variable, and only one that is set.
    for (const [args, message] of [[["--key-env", "PATH"], /--key-env must name a provider key variable/], [["--key-env", "OPENAI_API_KEY"], /Set the key your agent uses \(OPENAI_API_KEY\)/]] as const) {
      const none = await stub({ cloud: "foundry" });
      r = await run(none, [...args], { env: all });
      assert.equal(r.code, 2);
      assert.match(r.stderr, message);
      assert.equal(none.seen.length, 0);
    }
  });

  it("a provider this CLI doesn't know: asks to update it before any task runs", async () => {
    const s = await stub({ route: (p) => (p === "/api/readiness/claim" ? [200, { ...(fixture("r7.claim").response as object), session: SESSION, run: { ...(fixture("r7.claim").response as any).run, provider: "vertex" } }] : undefined) });
    const r = await run(s);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Update the CLI/);
    assert.equal(s.count("/api/readiness/tasks/next"), 0);
  });
});

describe("practice run: claim errors (exit 2, nothing else sent)", () => {
  const claimOnly = (name: string) => stub({ route: (p) => (p === "/api/readiness/claim" ? [fixture(name).status, fixture(name).response] : undefined) });

  it("wrong key with tries left", async () => {
    const s = await claimOnly("claim.key_mismatch");
    const r = await run(s);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /This key isn't the one your agent uses with <fleet>\. Nothing was charged, and your run code still works \(4 more tries\)\. Set ANTHROPIC_API_KEY to the right key, then run the same command again\./);
    assert.deepEqual(s.seen.map((x) => x.path), ["/api/readiness/claim"]);
  });

  it("wrong key names the fleet the dashboard shows, or says this fleet", async () => {
    const named = await stub({ route: (p) => (p === "/api/readiness/claim" ? [401, { ...(fixture("claim.key_mismatch").response as object), fleetName: "prod-eu" }] : undefined) });
    let r = await run(named);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /This key isn't the one your agent uses with prod-eu\. Nothing was charged/);
    const { fleetName: _, ...bare } = fixture("claim.key_mismatch").response as Record<string, unknown>;
    const unnamed = await stub({ route: (p) => (p === "/api/readiness/claim" ? [401, bare] : undefined) });
    r = await run(unnamed);
    assert.match(r.stderr, /This key isn't the one your agent uses with this fleet\. Nothing was charged/);
  });

  it("wrong key on the last try", async () => {
    const s = await claimOnly("claim.last_try");
    const r = await run(s);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /That was the last try, so this run code no longer works\. Nothing was charged\..*click Get a new run code/);
  });

  it("expired or used run code", async () => {
    const s = await claimOnly("claim.code_invalid");
    const r = await run(s);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /doesn't work any more.*click Get a new run code/);
  });

  it("a malformed run code uses no try: nothing is sent", async () => {
    const s = await stub();
    const r = await run(s, [], { stdin: "wrrt_short\n" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /That isn't a run code/);
    assert.equal(s.seen.length, 0);
  });

  it("both provider keys set: asks which, rather than guessing and using a try", async () => {
    const s = await stub();
    const r = await run(s, [], { env: testEnv({ ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: OPENAI_KEY }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Both ANTHROPIC_API_KEY and OPENAI_API_KEY are set/);
    assert.equal(s.seen.length, 0);
  });

  it("no key and no terminal to ask for one: says which variables to set", async () => {
    const s = await stub();
    const r = await run(s, [], { env: testEnv() });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Set the key your agent uses \(ANTHROPIC_API_KEY, OPENAI_API_KEY, AZURE_OPENAI_API_KEY, ANTHROPIC_FOUNDRY_API_KEY or AWS_BEARER_TOKEN_BEDROCK\)/);
    assert.equal(s.seen.length, 0);
  });
});

describe("practice run: adapter preflight (exit 2, nothing sent)", () => {
  it("a program that isn't on PATH", async () => {
    const s = await stub();
    const r = await run(s, ["--adapter", "no-such-program-wr wr_adapter.py"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Couldn't start the adapter `no-such-program-wr wr_adapter\.py`: no-such-program-wr isn't on your PATH\. Nothing was sent or charged, and your run code still works\./);
    assert.equal(s.seen.length, 0);
  });

  it("a script file that doesn't exist", async () => {
    const s = await stub();
    const r = await run(s, ["--adapter", "python3 missing_adapter.py"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing_adapter\.py doesn't exist/);
    assert.equal(s.seen.length, 0);
  });
});

describe("practice run: the session ends mid-run (exit 3)", () => {
  for (const [name, said] of [
    ["session.engine_update", /WhiteRoom was updated during your practice test, so it stopped\..*click Start test/],
    ["session.expired", /lost contact with this computer or ran out of time.*click Start test/],
    ["session.unknown", /WhiteRoom no longer knows this practice test/],
  ] as const) {
    it(`${name} on tasks/next after a finished task`, async () => {
      const s = await stub({ route: (p, _b, n) => (p === "/api/readiness/tasks/next" && n === 2 ? [fixture(name).status, fixture(name).response] : undefined) });
      const r = await run(s);
      assert.equal(r.code, 3);
      assert.match(r.stderr, said);
    });
  }

  it("ended from the dashboard (409 ended_by_owner)", async () => {
    const s = await stub({ route: (p) => (p === "/api/readiness/tools" ? [409, fixture("session.ended_by_owner").response] : undefined) });
    const r = await run(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /ended from the dashboard/);
  });

  for (const [reason, said] of [
    ["call_cap", /Stopped at this test's model-call limit after WhiteRoom had to rerun a task \(not your agent\)\./],
    ["no_model_calls", /didn't make any model calls through WhiteRoom in 2 practice tasks in a row\. Check your adapter sends its calls to the base_url/],
    ["engine_error", /WhiteRoom couldn't finish working out the result \(not your agent\)\./],
  ] as const) {
    it(`ended by WhiteRoom (409 ${reason}): says so in plain words`, async () => {
      const s = await stub({ route: (p) => (p === "/api/readiness/tasks/next" ? [409, { lifecycle: "interrupted", reason }] : undefined) });
      const r = await run(s);
      assert.equal(r.code, 3);
      assert.match(r.stderr, said);
    });
  }

  it("a run that already finished: tasks/next's finished answer shows the result, or where to see it, never a refusal", async () => {
    const s = await stub({ route: (p, _b, n) => (p === "/api/readiness/tasks/next" && n === 2 ? [409, { lifecycle: "finished", reason: "finished" }] : undefined) });
    const r = await run(s);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /The practice test finished\. See the results in the dashboard \(.*\), under Past tests\./);
    assert.doesNotMatch(r.stdout + r.stderr, /was updated|doesn't understand/);
    const done = fixture("tasks.next.done").response as any;
    const withReport = await stub({ route: (p) => (p === "/api/readiness/tasks/next" ? [409, { lifecycle: "finished", reason: "finished", report: done.report }] : undefined) });
    const shown = await run(withReport);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /Passed · all \d+ checks · 3 runs/);
  });

  it("a discarded practice task is stopped and run again, without counting", async () => {
    const s = await stub({
      plan: ["A", "A"], // tasks/next re-issues the same scenario as a new attempt
      route: (p, _b, n) => (p === "/api/readiness/tools" && n === 1 ? [409, fixture("tools.attempt_discarded").response] : undefined),
    });
    const r = await run(s);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /WhiteRoom restarted this practice task, so it starts again\. This doesn't count against your agent\./);
    assert.equal(s.count("/api/readiness/tasks/next"), 3);
    assert.equal(s.finals.length, 1);
    assert.equal(s.finals[0].attemptId, "a-2");
  });

  it("an adapter crash keeps the task as ended, ends the run with a result so far and shows the last 5 stderr lines", async () => {
    const s = await stub();
    const crash = script("crash.mjs", `for (let i = 1; i <= 7; i++) console.error("boom-" + i); process.exit(4);`);
    const r = await run(s, ["--adapter", `node ${crash}`]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Your adapter stopped before it finished the practice task \(exit code 4\)\.\nIts last lines:\n  boom-3\n  boom-4\n  boom-5\n  boom-6\n  boom-7\n/);
    assert.match(r.stderr, /The practice tasks your agent finished are in the results/);
    assert.deepEqual(s.finals.map((f) => f.ended), ["adapter_exited"]);
    assert.deepEqual(s.cancels, [{ keepResults: true }]);
  });

  it("an adapter crash on a task WhiteRoom dropped runs the task again, without ending the run", async () => {
    const once = join(dir, "crashed-once");
    const flaky = script("flaky.mjs", `import { existsSync, writeFileSync } from "node:fs";
if (!existsSync(${JSON.stringify(once)})) { writeFileSync(${JSON.stringify(once)}, "1"); process.exit(4); }
await import(${JSON.stringify(new URL("../starters/wr-adapter.mjs", import.meta.url).href)});`);
    const s = await stub({
      plan: ["A", "A"],
      route: (p) => (p === "/api/readiness/tasks/a-1/final" ? [409, fixture("tools.attempt_discarded").response] : undefined),
    });
    const r = await run(s, ["--adapter", `node ${flaky}`]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /WhiteRoom restarted this practice task, so it starts again\./);
    assert.deepEqual(s.cancels, []);
  });
});

describe("practice run: child process rules (§9.4)", () => {
  // Starts a grandchild in the adapter's process group, then hangs, ignoring SIGTERM.
  const hang = (pidFile: string) => script(`hang-${Math.random()}.mjs`, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    process.on("SIGTERM", () => {});
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    setInterval(() => {}, 1000);
  `);

  it("Ctrl+C twice kills the adapter's whole process group, ends the run and exits 3", async () => {
    const s = await stub();
    const pidFile = join(dir, "ctrlc.pid");
    let warned = false;
    const r = await run(s, ["--adapter", `node ${hang(pidFile)}`], {
      during: (pid, out) => {
        void (async () => {
          await waitFor(() => existsSync(pidFile));
          process.kill(pid, "SIGINT");
          await waitFor(() => /Press Ctrl\+C again/.test(out()));
          warned = true;
          process.kill(pid, "SIGINT");
        })();
      },
    });
    assert.ok(warned);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Practice test ended\. Finished practice tasks were kept\./);
    assert.equal(s.count("/api/readiness/cancel"), 1);
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
  });

  it("SIGTERM to the CLI ends the run the same way (exit 3, cancelled, group killed)", async () => {
    const s = await stub();
    const pidFile = join(dir, "term.pid");
    const r = await run(s, ["--adapter", `node ${hang(pidFile)}`], {
      during: (pid) => void waitFor(() => existsSync(pidFile)).then(() => process.kill(pid, "SIGTERM")),
    });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Practice test ended\./);
    assert.equal(s.count("/api/readiness/cancel"), 1);
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
  });

  it("at the deadline: SIGTERM, then SIGKILL after 5 s, to the whole group; the task ends as 'deadline'", async () => {
    const s = await stub({ taskMs: 1_000, done: fixture("tasks.next.done").response });
    const pidFile = join(dir, "deadline.pid");
    const r = await run(s, ["--adapter", `node ${hang(pidFile)}`]);
    assert.match(r.stderr, /didn't finish this practice task in time/);
    assert.deepEqual(s.finals.map((f) => f.ended), ["deadline"]);
    assert.ok(r.ms >= 6_000, `took ${r.ms} ms`);
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
  });

  it("the adapter's environment has the key, and nothing of WhiteRoom's (no WHITEROOM_*, run code or session)", async () => {
    const s = await stub();
    const spy = script("env.mjs", `
      import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        const env = JSON.stringify(process.env);
        const out = {
          vars: Object.keys(process.env).filter((k) => /^WHITEROOM_|API_KEY/i.test(k)).sort(),
          key: process.env.ANTHROPIC_API_KEY,
          secrets: [${JSON.stringify(CODE)}, ${JSON.stringify(SESSION)}].filter((x) => env.includes(x) || line.includes(x)).length,
          message: Object.keys(JSON.parse(line)).sort(),
        };
        console.log("debug: hello-local-only");
        console.log(JSON.stringify({ type: "final", output: JSON.stringify(out) }));
      });
    `);
    const r = await run(s, ["--adapter", `node ${spy}`], {
      env: testEnv({ ANTHROPIC_API_KEY: KEY, WHITEROOM_API_KEY: "wr_placeholder", WHITEROOM_URL: "http://127.0.0.1:9" }),
    });
    assert.equal(r.code, 0, r.stderr);
    const seen = JSON.parse(s.finals[0].output!);
    assert.deepEqual(seen, { vars: ["ANTHROPIC_API_KEY"], key: KEY, secrets: 0, message: ["base_url", "headers", "model", "task", "tools", "type"] });
    // WHITEROOM_URL is ignored, and said so.
    assert.match(r.stdout, /Ignoring WHITEROOM_URL: practice tests always run on WhiteRoom\./);
    // Stdout that isn't JSON is shown here and never uploaded.
    assert.match(r.stdout, /adapter: debug: hello-local-only/);
    assert.ok(!s.seen.some((x) => x.body.includes("hello-local-only")));
  });

  it("a stdout line over 1 MiB stops the adapter (exit 3)", async () => {
    const s = await stub();
    const big = script("big.mjs", `process.stdout.write("x".repeat(1024 * 1024 + 10)); setInterval(() => {}, 1000);`);
    const r = await run(s, ["--adapter", `node ${big}`]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Your adapter sent a line longer than 1 MiB, so it was stopped\./);
    assert.deepEqual(s.finals.map((f) => f.ended), ["adapter_exited"]);
  });

  it("strips terminal control and bidi characters from what the adapter prints", async () => {
    const s = await stub();
    const nasty = script("nasty.mjs", `
      console.error("red" + String.fromCharCode(27) + "[31m text" + String.fromCharCode(0x202e) + "evil");
      console.log(JSON.stringify({ type: "final", output: "done" }));
    `);
    const r = await run(s, ["--adapter", `node ${nasty}`]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /red\[31m textevil/);
    assert.ok(!r.stderr.includes(String.fromCharCode(27)) && !r.stderr.includes(String.fromCharCode(0x202e)));
  });
});

describe("practice run: redirects and refusals", () => {
  const redirectTo = (other: Stub, path: string) => (p: string) => (p === path ? [307, {}, { location: `${other.url}${p}` }] as [number, unknown, Record<string, string>] : undefined);

  it("a redirect on the claim: stops (exit 2), and the key never leaves the chosen host", async () => {
    const other = await stub();
    const s = await stub({ route: redirectTo(other, "/api/readiness/claim") });
    const r = await run(s);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /tried to send the CLI to another address/);
    assert.equal(other.seen.length, 0);
    assert.equal(s.count("/api/readiness/claim"), 1);
  });

  it("a redirect after the claim ends the test (exit 3)", async () => {
    const other = await stub();
    const s = await stub({ route: redirectTo(other, "/api/readiness/tasks/next") });
    const r = await run(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /tried to send the CLI to another address/);
    assert.equal(other.seen.length, 0);
  });

  it("a redirect on a control check's model call is reported as no result, and isn't followed", async () => {
    const other = await stub();
    const s = await stub({ plan: ["controls"], route: redirectTo(other, "/v1/messages") });
    const r = await run(s);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(s.controlResults, [{ status: 0, reason: null, ruleId: null }, { status: 0, reason: null, ruleId: null }]);
    assert.equal(other.seen.length, 0);
  });

  it("WhiteRoom's test-tool limit ends the task as the adapter's, cancels and exits 3", async () => {
    const s = await stub({ route: (p, _b, n) => (p === "/api/readiness/tools" && n === 3 ? [429, fixture("tools.tool_limit").response] : undefined) });
    const r = await run(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Your adapter made more test-tool calls than a practice task allows, so it was stopped\./);
    assert.deepEqual(s.finals.map((f) => f.ended), ["adapter_exited"]);
    assert.deepEqual(s.cancels, [{ keepResults: true }]);
  });

  it("a task without a readable deadline never starts the adapter (nothing is charged to the agent)", async () => {
    const s = await stub({
      route: (p) => {
        if (p !== "/api/readiness/tasks/next") return undefined;
        const f = fixture("tasks.next.task.A");
        (f.response as any).task.baseUrl = s.url;
        return [200, f.response]; // deadline is the fixture's "<time>"
      },
    });
    const r = await run(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Update the CLI/);
    assert.deepEqual(s.finals, []);
  });

  it("a refused request (403) after the claim has its own plain copy", async () => {
    const s = await stub({ route: (p) => (p === "/api/readiness/tasks/next" ? [403, { error: "Forbidden." }] : undefined) });
    const r = await run(s);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /WhiteRoom refused the CLI's request\./);
  });

  it("WhiteRoom can't be reached at the claim: exit 3, safe to retry", async () => {
    const r = await cli(["practice", "run", "--code-stdin", "--url", "http://127.0.0.1:9"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Couldn't reach WhiteRoom/);
  });
});

describe("practice run: target (§9.3)", () => {
  it("refuses a --url that isn't WhiteRoom's own or loopback, before sending anything (the key would go there)", async () => {
    for (const url of ["http://example.com", "https://example.com", "https://whiteroom.tech.example.com"]) {
      const r = await cli(["practice", "run", "--code-stdin", "--url", url]);
      assert.equal(r.code, 2, url);
      assert.match(r.stderr, /--url must be a WhiteRoom address/);
    }
  });
});

describe("whiteroom CLI", () => {
  it("usage problems exit 2 for practice commands", async () => {
    for (const args of [["practice", "run", "--runs", "3"], ["practice", "status"], ["practice", "adapter", "--lang", "go"], ["practice", "run", "extra"]]) {
      assert.equal((await cli(args)).code, 2, args.join(" "));
    }
  });

  it("practice adapter prints the starters; readiness is a hidden alias", async () => {
    const js = await cli(["practice", "adapter", "--lang", "js"]);
    assert.equal(js.code, 0);
    assert.equal(js.stdout, readFileSync(new URL("../starters/wr-adapter.mjs", import.meta.url), "utf8"));
    const py = await cli(["readiness", "adapter", "--lang", "python"]);
    assert.equal(py.stdout, readFileSync(new URL("../starters/wr_adapter.py", import.meta.url), "utf8"));
    const help = await cli(["--help"]);
    assert.match(help.stdout, /whiteroom practice run/);
    assert.doesNotMatch(help.stdout, /readiness/);
  });

  it("legacy commands still parse --url and reach the server", async () => {
    const s = await stub();
    const r = await cli(["health", "--url", s.url]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { status: "ok" });
  });
});
