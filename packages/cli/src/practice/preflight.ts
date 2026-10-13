// Checks that run before anything is sent (spec §10 CLI, §9.3): the target,
// the adapter command, the provider key and the run code's shape.

import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { copy } from "./text.js";

export const PRODUCTION = "https://proxy.whiteroom.tech";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const RUN_CODE = /^wrrt_[A-Za-z0-9_-]{43}$/;

/** The origin practice commands talk to: production, or `--url` if it is https or loopback. Null if `--url` isn't allowed. */
export function targetOrigin(url: string | undefined): string | null {
  if (url === undefined) return PRODUCTION;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname)) ? u.origin : null;
}

/** Splits a command line into words as a POSIX shell would for plain words and quotes (enough to find files). */
export function words(cmd: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^\s"'\\]|\\.)+)|(\s+)/g;
  let cur: string | null = null;
  for (const m of cmd.matchAll(re)) {
    if (m[4] !== undefined) {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    const part = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3].replace(/\\(.)/g, "$1");
    cur = (cur ?? "") + part;
  }
  if (cur !== null) out.push(cur);
  return out;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isExecutable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return isFile(p);
  } catch {
    return false;
  }
};
const SCRIPT = /\.(m?js|cjs|ts|mts|py|rb|php|pl|sh|jar|exe)$/i;

/** Shell syntax and builtins this check can't follow: the user's shell runs the command, so it isn't second-guessed. */
const SHELL_SYNTAX = /[&|;<>$`(){}*?~\n]/;
const BUILTINS = new Set(["cd", "source", ".", "export", "exec", "eval", "set", "alias", "command", "builtin", "time", "nohup", "env"]);

/**
 * Why `--adapter` can't start, or null: its program is on PATH (or a file), and
 * script files it names (by extension) exist. Commands with shell syntax or a
 * builtin first word are left to the shell.
 */
export function adapterProblem(cmd: string, cwd = process.cwd(), path = process.env.PATH ?? ""): string | null {
  if (!cmd.trim()) return "the command is empty";
  if (SHELL_SYNTAX.test(cmd)) return null;
  const w = words(cmd);
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift(); // FOO=1 node agent.js
  const [program, ...args] = w;
  if (!program || BUILTINS.has(program)) return null;
  if (program.includes("/")) {
    if (!isExecutable(resolve(cwd, program))) return `${program} isn't a file you can run`;
  } else if (!path.split(delimiter).some((dir) => dir && isExecutable(join(isAbsolute(dir) ? dir : resolve(cwd, dir), program)))) {
    return `${program} isn't on your PATH`;
  }
  const missing = args.find((a) => !a.startsWith("-") && SCRIPT.test(a) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a) && !isFile(resolve(cwd, a)));
  return missing ? `${missing} doesn't exist` : null;
}

/**
 * The adapter as reported to WhiteRoom (§7 "What was tested"): only the
 * program's name and its script file's name, e.g. "python3 wr_adapter.py".
 * Never environment assignments, flags, flag values or directories.
 */
export function adapterLabel(cmd: string): string {
  const w = words(cmd).filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
  const safe = (p: string) => basename(p).replace(/[^\w.+-]/g, "").slice(0, 64);
  const script = w.slice(1).find((a) => !a.startsWith("-") && SCRIPT.test(a));
  return [w[0] && safe(w[0]), script && safe(script)].filter(Boolean).join(" ") || "adapter";
}

export interface KeyChoice {
  /** The environment variable the adapter gets the key in. */
  keyVar: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
  key: string;
  fromEnv: boolean;
}

/** The key from ANTHROPIC_API_KEY or OPENAI_API_KEY; null to prompt; "both" when it can't tell which (a guess could burn a try). */
export function keyFromEnv(env: NodeJS.ProcessEnv): KeyChoice | "both" | null {
  const set = (["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const).filter((v) => env[v]?.trim());
  if (set.length > 1) return "both";
  return set.length ? { keyVar: set[0], key: env[set[0]]!.trim(), fromEnv: true } : null;
}

/** A pasted key: the variable it goes in is the provider's, by the key's shape. */
export const keyFromPaste = (key: string): KeyChoice => ({ keyVar: key.startsWith("sk-ant-") ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY", key, fromEnv: false });

export class Interrupted extends Error {}

type Terminal = Pick<NodeJS.ReadStream, "setRawMode" | "setEncoding" | "resume" | "pause" | "on" | "off">;

/** Reads a line from the terminal without echoing it. Ctrl+C rejects with Interrupted. */
export function hiddenPrompt(question: string, stdin: Terminal = process.stdin): Promise<string> {
  const { stderr } = process;
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolvePrompt, reject) => {
    let s = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk: string) => {
      // A terminal with bracketed paste wraps a paste in ESC[200~ … ESC[201~.
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, "")) {
        if (ch === "\r" || ch === "\n") return done(), resolvePrompt(s.trim());
        if (ch === "\u0003") return done(), reject(new Interrupted());
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1);
        else if (ch >= " ") s += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** The first line of stdin (`--code-stdin`). */
export async function firstLineOfStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.includes("\n") || data.length > 4096) break;
  }
  return data.split("\n")[0].trim();
}

export const nodeTooOld = (version = process.versions.node) => (Number(version.split(".")[0]) < 20 ? copy.node(version) : null);
