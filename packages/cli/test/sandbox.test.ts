// `whiteroom sandbox listen` end to end: the CLI (from source) against a stub
// of the engine's /api/sandbox-helper routes and a fake model on the Sandbox
// key's URL. Placeholders only (public repo).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { findSandboxUrl, helperEnv, helperHost, taskResult } from "../src/sandbox/listen.js";
import { KEY, PKG, testEnv, waitFor } from "./stub.js";

const HELPER_CODE = `wrhc_${"H".repeat(43)}`;
const HELPER_SESSION = `wrhs_${"S".repeat(43)}`;
/** The Sandbox key in the agent's base URL (placeholder). */
const SANDBOX_KEY = `sk-wr-${"a".repeat(40)}`;

const dir = mkdtempSync(join(tmpdir(), "wr-cli-sandbox-"));
const script = (name: string, code: string) => {
  const p = join(dir, name);
  writeFileSync(p, code);
  return p;
};

/** An adapter that records the task line and its environment, makes one model call to base_url, and answers with the model's text. */
const RECORD = join(dir, "seen.jsonl");
const ADAPTER = script("adapter.mjs", `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const msg = JSON.parse(line);
  appendFileSync(${JSON.stringify(RECORD)}, JSON.stringify({ msg, env: Object.keys(process.env).filter((k) => /^WHITEROOM_|_API_KEY$|_BASE_URL$/.test(k)) }) + "\\n");
  const res = await fetch(msg.base_url + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY }, body: JSON.stringify({ model: "m", max_tokens: 10, messages: [{ role: "user", content: msg.task }] }) });
  const body = await res.json();
  console.error("adapter log: key " + process.env.ANTHROPIC_API_KEY);
  process.stdout.write(JSON.stringify({ type: "final", output: body.content?.[0]?.text ?? "HTTP " + res.status }) + "\\n");
  break;
}
`);
const CRASH = script("crash.mjs", `process.stdin.once("data", () => { console.error("boom"); process.exit(4); });`);

interface Stub {
  url: string;
  claims: any[];
  results: any[];
  modelCalls: Array<{ path: string; key: string | undefined }>;
  disconnects: number;
  heartbeats: number;
  close: () => Promise<void>;
}

/**
 * The engine's helper routes: claim checks the code and key prefix; `next`
 * hands out `tasks` in order (each once, unless `redeliver`), then answers idle
 * or (`endAfter`) the session's end.
 */
