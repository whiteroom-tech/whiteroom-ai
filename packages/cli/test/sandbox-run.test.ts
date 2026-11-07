// `whiteroom sandbox run`: the CLI (from source) runs a stand-in agent once
// with its base URL set to the Sandbox URL. Placeholders only (public repo).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { run, sandboxSetting, sandboxUrlOf, whiteRoomBaseUrls } from "../src/sandbox/run.js";
import { Interrupted } from "../src/practice/preflight.js";
import { PKG, testEnv } from "./stub.js";

const SANDBOX_KEY = `sk-wr-${"a".repeat(40)}`;
const SANDBOX_URL = `https://proxy.whiteroom.tech/${SANDBOX_KEY}`;

const dir = mkdtempSync(join(tmpdir(), "wr-cli-sandbox-run-"));
/** A stand-in agent: prints the settings it sees and its arguments, then exits with the code it's given. */
const AGENT = join(dir, "agent.mjs");
writeFileSync(AGENT, `
const seen = Object.fromEntries(Object.entries(process.env).filter(([k]) => /_BASE_URL$|_API_BASE$|_ENDPOINT$|^WHITEROOM_/.test(k)));
process.stdout.write(JSON.stringify({ seen, args: process.argv.slice(2) }) + "\\n");
process.exit(Number(process.argv[2] ?? 0));
`);

