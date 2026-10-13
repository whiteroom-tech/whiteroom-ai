// The practice commands' pure parts: preflight, the child environment, the
// adapter driver's caps, what gets printed, and the results screen.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childEnv, MAX_TOOL_CALLS, runAdapter, type ToolCall } from "../src/practice/adapter.js";
import { adapterProblem, keyFromEnv, keyFromPaste, nodeTooOld, targetOrigin, words } from "../src/practice/preflight.js";
import { clean, copy, hideSecret, results, type Report } from "../src/practice/text.js";
import { fixture } from "./stub.js";

describe("preflight", () => {
  it("targets production unless --url is https or loopback", () => {
    assert.equal(targetOrigin(undefined), "https://proxy.whiteroom.tech");
    assert.equal(targetOrigin("https://staging.example.com/x"), "https://staging.example.com");
    assert.equal(targetOrigin("http://localhost:8080"), "http://localhost:8080");
    assert.equal(targetOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
    for (const bad of ["http://example.com", "ftp://x", "not a url", "https://user:pass@example.com", "http://localhost.evil.com"]) assert.equal(targetOrigin(bad), null, bad);
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
  });

  it("reads the key from the environment, or by its shape when pasted", () => {
    assert.deepEqual(keyFromEnv({ OPENAI_API_KEY: "sk-abc12345" }), { keyVar: "OPENAI_API_KEY", key: "sk-abc12345", fromEnv: true });
    assert.equal(keyFromEnv({ ANTHROPIC_API_KEY: "  " }), null);
    assert.equal(keyFromPaste("sk-ant-abc").keyVar, "ANTHROPIC_API_KEY");
    assert.equal(keyFromPaste("sk-proj-abc").keyVar, "OPENAI_API_KEY");
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

  it("reports the adapter command to WhiteRoom without anything that looks like a secret", () => {
    assert.equal(copy.adapterLabel("python3 wr_adapter.py --token sk-live-abc123 --db postgres://u:pw@h/x"), "python3 wr_adapter.py --token [hidden] --db [hidden]h/x");
    assert.equal(copy.adapterLabel("node task-runner.mjs"), "node task-runner.mjs");
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
    assert.equal(r.lines[1], "Passed · all 11 checks · 3 runs");
    assert.ok(r.lines.includes("  Spend cap · Enforce: Not checked: it would need real spending."));
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