async function startStub(o: { tasks?: string[]; endAfter?: string; provider?: string; claim?: [number, unknown]; proxyUrl?: string; redeliver?: boolean } = {}): Promise<Stub> {
  const queue = [...(o.tasks ?? [])];
  const s = { claims: [] as any[], results: [] as any[], modelCalls: [] as Stub["modelCalls"], disconnects: 0, heartbeats: 0 };
  let origin = "";
  let n = 0;
  let last: any = null;
  const reply = (req: IncomingMessage, path: string, body: any): [number, unknown] => {
    if (path === "/api/sandbox-helper/claim") {
      s.claims.push(body);
      if (o.claim) return o.claim;
      if (body.code !== HELPER_CODE) return [410, { reason: "code_invalid" }];
      if (body.keyPrefix !== SANDBOX_KEY.slice(0, 22)) return [401, { reason: "key_mismatch", triesLeft: 3 }];
      return [200, { session: HELPER_SESSION, sandboxFleetId: "sandbox-placeholder", proxyUrl: o.proxyUrl ?? origin, provider: o.provider ?? "anthropic" }];
    }
    if (path.startsWith("/api/sandbox-helper/")) {
      if (req.headers.authorization !== `Bearer ${HELPER_SESSION}`) return [401, { reason: "session_lost" }];
      if (path.endsWith("/next")) {
        if (o.redeliver && last && s.results.length === 1 && n === 1) return n++, [200, { task: last }];
        const prompt = queue.shift();
        if (prompt !== undefined) return (last = { taskId: `ht-${++n}`, kind: "prompt", prompt }), [200, { task: last }];
        if (o.endAfter) return [401, { reason: o.endAfter }];
        return [200, { idle: true }];
      }
      if (path.endsWith("/result")) return s.results.push(body), [200, { recorded: true, duplicate: false }];
      if (path.endsWith("/heartbeat")) return s.heartbeats++, [200, { ok: true }];
      if (path.endsWith("/disconnect")) return s.disconnects++, [200, { connected: false }];
    }
    if (path === `/${SANDBOX_KEY}/v1/messages`) {
      s.modelCalls.push({ path, key: req.headers["x-api-key"] as string | undefined });
      return [200, { content: [{ type: "text", text: `Sandbox says: ${body.messages[0].content}` }] }];
    }
    return [404, { error: "Not found." }];
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0];
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* a bad body */ }
      const [status, json] = reply(req, path, body);
      // An idle long-poll answers after a short wait, as the engine's would after 25 s.
      const wait = path.endsWith("/next") && (json as any)?.idle ? 100 : 0;
      setTimeout(() => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      }, wait);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(s, { url: origin, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
}

const stubs: Stub[] = [];
const stub = async (...a: Parameters<typeof startStub>) => {
  const st = await startStub(...a);
  stubs.push(st);
  return st;
};
after(() => Promise.all(stubs.map((x) => x.close())));

/** Runs `whiteroom sandbox listen` from source with the code on stdin; `during` gets the child once it has started. */
function listen(st: Stub | null, o: { adapter?: string; env?: NodeJS.ProcessEnv; stdin?: string; extra?: string[]; during?: (pid: number, out: () => string) => void } = {}) {
  const args = ["sandbox", "listen", "--code-stdin", ...(st ? ["--url", st.url] : []), "--adapter", o.adapter ?? `node ${ADAPTER}`, ...(o.extra ?? [])];
  const env = o.env ?? testEnv({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `${st?.url ?? "http://127.0.0.1:1"}/${SANDBOX_KEY}` });
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], { cwd: PKG, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(o.stdin ?? `${HELPER_CODE}\n`);
  o.during?.(child.pid!, () => stdout + stderr);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((r) => child.on("close", (code) => r({ code, stdout, stderr })));
}

const noSecrets = (out: string) => {
  for (const secret of [KEY, HELPER_CODE, HELPER_SESSION, SANDBOX_KEY]) assert.ok(!out.includes(secret), `printed a secret: ${secret.slice(0, 8)}…`);
};

describe("sandbox listen", () => {
  it("claims, runs each task through the adapter against the Sandbox URL, posts the result, and exits 3 with plain words when the session ends", async () => {
    writeFileSync(RECORD, "");
    const st = await stub({ tasks: ["Summarize the inbox."], endAfter: "session_lost" });
    const r = await listen(st, { env: testEnv({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `${st.url}/${SANDBOX_KEY}`, WHITEROOM_SANDBOX_NOTE: "not for the adapter" }) });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stdout, /Helper connected · waiting for tasks from the Sandbox page \(Ctrl\+C to stop\)/);
    assert.match(r.stdout, /Task 1: Summarize the inbox\./);
    assert.match(r.stdout, /Task 1 finished\. The result is on the Sandbox page\./);
    assert.match(r.stderr, /session has ended .*click Run agent to get a new code/);
    // The claim sends the code, the key's prefix (never the key) and this computer's name.
    assert.deepEqual(st.claims[0], { code: HELPER_CODE, keyPrefix: SANDBOX_KEY.slice(0, 22), host: helperHost() });
    // The agent's call went to the Sandbox URL with the user's own key.
    assert.deepEqual(st.modelCalls, [{ path: `/${SANDBOX_KEY}/v1/messages`, key: KEY }]);
    assert.deepEqual(st.results, [{ taskId: "ht-1", ok: true, summary: "Sandbox says: Summarize the inbox." }]);
    const seen = JSON.parse(readFileSync(RECORD, "utf8").trim());
    assert.deepEqual(seen.msg, { type: "task", task: "Summarize the inbox.", tools: [], headers: {}, model: null, base_url: `${st.url}/${SANDBOX_KEY}` });
    // No WhiteRoom setting reaches the adapter; the agent's own settings do.
    assert.deepEqual(seen.env.sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    // The adapter's log printed the key: the CLI hides it.
    assert.match(r.stderr, /adapter log: key \[hidden\]/);
    noSecrets(r.stdout + r.stderr);
  });

  it("OpenAI: base_url ends in /v1", async () => {
    writeFileSync(RECORD, "");
    const st = await stub({ tasks: ["hi"], endAfter: "disconnected", provider: "openai" });
    const r = await listen(st);
    assert.equal(r.code, 3, r.stderr);
    assert.equal(JSON.parse(readFileSync(RECORD, "utf8").trim()).msg.base_url, `${st.url}/${SANDBOX_KEY}/v1`);
    assert.match(r.stderr, /disconnected from the Sandbox page/);
  });

  it("a crashed adapter is reported as not ok, and the helper keeps listening", async () => {
    const st = await stub({ tasks: ["a", "b"], endAfter: "replaced" });
    const r = await listen(st, { adapter: `node ${CRASH}` });
    assert.equal(r.code, 3, r.stderr);
    assert.equal(st.results.length, 2);
    assert.equal(st.results[0].ok, false);
    assert.match(st.results[0].summary, /Your adapter exited \(exit code 4\) before finishing\. Last output: boom/);
    assert.match(r.stdout, /Task 2 didn't finish: Your adapter exited/);
    assert.match(r.stderr, /Another helper connected to this Sandbox/);
  });

  it("a task handed out again is not run twice: its result is sent again", async () => {
    writeFileSync(RECORD, "");
    const st = await stub({ tasks: ["once"], endAfter: "session_lost", redeliver: true });
    const r = await listen(st);
    assert.equal(r.code, 3, r.stderr);
    assert.equal(st.results.length, 2);
    assert.deepEqual(st.results[0], st.results[1]);
    assert.equal(st.modelCalls.length, 1);
  });

  it("Ctrl+C disconnects and exits 0", async () => {
    const st = await stub();
    const r = await listen(st, {
      during: (pid, out) => void waitFor(() => /Helper connected/.test(out())).then(() => process.kill(pid, "SIGINT")),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(st.disconnects, 1);
    assert.match(r.stdout, /Helper stopped\. The Sandbox page shows it disconnected\./);
  });

  it("refusals at claim: wrong Sandbox key (tries left), used code, no key connected", async () => {
    const wrongKey = await stub();
    let r = await listen(wrongKey, { env: testEnv({ ANTHROPIC_BASE_URL: `${wrongKey.url}/sk-wr-${"b".repeat(40)}` }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /isn't this Sandbox's current one .*3 tries left/);

    const used = await stub();
    r = await listen(used, { stdin: `wrhc_${"Z".repeat(43)}\n` });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /This helper code doesn't work any more\./);

    const noKey = await stub({ claim: [409, { reason: "not_connected" }] });
    r = await listen(noKey);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Connect a provider key/);
  });

  it("stops if WhiteRoom names another host for the Sandbox", async () => {
    const st = await stub({ tasks: ["x"], proxyUrl: "https://elsewhere.example.test" });
    const r = await listen(st);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /another host/);
    assert.equal(st.modelCalls.length, 0);
    assert.equal(st.disconnects, 1);
  });

  it("sends nothing without a Sandbox URL, with two, with one on another host, or with a malformed code", async () => {
    const st = await stub();
    let r = await listen(st, { env: testEnv({ ANTHROPIC_API_KEY: KEY }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Point your agent at your Sandbox first/);
    r = await listen(st, { env: testEnv({ ANTHROPIC_BASE_URL: `${st.url}/${SANDBOX_KEY}`, OPENAI_BASE_URL: `${st.url}/sk-wr-${"c".repeat(40)}` }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /More than one Sandbox URL is set \(ANTHROPIC_BASE_URL, OPENAI_BASE_URL\)/);
    r = await listen(st, { env: testEnv({ ANTHROPIC_BASE_URL: `https://proxy.whiteroom.tech/${SANDBOX_KEY}` }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Your Sandbox URL is on proxy\.whiteroom\.tech, but the helper connects to 127\.0\.0\.1/);
    r = await listen(st, { stdin: "wrrt_not-a-helper-code\n" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /That isn't a helper code/);
    assert.equal(st.claims.length, 0);
    noSecrets(r.stdout + r.stderr);
  });

  it("usage: --adapter is required; --url must be WhiteRoom's or loopback", async () => {
    let r = await listen(null, { adapter: " " });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--adapter needs the command/);
    r = await listen(null, { extra: ["--url", "https://example.com"] });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--url must be a WhiteRoom address/);
  });
});

describe("sandbox listen units", () => {
  it("findSandboxUrl takes Sandbox URLs only, once per key", () => {
    const env = { A_BASE_URL: `https://proxy.whiteroom.tech/${SANDBOX_KEY}`, B: `https://proxy.whiteroom.tech/${SANDBOX_KEY}/v1`, C: "https://api.anthropic.com", D: `https://proxy.whiteroom.tech/sk-wr-short` };
    assert.deepEqual(findSandboxUrl(env), [{ variable: "A_BASE_URL", origin: "https://proxy.whiteroom.tech", key: SANDBOX_KEY }]);
    assert.deepEqual(findSandboxUrl({ X: `https://user:pw@proxy.whiteroom.tech/${SANDBOX_KEY}` }), []);
  });

  it("helperEnv drops WhiteRoom's settings and keeps the agent's", () => {
    assert.deepEqual(helperEnv({ WHITEROOM_URL: "x", whiteroom_api_key: "y", ANTHROPIC_API_KEY: "k", PATH: "/bin" }), { ANTHROPIC_API_KEY: "k", PATH: "/bin" });
  });

  it("helperHost is safe to show", () => {
    assert.equal(helperHost("Rashad's MacBook\u001b[2J"), "Rashad-s-MacBook--2J");
    assert.equal(helperHost(""), "computer");
    assert.equal(helperHost("x".repeat(100)).length, 64);
  });

  it("taskResult: ok only for a final answer, summaries capped at 2,000", () => {
    assert.deepEqual(taskResult({ kind: "final", output: "y".repeat(3000) }), { ok: true, summary: "y".repeat(2000) });
    assert.equal(taskResult({ kind: "deadline" }).ok, false);
    assert.match(taskResult({ kind: "broke", why: "sent a line longer than 1 MiB" }).summary, /^Your adapter sent a line/);
  });
});
