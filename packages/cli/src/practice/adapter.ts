// Runs one practice task through the adapter (spec §5 Agents, §9.4): one
// child per task in its own process group, NDJSON over stdin/stdout, the
// provider key in its environment and nothing of WhiteRoom's. Stderr is
// passed through; stdout that isn't JSON is shown here and never uploaded.

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { clean, say } from "./text.js";

export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_TOOL_CALLS = 200;
/** A tool call's request to WhiteRoom must fit its 64 KiB body limit. */
export const MAX_TOOL_BODY_BYTES = 64 * 1024;
/** After SIGTERM, how long the group has before SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/** How to start the adapter: the user's own command through a shell, or the sample agent. */
export type Launch = { shell: string } | { file: string; args: string[] };

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** How a practice task's adapter run ended. */
export type Outcome =
  | { kind: "final"; output: string }
  | { kind: "exited"; how: string; tail: string[] }
  | { kind: "broke"; why: string }
  | { kind: "deadline" }
  | { kind: "stopped" }
  /** The CLI's tool callback ended the task (restart, deadline, session over). */
  | { kind: "ended"; by: unknown };

export type ToolAnswer = { result: unknown } | { end: unknown };

/** The adapter's environment: the CLI's, minus WhiteRoom's settings, with only the provider key added. */
export function childEnv(parent: NodeJS.ProcessEnv, keyVar: string, key: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (!/^WHITEROOM_/i.test(k) && k !== "ANTHROPIC_API_KEY" && k !== "OPENAI_API_KEY") env[k] = v;
  }
  env[keyVar] = key;
  return env;
}

const live = new Set<ChildProcess>();
const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
const signalGroup = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pid, sig);
  } catch {
    // Already gone.
  }
};

/** SIGTERM to the adapter's whole process group, then SIGKILL if anything is left after KILL_GRACE_MS. */
export async function killGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  signalGroup(pid, "SIGTERM");
  const until = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
  live.delete(child);
}

// Whatever happens to the CLI, no adapter outlives it.
process.on("exit", () => {
  for (const c of live) if (c.pid) signalGroup(c.pid, "SIGKILL");
});

/** Calls `onLine` per line; a line over MAX_LINE_BYTES calls `onTooLong` instead and drops the rest of the stream. */
function readLines(stream: Readable, onLine: (l: string) => void, onTooLong: () => void): void {
  let buf = "";
  let over = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (over) return;
    buf += chunk;
    const tooLong = () => {
      over = true;
      buf = "";
      onTooLong();
    };
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return tooLong();
      onLine(line);
    }
    if (Buffer.byteLength(buf) > MAX_LINE_BYTES) tooLong();
  });
  stream.on("end", () => {
    if (buf && !over) onLine(buf);
  });
}

export interface RunOptions {
  launch: Launch;
  env: NodeJS.ProcessEnv;
  /** The first line the adapter reads. */
  message: unknown;
  deadline: number;
  signal: AbortSignal;
  tool: (call: ToolCall) => Promise<ToolAnswer>;
}

export function runAdapter(o: RunOptions): Promise<Outcome> {
  const child = "shell" in o.launch
    ? spawn(o.launch.shell, { shell: true, detached: true, stdio: ["pipe", "pipe", "pipe"], env: o.env })
    : spawn(o.launch.file, o.launch.args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: o.env });
  live.add(child);
  const tail: string[] = [];
  let toolCalls = 0;
  let settled = false;
  // Lines are handled one at a time, in order: a tool call finishes before the next line is read.
  let chain: Promise<void> = Promise.resolve();

  return new Promise<Outcome>((resolve) => {
    const finish = (out: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onAbort);
      void killGroup(child).then(() => resolve(out));
    };
    const onAbort = () => finish({ kind: "stopped" });
    const timer = setTimeout(() => finish({ kind: "deadline" }), Math.max(0, o.deadline - Date.now()));
    o.signal.addEventListener("abort", onAbort, { once: true });
    if (o.signal.aborted) onAbort();

    const write = (msg: unknown) => {
      if (!settled) child.stdin!.write(JSON.stringify(msg) + "\n");
    };
    child.stdin!.on("error", () => {}); // The adapter closed stdin: its exit is reported below.
    child.on("error", (err) => finish({ kind: "exited", how: err.message, tail }));

    const handle = async (line: string) => {
      if (settled || !line.trim()) return;
      let msg: { type?: unknown; id?: unknown; name?: unknown; input?: unknown; output?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        say(`  adapter: ${line}`);
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return say(`  adapter: ${line}`);
      if (msg.type === "final") {
        return finish({ kind: "final", output: typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output ?? null) });
      }
      if (msg.type !== "tool_call") return finish({ kind: "broke", why: "sent a message the CLI doesn't know" });
      const { id, name, input } = msg;
      if (typeof id !== "string" || !id || id.length > 128 || typeof name !== "string" || !name || name.length > 64) {
        return finish({ kind: "broke", why: "sent a tool call without a valid id and name" });
      }
      if (++toolCalls > MAX_TOOL_CALLS) return finish({ kind: "broke", why: `made more than ${MAX_TOOL_CALLS} tool calls in one practice task` });
      if (Buffer.byteLength(JSON.stringify(input ?? null)) > MAX_TOOL_BODY_BYTES - 512) {
        return finish({ kind: "broke", why: "sent a tool call bigger than 64 KiB" });
      }
      const answer = await o.tool({ id, name, input: input ?? null });
      if ("end" in answer) return finish({ kind: "ended", by: answer.end });
      write({ type: "tool_result", id, result: answer.result });
    };
    readLines(child.stdout!, (l) => { chain = chain.then(() => handle(l)).then(() => {}); }, () => finish({ kind: "broke", why: "sent a line longer than 1 MiB" }));
    readLines(child.stderr!, (l) => {
      process.stderr.write(clean(l) + "\n");
      tail.push(clean(l).slice(0, 500));
      if (tail.length > 5) tail.shift();
    }, () => {});
    child.on("close", (code, sig) => {
      chain = chain.then(() => finish({ kind: "exited", how: sig ? `stopped by ${sig}` : `exit code ${code}`, tail }));
    });
    write(o.message);
  });
}
