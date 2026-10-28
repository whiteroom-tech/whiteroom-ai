// The practice commands' pure parts: preflight, the child environment, the
// adapter driver's caps, what gets printed, and the results screen.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { childEnv, MAX_TOOL_CALLS, runAdapter, type ToolCall } from "../src/practice/adapter.js";
import { parseArgs } from "../src/legacy-args.js";
import { Engine, REDIRECTED, Unreachable } from "../src/practice/engine.js";
import { PassThrough } from "node:stream";
import {
  adapterLabel, adapterProblem, chatCompletions, hiddenPrompt, Interrupted, keyFromEnv, keyHeader, keyVarOf, nodeTooOld, providerByShape, targetOrigin, words,
} from "../src/practice/preflight.js";
import { finalText } from "../src/practice/run.js";
import { clean, copy, hideSecret, parseRequire, results, type Report } from "../src/practice/text.js";
import { practice } from "../src/practice/index.js";
import { fixture, startStub, type Stub } from "./stub.js";

describe("preflight", () => {
  it("targets production unless --url is WhiteRoom's own (https) or loopback; other https hosts only with WHITEROOM_PRACTICE_DEV=1", () => {
    assert.equal(targetOrigin(undefined, {}), "https://proxy.whiteroom.tech");
    assert.equal(targetOrigin("https://staging.whiteroom.tech/x", {}), "https://staging.whiteroom.tech");
    assert.equal(targetOrigin("https://whiteroom.tech", {}), "https://whiteroom.tech");
    assert.equal(targetOrigin("http://localhost:8080", {}), "http://localhost:8080");
    assert.equal(targetOrigin("http://127.0.0.1:3000", {}), "http://127.0.0.1:3000");
    assert.equal(targetOrigin("https://localhost:8443", {}), "https://localhost:8443");
    for (const bad of ["https://staging.example.com", "https://whiteroom.tech.evil.com", "https://evilwhiteroom.tech", "http://staging.whiteroom.tech", "http://example.com",
      "ftp://x", "not a url", "https://user:pass@staging.whiteroom.tech", "http://localhost.evil.com"]) assert.equal(targetOrigin(bad, {}), null, bad);
    assert.equal(targetOrigin("https://engine-test.example.com", { WHITEROOM_PRACTICE_DEV: "1" }), "https://engine-test.example.com");
    assert.equal(targetOrigin("http://engine-test.example.com", { WHITEROOM_PRACTICE_DEV: "1" }), null);
  });

  it("splits adapter commands like a shell for words and quotes", () => {
    assert.deepEqual(words(`python3 "my agent.py" --name 'a b' x\\ y`), ["python3", "my agent.py", "--name", "a b", "x y"]);
  });

  it("finds the adapter's program on PATH and its script files", () => {
    assert.equal(adapterProblem("node starters/wr-adapter.mjs"), null);
    assert.equal(adapterProblem("FOO=1 node starters/wr-adapter.mjs --flag"), null);
    assert.equal(adapterProblem("nope-wr-xyz"), "nope-wr-xyz isn't on your PATH");
    assert.equal(adapterProblem("node gone.mjs"), "gone.mjs doesn't exist");
    assert.equal(adapterProblem("./starters/wr_adapter.py"), "./starters/wr_adapter.py isn't a file you can run");
    assert.equal(adapterProblem("  "), "the command is empty");
    // Left to the shell: operators, builtins, and URLs or plain paths that aren't script files.
    for (const ok of ["cd agent && node wr-adapter.mjs", "source .venv/bin/activate; python3 x.py", "node a.mjs 2>/dev/null | tee log",
      "node starters/wr-adapter.mjs --endpoint http://localhost:8080", "node starters/wr-adapter.mjs --out /tmp/nowhere/x"]) {
      assert.equal(adapterProblem(ok), null, ok);
    }
  });

  it("reads the key from the one provider variable that is set, and names them all when several are", () => {
    assert.deepEqual(keyFromEnv({ OPENAI_API_KEY: "sk-abc12345" }), { from: "OPENAI_API_KEY", key: "sk-abc12345" });
    for (const v of ["AZURE_OPENAI_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"]) {
      assert.deepEqual(keyFromEnv({ [v]: " cloud-key-1234 " }), { from: v, key: "cloud-key-1234" });
    }
    assert.equal(keyFromEnv({ ANTHROPIC_API_KEY: "  " }), null);
    assert.deepEqual(keyFromEnv({ ANTHROPIC_API_KEY: "sk-ant-a", OPENAI_API_KEY: "sk-b" }), ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    assert.deepEqual(keyFromEnv({ ANTHROPIC_API_KEY: "sk-ant-a", AZURE_OPENAI_API_KEY: "az" }), ["ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY"]);
    // --key-env: only that variable, whatever else is set.
    assert.deepEqual(keyFromEnv({ ANTHROPIC_API_KEY: "sk-ant-a", OPENAI_API_KEY: "sk-b" }, "OPENAI_API_KEY"), { from: "OPENAI_API_KEY", key: "sk-b" });
    assert.equal(keyFromEnv({ ANTHROPIC_API_KEY: "sk-ant-a" }, "OPENAI_API_KEY"), null);
    // A wrong direct key names its variable by the key's shape (the engine names a provider only for a Fleet key key).
    assert.equal(providerByShape("sk-ant-abc"), "anthropic");
    assert.equal(providerByShape("sk-proj-abc"), "openai");
  });

  it("a pasted key that doesn't match says it was the pasted one, with its last four (never the key)", () => {
    const key = "sk-ant-placeholder-pasted-key-4f2a";
    assert.equal(copy.providerKeyMismatch(null, key, "Azure OpenAI", "a1b2"),
      "The key you pasted (ends 4f2a) isn't the Azure OpenAI key saved on Fleet key (key ending a1b2). Nothing was charged. If you've changed keys, add the new one on Fleet key, then start a new test in the dashboard and pick that key.");
    assert.match(copy.keyMismatch(keyVarOf(providerByShape(key)), 3, null), /with this fleet\. .*\(3 more tries\)\. Set ANTHROPIC_API_KEY to the right key/);
    assert.ok(!copy.providerKeyMismatch(null, key, "Azure OpenAI", null).includes(key));
  });

  it("the started line counts practice tasks apart from the control checks, as the dashboard does", () => {
    const keep = " Keep this terminal open and your computer awake.";
    assert.equal(copy.started(5, 1, true), `Practice test started: 5 practice tasks and a check of your controls.${keep}`);
    assert.equal(copy.started(15, 3, true), `Practice test started: 3 runs, each 5 practice tasks and a check of your controls.${keep}`);
    // No control check makes calls (no rules, or all Off): only the practice tasks.
    assert.equal(copy.started(5, 1, false), `Practice test started: 5 practice tasks.${keep}`);
    assert.equal(copy.started(0, 1, true), `Practice test started: a check of your controls.${keep}`);
  });

  it("each provider's key variable, header and API (§17)", () => {
    assert.deepEqual(["anthropic", "openai", "azure-openai", "foundry", "bedrock-mantle"].map(keyVarOf),
      ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"]);
    assert.deepEqual(keyHeader("azure-openai", "k"), { "api-key": "k" });
    assert.deepEqual(keyHeader("bedrock-mantle", "k"), { authorization: "Bearer k" });
    assert.deepEqual(keyHeader("openai", "k"), { authorization: "Bearer k" });
    assert.deepEqual(keyHeader("foundry", "k"), { "x-api-key": "k" });
    assert.deepEqual(keyHeader("anthropic", "k"), { "x-api-key": "k" });
    assert.deepEqual((["anthropic", "openai", "azure-openai", "foundry", "bedrock-mantle"] as const).filter(chatCompletions), ["openai", "azure-openai"]);
  });

  it("the hidden prompt: backspace, bracketed paste, raw mode restored; Ctrl+C interrupts", async () => {
    const term = () => {
      const t = Object.assign(new PassThrough(), { raw: [] as boolean[] });
      return Object.assign(t, { setRawMode: (on: boolean) => (t.raw.push(on), t) }) as unknown as NodeJS.ReadStream & { raw: boolean[] };
    };
    const esc = String.fromCharCode(27);
    let t = term();
    let p = hiddenPrompt("", t);
    t.write(`wrrt_x${String.fromCharCode(127)}y${esc}[200~-pasted${esc}[201~\r`);
    assert.equal(await p, "wrrt_y-pasted");
    assert.deepEqual(t.raw, [true, false]);
    // A paste whose markers arrive split across reads.
    for (const chunks of [[`${esc}[200`, `~wrrt_z${esc}[201~\r`], [esc, `[200~wrrt_z${esc}[201`, "~", "\r"]]) {
      t = term();
      p = hiddenPrompt("", t);
      for (const c of chunks) t.write(c);
      assert.equal(await p, "wrrt_z");
    }
    t = term();
    p = hiddenPrompt("", t);
    t.write(String.fromCharCode(3));
    await assert.rejects(p, Interrupted);
    assert.deepEqual(t.raw, [true, false]);
  });

  it("needs Node 20", () => {
    assert.equal(nodeTooOld("18.17.0"), "Needs Node 20 or later (you have 18.17.0).");
    assert.equal(nodeTooOld("20.0.0"), null);
  });
});

describe("the adapter's environment", () => {
  it("drops WHITEROOM_* and other provider keys, and adds only the key in use (a prompted key too)", () => {
    const env = childEnv({ PATH: "/bin", WHITEROOM_API_KEY: "wr_x", whiteroom_url: "u", OPENAI_API_KEY: "sk-old", HOME: "/h" }, "ANTHROPIC_API_KEY", "sk-ant-pasted");
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-ant-pasted" });
    const cloud = childEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x", AZURE_OPENAI_API_KEY: "az", ANTHROPIC_FOUNDRY_API_KEY: "f" }, "AWS_BEARER_TOKEN_BEDROCK", "long-term");
    assert.deepEqual(cloud, { PATH: "/bin", AWS_BEARER_TOKEN_BEDROCK: "long-term" });
  });
});

describe("the adapter driver", () => {
  const base = { env: process.env, message: { type: "task" }, deadline: Date.now() + 30_000, signal: new AbortController().signal };

  it(`stops an adapter after ${MAX_TOOL_CALLS} tool calls`, async () => {
    const calls: ToolCall[] = [];
    const out = await runAdapter({
      ...base,
      launch: { file: process.execPath, args: ["-e", `let n = 0; process.stdin.on("data", () => {}); setInterval(() => console.log(JSON.stringify({ type: "tool_call", id: "c" + ++n, name: "list_tickets", input: {} })), 1);`] },
      tool: async (c) => (calls.push(c), { result: {} }),
    });
    assert.deepEqual(out, { kind: "broke", why: "made more than 200 tool calls in one practice task" });
    assert.equal(calls.length, MAX_TOOL_CALLS);
  });

  it("refuses a tool call over 64 KiB and unknown message types", async () => {
    const send = (msg: string) => runAdapter({ ...base, launch: { file: process.execPath, args: ["-e", `console.log(${JSON.stringify(msg)}); setInterval(() => {}, 1000);`] }, tool: async () => ({ result: {} }) });
    assert.equal((await send(JSON.stringify({ type: "tool_call", id: "c", name: "x", input: "y".repeat(70_000) })) as any).why, "sent a tool call bigger than 64 KiB");
    assert.equal((await send(JSON.stringify({ type: "hello" })) as any).why, "sent a message the CLI doesn't know");
  });
});

describe("what gets printed", () => {
  it("strips control and bidi characters and hides known secrets", () => {
    hideSecret("sk-ant-secret-value-1234");
    const esc = String.fromCharCode(27);
    const rlo = String.fromCharCode(0x202e);
    assert.equal(clean(`a${esc}[2Jb${rlo}c\tkey sk-ant-secret-value-1234 end`), "a[2Jbc\tkey [hidden] end");
  });

  it("reports only the adapter's program and script names to WhiteRoom", () => {
    assert.equal(adapterLabel("API_TOKEN=s3cret python3 /home/me/bots/wr_adapter.py --token sk-abc --db postgres://u:pw@h/x"), "python3 wr_adapter.py");
    assert.equal(adapterLabel("/usr/local/bin/node --env-file .env task-runner.mjs"), "node task-runner.mjs");
    assert.equal(adapterLabel("./run-agent --key abc"), "run-agent");
    assert.equal(adapterLabel("FOO=1"), "adapter");
  });

  it("uses no internal words in practice copy (§2 rule 7)", () => {
    const all = JSON.stringify(Object.values(copy).map((v) => (typeof v === "function" ? String(v) : v)));
    assert.doesNotMatch(all, /handover|shift|watch|context|compress|readiness|attempt|probe|evidence/i);
  });
});

describe("results (§8)", () => {
  const report = () => structuredClone((fixture("tasks.next.done").response as { report: Report }).report);

  it("Passed: all required checks, runs, disclaimer, dashboard; exit 0", () => {
    const r = results(report());
    assert.equal(r.code, 0);
    assert.equal(r.lines[1], "Passed · all 12 checks · 3 runs");
    // Engine E1: the spend cap is checked now, with a tiny limit.
    assert.ok(r.lines.includes("  Passed: Spend cap · Enforce (Your cap works. Tested with a tiny limit: the call after it was blocked.)"));
    assert.match(r.lines.at(-1)!, /app\.whiteroom\.tech\/sandbox.*Past tests/);
  });

  it("Didn't pass: the failing check and its fix line; exit 1; Rerun failed checks", () => {
    const rep = report();
    Object.assign(rep.checks[0], { status: "failed", fix: "Your agent saved the same record more than once." });
    rep.verdict = "not_passed";
    const r = results(rep);
    assert.equal(r.code, 1);
    assert.equal(r.lines[1], "Didn't pass · 1 check failed");
    assert.ok(r.lines.includes("  Finishes a job correctly: Your agent saved the same record more than once."));
    assert.match(r.lines.at(-1)!, /click Rerun failed checks\.$/);
  });

  it("Didn't finish: '(not your agent)' only when every cause is a test problem; exit 3", () => {
    const rep = report();
    rep.verdict = "incomplete";
    Object.assign(rep.checks[1], { status: "error", testProblem: true, fix: "Test problem." });
    Object.assign(rep.checks[2], { status: "error", testProblem: true });
    let r = results(rep);
    assert.equal(r.code, 3);
    assert.equal(r.lines[1], "Didn't finish · 2 checks couldn't run (not your agent)");
    assert.ok(r.lines.includes("What stopped the test"));
    assert.match(r.lines.at(-1)!, /click Rerun checks that didn't run\.$/);
    Object.assign(rep.checks[2], { status: "not_tested", testProblem: false });
    r = results(rep);
    assert.equal(r.lines[1], "Didn't finish · 2 checks couldn't run");
    assert.equal(results({ ...rep, checks: [] }).lines[1], "Didn't finish · no checks could run");
  });

  it("a rerun names its scope; a 1-run or sample pass says what it doesn't prove", () => {
    const rep = report();
    rep.scope = ["c.timeout", "c.keeps_failing"];
    rep.checks = rep.checks.filter((c) => c.id.startsWith("c."));
    assert.equal(results(rep).lines[1], "Passed · Handles a failing tool only · 3 runs");
    rep.runs = 1;
    assert.match(results(rep).lines.join("\n"), /Run it 3 times/);
    rep.sample = true;
    assert.match(results(rep).lines.join("\n"), /sample agent/);
  });
});

describe("--require (pre-flight D6)", () => {
  const report = () => structuredClone((fixture("tasks.next.done").response as { report: Report }).report);
  const ctl = (rep: Report, prefix: string) => rep.checks.find((c) => c.id.startsWith(prefix))!;

  it("takes the catalog's row ids, and refuses unknown ones", () => {
    assert.deepEqual(parseRequire("spend_cap, keyword,spend_cap"), ["spend_cap", "keyword"]);
    const bad = parseRequire("spend_cap,budget");
    assert.ok(!Array.isArray(bad) && /Unknown check for --require: budget\. Use any of: finishes_job, long_task, fails_gracefully, spend_cap, loop_breaker, keyword, pause_stop\./.test(bad.problem));
    assert.ok(!Array.isArray(parseRequire(" , ")));
  });

  it("exits 2 on an unknown id before anything runs", async () => {
    const errs: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (errs.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      assert.equal(await practice(["run", "--require", "nope"]), 2);
    } finally {
      process.stderr.write = write;
    }
    assert.match(errs.join(""), /Unknown check for --require: nope/);
  });

  it("a required row Passed in Enforce keeps exit 0", () => {
    const r = results(report(), ["finishes_job", "spend_cap", "pause_stop"]);
    assert.equal(r.code, 0);
    assert.ok(!r.lines.some((l) => l.includes("--require")));
  });

  it("Watch, Not checked and Not set up all exit 1, each named", () => {
    // The fixture's call rate is in Watch: the loop breaker row passed, but not in Enforce.
    let r = results(report(), ["loop_breaker"]);
    assert.equal(r.code, 1);
    assert.ok(r.lines.includes("Required checks (--require) that didn't pass"));
    assert.ok(r.lines.includes("  Loop breaker + call rate: Passed in Watch, not Enforce"));
    // The fixture's model allowlist passed in Enforce; without it the row has no rule: Not set up.
    assert.equal(results(report(), ["keyword"]).code, 0);
    const rep = report();
    rep.checks = rep.checks.filter((c) => !c.id.startsWith("ctl.model_allowlist"));
    assert.ok(results(rep, ["keyword"]).lines.includes("  Allowlists + keywords: Not set up"));
    // A rule that doesn't cover the agent under test is Not set up for it.
    Object.assign(ctl(rep, "ctl.spend_cap"), { status: "unsupported", required: false, setup: "not_set_up", notCoveredAgent: "support-bot" });
    assert.ok(results(rep, ["spend_cap"]).lines.includes("  Spend cap: Not set up"));
    // Couldn't be checked: Not checked.
    Object.assign(ctl(rep, "ctl.spend_cap"), { status: "unsupported", setup: "ok", notCoveredAgent: undefined });
    assert.ok(results(rep, ["spend_cap"]).lines.includes("  Spend cap: Not checked"));
    // A rerun's rows outside it weren't checked.
    const one = report();
    one.scope = ["c.timeout"];
    one.checks = one.checks.filter((c) => c.id === "c.timeout");
    assert.ok(results(one, ["finishes_job"]).lines.includes("  Finishes the job correctly: Not checked"));
  });

  it("keeps Didn't pass and Didn't finish as they are, naming the failed row", () => {
    const rep = report();
    Object.assign(rep.checks.find((c) => c.id === "c.timeout")!, { status: "failed" });
    rep.verdict = "not_passed";
    const r = results(rep, ["fails_gracefully"]);
    assert.equal(r.code, 1);
    assert.ok(r.lines.includes("  Fails gracefully: Didn't pass"));
    rep.verdict = "incomplete";
    assert.equal(results(rep, ["fails_gracefully"]).code, 3);
  });
});

describe("the final answer sent to WhiteRoom", () => {
  it("fits 32 Ki characters and the body limit, multi-byte text included", () => {
    assert.equal(finalText("a".repeat(40_000)).length, 32 * 1024);
    const wide = finalText(String.fromCodePoint(0x1f600).repeat(20_000));
    assert.ok(Buffer.byteLength(wide) <= 60_000 && wide.length > 0);
    assert.equal(finalText("short"), "short");
  });
});

describe("fleet commands' arguments (unchanged)", () => {
  it("every --name takes the next word, whatever it looks like", () => {
    assert.deepEqual(parseArgs(["health", "--verbose", "foo"]), { args: ["health"], flags: { verbose: "foo" } });
    assert.deepEqual(parseArgs(["task", "a1", "t", "--minutes", "-5"]), { args: ["task", "a1", "t"], flags: { minutes: "-5" } });
    assert.deepEqual(parseArgs(["task", "a1", "--minutes=5", "x"]), { args: ["task", "a1"], flags: { "minutes=5": "x" } });
    assert.deepEqual(parseArgs(["--help"]), { args: ["--help"], flags: {} });
  });
});

describe("Engine.post", () => {
  const stubs: Stub[] = [];
  const stub = async (route: Parameters<typeof startStub>[0]["route"]) => {
    const s = await startStub({ route });
    stubs.push(s);
    return s;
  };
  after(() => Promise.all(stubs.map((s) => s.close())));
  const ok = [200, { lifecycle: "active" }] as [number, unknown];

  it("waits as Retry-After says on a 503 and on a 429 that isn't an answer, then retries", async () => {
    for (const first of [[503, {}, { "retry-after": "1" }], [429, { error: "Rate limit exceeded." }, { "retry-after": "1" }]] as const) {
      const s = await stub((_p, _b, n) => (n === 1 ? [first[0], first[1], { ...first[2] }] : ok));
      const t0 = Date.now();
      const r = await new Engine(s.url).post("/api/readiness/heartbeat", {});
      assert.equal(r.status, 200);
      assert.ok(Date.now() - t0 >= 900, `waited ${Date.now() - t0} ms`);
      assert.equal(s.count("/api/readiness/heartbeat"), 2);
    }
  });

  it("returns a 429 that is an answer at once", async () => {
    const s = await stub(() => [429, { lifecycle: "active", reason: "tool_limit" }]);
    assert.equal((await new Engine(s.url).post("/api/readiness/tools", {})).status, 429);
    assert.equal(s.count("/api/readiness/tools"), 1);
  });

  it("gives up with Unreachable after the offline window; a request that isn't safe to repeat is never resent", async () => {
    await assert.rejects(new Engine("http://127.0.0.1:9", 300).post("/api/readiness/tasks/next", {}, { retryNetwork: true }), Unreachable);
    const s = await stub(() => [500, { error: "boom" }]);
    await assert.rejects(new Engine(s.url, 300).post("/api/readiness/tools", {}), Unreachable);
    assert.equal(s.count("/api/readiness/tools"), 1);
    await assert.rejects(new Engine(s.url, 300).post("/api/readiness/tasks/next", {}, { retryNetwork: true }), Unreachable);
    assert.ok(s.count("/api/readiness/tasks/next") >= 2);
  });

  it("a server that stalls mid-body times out like one that never answers", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"lifecycle":');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await assert.rejects(new Engine(url, 300, 200).post("/api/readiness/tools", {}), Unreachable);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("never follows a redirect: nothing reaches the other host", async () => {
    const other = await stub(() => ok);
    const s = await stub((p) => [307, {}, { location: `${other.url}${p}` }]);
    const r = await new Engine(s.url).post("/api/readiness/claim", { key: "sk-ant-placeholder" });
    assert.equal(r.status, REDIRECTED);
    assert.equal(other.seen.length, 0);
  });
});