function cli(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // stdin isn't a terminal here: the URL comes from WHITEROOM_SANDBOX_URL, or the run is refused.
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "sandbox", "run", ...args], { cwd: PKG, env: testEnv(extra), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const seenBy = (stdout: string) => JSON.parse(stdout.trim().split("\n").pop()!) as { seen: Record<string, string>; args: string[] };

describe("sandbox run", () => {
  it("runs the agent once with its base URL set to the Sandbox URL, its arguments as typed, and exits with its code", async () => {
    const r = await cli(["--provider", "anthropic", "--", process.execPath, AGENT, "3", "two words", "--verbose"], { WHITEROOM_SANDBOX_URL: SANDBOX_URL });
    assert.equal(r.code, 3);
    const { seen, args } = seenBy(r.stdout);
    // WHITEROOM_* stays with the CLI: the agent never sees the Sandbox URL under another name.
    assert.deepEqual(seen, { ANTHROPIC_BASE_URL: SANDBOX_URL });
    assert.deepEqual(args, ["3", "two words", "--verbose"]);
    assert.match(r.stdout, /Running your agent with ANTHROPIC_BASE_URL set to your Sandbox URL/);
    // The key is never printed by the CLI itself.
    assert.ok(!r.stderr.includes(SANDBOX_KEY));
  });

  it("OpenAI gets OPENAI_BASE_URL with /v1, Azure OpenAI gets AZURE_OPENAI_ENDPOINT, as the Sandbox page's .env line", async () => {
    const openai = await cli(["--provider", "openai", "--", process.execPath, AGENT], { WHITEROOM_SANDBOX_URL: `${SANDBOX_URL}/v1` });
    assert.equal(openai.code, 0);
    assert.deepEqual(seenBy(openai.stdout).seen, { OPENAI_BASE_URL: `${SANDBOX_URL}/v1`, OPENAI_API_BASE: `${SANDBOX_URL}/v1` });
    const azure = await cli(["--provider", "azure-openai", "--", process.execPath, AGENT], { WHITEROOM_SANDBOX_URL: SANDBOX_URL });
    assert.deepEqual(seenBy(azure.stdout).seen, { AZURE_OPENAI_ENDPOINT: SANDBOX_URL });
    for (const provider of ["foundry", "bedrock-mantle"]) {
      const r = await cli(["--provider", provider, "--", process.execPath, AGENT], { WHITEROOM_SANDBOX_URL: SANDBOX_URL });
      assert.deepEqual(seenBy(r.stdout).seen, { ANTHROPIC_BASE_URL: SANDBOX_URL });
    }
    // An older OPENAI_API_BASE of the user's own is replaced too, so no SDK bypasses the Sandbox.
    const legacy = await cli(["--provider", "openai", "--", process.execPath, AGENT], { WHITEROOM_SANDBOX_URL: SANDBOX_URL, OPENAI_API_BASE: "https://api.openai.com/v1" });
    assert.equal(seenBy(legacy.stdout).seen.OPENAI_API_BASE, `${SANDBOX_URL}/v1`);
  });

  it("refuses, running nothing, when another base URL points at WhiteRoom (production)", async () => {
    const r = await cli(["--provider", "anthropic", "--", process.execPath, AGENT], { WHITEROOM_SANDBOX_URL: SANDBOX_URL, OPENAI_BASE_URL: "https://proxy.whiteroom.tech/v1" });
    assert.equal(r.code, 2);
    assert.equal(r.stdout.includes("seen"), false);
    assert.match(r.stderr, /OPENAI_BASE_URL already points at WhiteRoom, so your agent's calls could go to production/);
    const old = await cli(["--provider", "anthropic", "--", process.execPath, AGENT], { WHITEROOM_SANDBOX_URL: SANDBOX_URL, OPENAI_API_BASE: "https://proxy.whiteroom.tech/v1", AZURE_OPENAI_ENDPOINT: "https://proxy.whiteroom.tech" });
    assert.equal(old.code, 2);
    assert.match(old.stderr, /OPENAI_API_BASE and AZURE_OPENAI_ENDPOINT already point at WhiteRoom/);
    // The one it sets is replaced, not refused: the agent's old WhiteRoom URL is overridden.
    const same = await cli(["--provider", "anthropic", "--", process.execPath, AGENT], { WHITEROOM_SANDBOX_URL: SANDBOX_URL, ANTHROPIC_BASE_URL: "https://proxy.whiteroom.tech" });
    assert.equal(same.code, 0);
    assert.deepEqual(seenBy(same.stdout).seen, { ANTHROPIC_BASE_URL: SANDBOX_URL });
  });

  it("a signal sent to the CLI alone reaches the agent once", async () => {
    const TRAP = join(dir, "trap.mjs");
    writeFileSync(TRAP, `let n = 0; process.on("SIGTERM", () => { n += 1; process.stdout.write("SIGTERM " + n + "\\n"); setTimeout(() => process.exit(5), 100); }); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "sandbox", "run", "--provider", "anthropic", "--", process.execPath, TRAP], { cwd: PKG, env: testEnv({ WHITEROOM_SANDBOX_URL: SANDBOX_URL }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("ready") && !child.killed) child.kill("SIGTERM"); });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 5);
    assert.equal(out.match(/SIGTERM/g)?.length, 1);
  });

  it("in a terminal it asks for the Sandbox URL (the .env line works too); Ctrl+C at the prompt runs nothing and exits 130", async () => {
    const asked: string[] = [];
    const code = await run({ provider: "anthropic", command: [process.execPath, "-e", `process.exit(process.env.ANTHROPIC_BASE_URL === ${JSON.stringify(SANDBOX_URL)} ? 7 : 1)`] }, testEnv(),
      { terminal: true, ask: async (q) => (asked.push(q), `ANTHROPIC_BASE_URL=${SANDBOX_URL}`) });
    assert.equal(code, 7);
    assert.deepEqual(asked, ["Paste your Sandbox URL from the Sandbox page (it won't show): "]);
    const cancelled = await run({ provider: "anthropic", command: ["no-such-agent-command-xyz"] }, testEnv(), { terminal: true, ask: async () => { throw new Interrupted(); } });
    assert.equal(cancelled, 130);
  });

  it("a SIGINT sent to the CLI alone isn't passed on (Ctrl+C reaches the agent from the terminal); SIGTERM is", async () => {
    const TRAP = join(dir, "trap-int.mjs");
    writeFileSync(TRAP, `process.on("SIGINT", () => process.stdout.write("SIGINT\\n")); process.on("SIGTERM", () => { process.stdout.write("SIGTERM\\n"); process.exit(6); }); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "sandbox", "run", "--provider", "anthropic", "--", process.execPath, TRAP], { cwd: PKG, env: testEnv({ WHITEROOM_SANDBOX_URL: SANDBOX_URL }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("ready") && !out.includes("sent")) {
        out += "sent";
        child.kill("SIGINT");
        setTimeout(() => child.kill("SIGTERM"), 300);
      }
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 6);
    assert.equal(out.includes("SIGINT"), false);
    assert.ok(out.includes("SIGTERM"));
  });

  it("an agent ended by a signal exits 128 plus its number, as a shell reports it", async () => {
    const KILLED = join(dir, "killed.mjs");
    writeFileSync(KILLED, `process.kill(process.pid, "SIGKILL");`);
    const r = await cli(["--provider", "anthropic", "--", process.execPath, KILLED], { WHITEROOM_SANDBOX_URL: SANDBOX_URL });
    assert.equal(r.code, 137);
  });

  it("usage and setup problems exit 2 with plain words", async () => {
    const noDash = await cli(["--provider", "anthropic", process.execPath, AGENT]);
    assert.equal(noDash.code, 2);
    assert.match(noDash.stderr, /Put -- before your agent's command/);
    const noProvider = await cli(["--", process.execPath, AGENT], { WHITEROOM_SANDBOX_URL: SANDBOX_URL });
    assert.equal(noProvider.code, 2);
    assert.match(noProvider.stderr, /--provider needs one of: anthropic, openai, azure-openai, foundry, bedrock-mantle/);
    const noCommand = await cli(["--provider", "anthropic", "--"]);
    assert.match(noCommand.stderr, /Put your agent's command after --/);
    const noTerminal = await cli(["--provider", "anthropic", "--", process.execPath, AGENT]);
    assert.equal(noTerminal.code, 2);
    assert.match(noTerminal.stderr, /No terminal to ask for the Sandbox URL\. Set WHITEROOM_SANDBOX_URL/);
    const missing = await cli(["--provider", "anthropic", "--", "no-such-agent-command-xyz"], { WHITEROOM_SANDBOX_URL: SANDBOX_URL });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Couldn't start `no-such-agent-command-xyz`: no such command/);
  });

  it("units: the Sandbox URL is checked, and only whiteroom.tech base URLs count as WhiteRoom", () => {
    assert.deepEqual(sandboxUrlOf(` ${SANDBOX_URL}/ `), { url: SANDBOX_URL });
    assert.deepEqual(sandboxUrlOf(`${SANDBOX_URL}/openai`), { url: SANDBOX_URL });
    // The Sandbox page's .env line, pasted whole.
    assert.deepEqual(sandboxUrlOf(`ANTHROPIC_BASE_URL=${SANDBOX_URL}`), { url: SANDBOX_URL });
    assert.deepEqual(sandboxUrlOf(`export OPENAI_BASE_URL="${SANDBOX_URL}/v1"`), { url: SANDBOX_URL });
    assert.ok("problem" in sandboxUrlOf("https://proxy.whiteroom.tech/sk-wr-short"));
    assert.ok("problem" in sandboxUrlOf(`https://evil.example/${SANDBOX_KEY}`));
    assert.deepEqual(sandboxUrlOf(`http://localhost:8787/${SANDBOX_KEY}`), { url: `http://localhost:8787/${SANDBOX_KEY}` });
    assert.deepEqual(sandboxSetting("foundry", SANDBOX_URL), { name: "ANTHROPIC_BASE_URL", value: SANDBOX_URL });
    assert.deepEqual(sandboxSetting("bedrock-mantle", `${SANDBOX_URL}/`), { name: "ANTHROPIC_BASE_URL", value: SANDBOX_URL });
    // A local proxy of the user's own isn't WhiteRoom.
    assert.deepEqual(whiteRoomBaseUrls({ OPENAI_BASE_URL: "http://localhost:4000", AZURE_OPENAI_ENDPOINT: "https://app.whiteroom.tech/x", ANTHROPIC_BASE_URL: "https://proxy.whiteroom.tech" }, ["ANTHROPIC_BASE_URL"]), ["AZURE_OPENAI_ENDPOINT"]);
  });
});
