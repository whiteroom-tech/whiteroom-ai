// `whiteroom sandbox run --provider <p> -- <command> [args…]`: runs the
// user's agent once with its base URL set to their Sandbox URL, so nothing
// has to be edited first. The Sandbox URL is pasted at a hidden prompt (or
// read from WHITEROOM_SANDBOX_URL), so the key never lands in shell history.
// The command runs as typed, without a shell; nothing from WhiteRoom is put
// into it. Refuses to start while another base URL in the environment points
// at WhiteRoom, so the agent's calls can't go to production by mistake.

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { hiddenPrompt, Interrupted, nodeTooOld, targetOrigin } from "../practice/preflight.js";
import { say, warn } from "../practice/text.js";
import { helperEnv } from "./listen.js";

/** A Sandbox URL as the Sandbox page shows it: WhiteRoom's address, then the Sandbox key. */
const SANDBOX_URL = /^(https?:\/\/[^/\s?#@]+)\/(sk-wr-[0-9a-f]{40})(?:\/v1|\/openai)?\/?$/;

/** The providers a Sandbox connects, as the dashboard names them. */
export const RUN_PROVIDERS = ["anthropic", "openai", "azure-openai", "foundry", "bedrock-mantle"] as const;
export type RunProvider = typeof RUN_PROVIDERS[number];

/** Base-URL settings agents read: one pointing at WhiteRoom other than the one this sets could send calls to production. */
const BASE_URL_VARS = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "AZURE_OPENAI_ENDPOINT"];

export const runCopy = {
  needUrl: "Paste your Sandbox URL from the Sandbox page (it won't show): ",
  badUrl: "That isn't a Sandbox URL. Copy it again from the Sandbox page (it ends with /sk-wr-…). Nothing was run.",
  noTerminal: "No terminal to ask for the Sandbox URL. Set WHITEROOM_SANDBOX_URL to it instead. Nothing was run.",
  notWhiteRoom: "That Sandbox URL isn't a WhiteRoom address. Copy it again from the Sandbox page. Nothing was run.",
  pointsAtWhiteRoom: (vars: string[]) => `${vars.join(" and ")} already ${vars.length === 1 ? "points" : "point"} at WhiteRoom, so your agent's calls could go to production instead of your Sandbox. Unset ${vars.length === 1 ? "it" : "them"}, then run this again. Nothing was run.`,
  running: (name: string) => `Running your agent with ${name} set to your Sandbox URL. The checks start on its first call; results are on the Sandbox page.`,
  cancelled: "Stopped. Nothing was run.",
  notFound: (cmd: string) => `Couldn't start \`${cmd}\`: no such command. Check the command, then run this again.`,
  couldntStart: (cmd: string, why: string) => `Couldn't start \`${cmd}\`: ${why}.`,
};

/** The setting that points an agent at the Sandbox, as the Sandbox page's .env line has it (dashboard issuedEnvHint). */
export function sandboxSetting(provider: RunProvider, url: string): { name: string; value: string } {
  const base = url.replace(/\/+$/, "");
  if (provider === "azure-openai") return { name: "AZURE_OPENAI_ENDPOINT", value: base };
  if (provider === "openai") return { name: "OPENAI_BASE_URL", value: `${base}/v1` };
  return { name: "ANTHROPIC_BASE_URL", value: base };
}

/** Other base-URL settings in the environment that point at WhiteRoom (whiteroom.tech; a local proxy on localhost is the user's own). */
export function whiteRoomBaseUrls(env: NodeJS.ProcessEnv, except: string): string[] {
  return BASE_URL_VARS.filter((name) => {
    if (name === except || !env[name]?.trim()) return false;
    try {
      const host = new URL(env[name]!.trim()).hostname;
      return host === "whiteroom.tech" || host.endsWith(".whiteroom.tech");
    } catch {
      return false;
    }
  });
}

/** The Sandbox URL, checked: null when it isn't one, or isn't on a WhiteRoom address. */
export function sandboxUrlOf(raw: string): { url: string } | { problem: string } {
  const m = raw.trim().match(SANDBOX_URL);
  if (!m) return { problem: runCopy.badUrl };
  if (targetOrigin(m[1], {}) === null) return { problem: runCopy.notWhiteRoom };
  return { url: `${new URL(m[1]).origin}/${m[2]}` };
}

export interface RunArgs {
  provider: RunProvider;
  command: string[];
}

const fail = (line: string) => (warn(line), 2);

export async function run(a: RunArgs, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const old = nodeTooOld();
  if (old) return fail(old);
  let raw = env.WHITEROOM_SANDBOX_URL ?? "";
  if (!raw) {
    if (!process.stdin.isTTY) return fail(runCopy.noTerminal);
    try {
      raw = await hiddenPrompt(runCopy.needUrl);
    } catch (err) {
      if (err instanceof Interrupted) return warn(runCopy.cancelled), 130;
      throw err;
    }
  }
  const checked = sandboxUrlOf(raw);
  if ("problem" in checked) return fail(checked.problem);
  const setting = sandboxSetting(a.provider, checked.url);
  const clash = whiteRoomBaseUrls(env, setting.name);
  if (clash.length) return fail(runCopy.pointsAtWhiteRoom(clash));

  // The agent gets the user's environment (without WHITEROOM_*), with its base URL set to the Sandbox.
  const childEnv = { ...helperEnv(env), [setting.name]: setting.value };
  say(runCopy.running(setting.name));
  const [cmd, ...args] = a.command;
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: childEnv });
    // Ctrl+C reaches the agent from the terminal; a signal sent to this process alone is passed on.
    const forward = (sig: NodeJS.Signals) => () => { child.kill(sig); };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const done = (code: number) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(code);
    };
    child.on("error", (err: NodeJS.ErrnoException) => done(fail(err.code === "ENOENT" ? runCopy.notFound(cmd) : runCopy.couldntStart(cmd, err.message))));
    // The agent's own exit code; killed by a signal, 128 + its number, as a shell reports it.
    child.on("exit", (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 0)));
  });
}
