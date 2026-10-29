// `whiteroom sandbox listen --adapter "<cmd>"`: the connected helper behind
// the Sandbox page's Run agent button. It claims a one-time helper code, then
// waits for tasks the owner queues there and runs each through the user's
// adapter (the practice tests' NDJSON contract), with the agent's calls going
// to the Sandbox URL. WhiteRoom sends task data only (a prompt); the command
// that runs is the one typed here, never anything from WhiteRoom.

import { hostname } from "node:os";
import { runAdapter, type Launch, type Outcome } from "../practice/adapter.js";
import { CATALOG } from "../practice/catalog.js";
import { Engine, REDIRECTED, Stopped, Unreachable, type Reply } from "../practice/engine.js";
import { adapterProblem, chatCompletions, firstLineOfStdin, hiddenPrompt, Interrupted, isProvider, nodeTooOld, targetOrigin } from "../practice/preflight.js";
import { clean, hideSecret, say, warn } from "../practice/text.js";

export const HELPER_CODE = /^wrhc_[A-Za-z0-9_-]{43}$/;
/** A Sandbox URL as the Sandbox page shows it: WhiteRoom's address, then the Sandbox key. */
const SANDBOX_URL = /^(https?:\/\/[^/\s?#@]+)\/(sk-wr-[0-9a-f]{40})(?:[/?#]\S*)?$/;
/** How long one task may run before its adapter is stopped. */
export const TASK_MS = 10 * 60_000;
/** While a task runs the helper doesn't poll, so it tells WhiteRoom it's still there. */
const HEARTBEAT_MS = 20_000;
/** Tests shorten the task deadline and heartbeat (internal, not a user setting; WHITEROOM_* never reaches the adapter). */
const testMs = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};
const SUMMARY_MAX = 2000;
const SANDBOX_PAGE = "https://app.whiteroom.tech/sandbox";
const NEW_CODE = `In the Sandbox page (${SANDBOX_PAGE}), click Run agent to get a new code, then start the helper again.`;

export const sandboxCopy = {
  connected: "Helper connected · waiting for tasks from the Sandbox page (Ctrl+C to stop)",
  needCode: "Paste the helper code from the Sandbox page (it won't show): ",
  badCode: "That isn't a helper code. Copy it again from the Sandbox page (it starts with wrhc_).",
  noTerminal: "No terminal to ask for the helper code. Pass it on stdin with --code-stdin.",
  noSandboxUrl: "Point your agent at your Sandbox first: set its base URL to the Sandbox URL from the Sandbox page (for example export ANTHROPIC_BASE_URL=<Sandbox URL>), then run the command again. Nothing was sent.",
  severalSandboxUrls: (vars: string[]) => `More than one Sandbox URL is set (${vars.join(", ")}). Keep the one your agent uses, then run the command again. Nothing was sent.`,
  otherSandboxHost: (urlHost: string, host: string) => `Your Sandbox URL is on ${urlHost}, but the helper connects to ${host}. Use the Sandbox URL and command from the same Sandbox page. Nothing was sent.`,
  badUrl: "--url must be a WhiteRoom address (https://….whiteroom.tech) or http://localhost for local testing.",
  adapterMissing: (cmd: string, why: string) => `Couldn't start the adapter \`${cmd}\`: ${why}. Nothing was sent, and your helper code still works.`,
  windows: "The helper runs on macOS and Linux for now. Run the command there, or in WSL.",
  codeInvalid: `This helper code doesn't work any more. ${NEW_CODE}`,
  keyMismatch: (left: number) => left > 0
    ? `Your agent's Sandbox URL isn't this Sandbox's current one (was the key rotated?). Copy the Sandbox URL from the Sandbox page, set it again, then run the same command (${left} ${left === 1 ? "try" : "tries"} left on this code).`
    : `Your agent's Sandbox URL isn't this Sandbox's current one, and this code has no tries left. Copy the Sandbox URL from the Sandbox page, set it again, then get a new code.`,
  notConnected: "This Sandbox has no key yet. Connect a provider key in the Sandbox page first.",
  unavailable: "The Sandbox helper isn't available yet. Try again later.",
  unreachable: "Couldn't reach WhiteRoom. Check your connection, then start the helper again.",
  redirected: "WhiteRoom's server tried to send the helper to another address, so it stopped. Nothing was sent anywhere else.",
  outdated: "WhiteRoom sent something this CLI doesn't understand. Update the CLI, then start the helper again.",
  otherHost: "WhiteRoom named another host for your Sandbox, so the helper stopped before running your agent.",
  sessionEnded: {
    session_lost: `This helper's session has ended (WhiteRoom restarted, or it expired). ${NEW_CODE}`,
    replaced: "Another helper connected to this Sandbox, so this one stopped.",
    disconnected: "The helper was disconnected from the Sandbox page.",
    lost_contact: `WhiteRoom didn't hear from this helper for a while, so its session ended. ${NEW_CODE}`,
  } as Record<string, string>,
  stopped: "Helper stopped. The Sandbox page shows it disconnected.",
  cancelled: "Stopped before the helper connected. Your code still works until it expires.",
  task: (n: number, prompt: string) => `Task ${n}: ${prompt.replace(/\s+/g, " ").slice(0, 80)}${prompt.length > 80 ? "…" : ""}`,
  taskDone: (n: number) => `Task ${n} finished. The result is on the Sandbox page.`,
  taskFailed: (n: number, why: string) => `Task ${n} didn't finish: ${why}`,
  resultNotSent: (n: number) => `Task ${n} ran, but its result couldn't be sent to WhiteRoom. If the Sandbox page hands it out again, the helper sends it again.`,
  noTools: "No tools are available in Sandbox tasks.",
};

export interface ListenArgs {
  adapter: string;
  codeStdin: boolean;
  url?: string;
}

/** The Sandbox URL the user's agent points at, found in its environment: the variable, WhiteRoom's origin and the Sandbox key. */
export function findSandboxUrl(env: NodeJS.ProcessEnv): Array<{ variable: string; origin: string; key: string }> {
  const found = new Map<string, { variable: string; origin: string; key: string }>();
  for (const [variable, value] of Object.entries(env)) {
    const m = value?.trim().match(SANDBOX_URL);
    if (m && !found.has(m[2])) found.set(m[2], { variable, origin: new URL(m[1]).origin, key: m[2] });
  }
  return [...found.values()];
}

/** The adapter's environment: the user's own (their agent's settings and keys), without WhiteRoom's. */
export function helperEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) if (!/^WHITEROOM_/i.test(k)) env[k] = v;
  return env;
}

/** This computer's name as the Sandbox page shows it ("Helper connected · <host>"). */
export function helperHost(name = hostname()): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "computer";
}

/** What a task's adapter run reports back: ok and a summary of at most 2,000 characters. */
export function taskResult(out: Outcome): { ok: boolean; summary: string } {
  const cut = (s: string) => s.slice(0, SUMMARY_MAX);
  switch (out.kind) {
    case "final": return { ok: true, summary: cut(out.output) };
    case "exited": return { ok: false, summary: cut(`Your adapter exited (${out.how}) before finishing.${out.tail.length ? ` Last output: ${out.tail.join(" / ")}` : ""}`) };
    case "broke": return { ok: false, summary: cut(`Your adapter ${out.why}.`) };
    case "deadline": return { ok: false, summary: `Your agent didn't finish within ${TASK_MS / 60_000} minutes, so it was stopped.` };
    default: return { ok: false, summary: "Stopped on the helper's computer." };
  }
}

const fail = (code: 0 | 2 | 3, line: string) => (warn(line), code);

/** A session refusal, in plain words. */
const sessionOver = (r: Reply) => fail(3, sandboxCopy.sessionEnded[r.body?.reason] ?? sandboxCopy.sessionEnded.session_lost);

export async function listen(a: ListenArgs): Promise<number> {
  // ── Preflight: nothing is sent until every check passes ──
  const old = nodeTooOld();
  if (old) return fail(2, old);
  if (process.platform === "win32") return fail(2, sandboxCopy.windows);
  const origin = targetOrigin(a.url);
  if (!origin) return fail(2, sandboxCopy.badUrl);
  const why = adapterProblem(a.adapter);
  if (why) return fail(2, sandboxCopy.adapterMissing(a.adapter, why));
  // The user's own command runs through their shell as typed; nothing from WhiteRoom is ever put into it.
  const launch: Launch = { shell: a.adapter };

  // Provider keys in the environment are never printed, even in the adapter's output.
  for (const p of Object.values(CATALOG.providers)) {
    const v = process.env[p.keyVar];
    if (v) hideSecret(v.trim());
  }
  const urls = findSandboxUrl(process.env);
  if (!urls.length) return fail(2, sandboxCopy.noSandboxUrl);
  if (urls.length > 1) return fail(2, sandboxCopy.severalSandboxUrls(urls.map((u) => u.variable)));
  const sandbox = urls[0];
  hideSecret(sandbox.key);
  if (sandbox.origin !== origin) return fail(2, sandboxCopy.otherSandboxHost(new URL(sandbox.origin).host, new URL(origin).host));

  let code = "";
  try {
    if (a.codeStdin) code = await firstLineOfStdin();
    else {
      if (!process.stdin.isTTY) return fail(2, sandboxCopy.noTerminal);
      for (let i = 0; i < 3 && !HELPER_CODE.test(code); i++) {
        if (i) warn(sandboxCopy.badCode);
        code = await hiddenPrompt(sandboxCopy.needCode);
      }
    }
  } catch (err) {
    // Cancelled at the prompt: no session existed, so this is a plain stop (0), not an ended session (3).
    if (err instanceof Interrupted) return fail(0, sandboxCopy.cancelled);
    throw err;
  }
  if (!HELPER_CODE.test(code)) return fail(2, sandboxCopy.badCode);
  hideSecret(code);

  // ── Claim: the code, and which Sandbox key this computer's agent uses (its non-secret prefix, never the key) ──
  const engine = new Engine(origin);
  let claim: Reply;
  try {
    claim = await engine.post("/api/sandbox-helper/claim", { code, keyPrefix: sandbox.key.slice(0, 22), host: helperHost() });
  } catch (err) {
    // No session yet: a setup problem (2); the code is still unused.
    if (err instanceof Unreachable) return fail(2, sandboxCopy.unreachable);
    throw err;
  }
  if (claim.status === 401 && claim.body?.reason === "key_mismatch") return fail(2, sandboxCopy.keyMismatch(Number(claim.body.triesLeft) || 0));
  if (claim.status === 410) return fail(2, sandboxCopy.codeInvalid);
  if (claim.status === 409 && claim.body?.reason === "not_connected") return fail(2, sandboxCopy.notConnected);
  if (claim.status === REDIRECTED) return fail(2, sandboxCopy.redirected);
  if (claim.status === 404) return fail(2, sandboxCopy.unavailable);
  const { session, proxyUrl, provider } = claim.body ?? {};
  if (claim.status !== 200 || typeof session !== "string" || !isProvider(provider)) return fail(2, sandboxCopy.outdated);
  engine.session = session;
  hideSecret(session);
  // The agent's calls go to this Sandbox's URL, on the host the helper claimed on, never one WhiteRoom names elsewhere.
  if (proxyUrl !== sandbox.origin) {
    await engine.once("/api/sandbox-helper/disconnect", {});
    return fail(3, sandboxCopy.otherHost);
  }
  // As practice tests pass it: Azure OpenAI under /openai; OpenAI SDKs want a base URL that ends in /v1.
  const sandboxBase = `${sandbox.origin}/${sandbox.key}${provider === "azure-openai" ? "/openai" : ""}`;
  const baseUrl = chatCompletions(provider) ? `${sandboxBase}/v1` : sandboxBase;
  say(sandboxCopy.connected);

  // ── Listening: Ctrl+C (or a signal) disconnects; WhiteRoom can end the session ──
  const stop = new AbortController();
  engine.signal = stop.signal;
  const onStop = () => stop.abort();
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  process.on("SIGHUP", onStop);
  /** Results by task: a task handed out again gets its result (re)sent, not a second run. */
  const done = new Map<string, { n: number; result: { ok: boolean; summary: string }; sent: boolean }>();
  const taskMs = testMs("WHITEROOM_TEST_TASK_MS", TASK_MS);
  const heartbeatMs = testMs("WHITEROOM_TEST_HEARTBEAT_MS", HEARTBEAT_MS);
  let n = 0;
  /** Posts a task's result; announces it only once WhiteRoom has it. */
  const sendResult = async (taskId: string, entry: { n: number; result: { ok: boolean; summary: string }; sent: boolean }) => {
    const r = await engine.post("/api/sandbox-helper/result", { taskId, ...entry.result }, { retryNetwork: true });
    if (r.status === 401) return r;
    const ok = r.status >= 200 && r.status < 300;
    if (ok && !entry.sent) say(entry.result.ok ? sandboxCopy.taskDone(entry.n) : sandboxCopy.taskFailed(entry.n, clean(entry.result.summary)));
    else if (!ok) warn(sandboxCopy.resultNotSent(entry.n));
    entry.sent ||= ok;
    return null;
  };
  let ended: Reply | null = null;

  const runTask = async (task: { taskId: string; prompt: string }) => {
    say(sandboxCopy.task(++n, task.prompt));
    const taskStop = new AbortController();
    const abort = () => taskStop.abort();
    stop.signal.addEventListener("abort", abort, { once: true });
    const beat = setInterval(() => {
      void engine.once("/api/sandbox-helper/heartbeat", {}).then((r) => {
        if (r?.status === 401) (ended = r), taskStop.abort();
      });
    }, heartbeatMs);
    beat.unref();
    let out: Outcome;
    try {
      out = await runAdapter({
        launch, env: helperEnv(process.env), deadline: Date.now() + taskMs, signal: taskStop.signal,
        message: { type: "task", task: task.prompt, tools: [], headers: {}, model: null, base_url: baseUrl },
        tool: async () => ({ result: { error: sandboxCopy.noTools } }),
      });
    } finally {
      clearInterval(beat);
      stop.signal.removeEventListener("abort", abort);
    }
    // Stopped here: disconnecting closes the task on the Sandbox page.
    if (out.kind === "stopped" || ended) return null;
    const entry = { n, result: taskResult(out), sent: false };
    done.set(task.taskId, entry);
    return sendResult(task.taskId, entry);
  };

  try {
    for (;;) {
      let next: Reply;
      try {
        next = await engine.post("/api/sandbox-helper/next", {}, { retryNetwork: true });
      } catch (err) {
        if (err instanceof Stopped) break;
        if (err instanceof Unreachable) return fail(3, sandboxCopy.unreachable);
        throw err;
      }
      if (next.status === 401) return sessionOver(next);
      if (next.status === REDIRECTED) return fail(3, sandboxCopy.redirected);
      if (next.status !== 200) return fail(3, sandboxCopy.outdated);
      if (next.body?.idle) continue;
      const task = next.body?.task;
      if (!task || typeof task.taskId !== "string" || task.kind !== "prompt" || typeof task.prompt !== "string") return fail(3, sandboxCopy.outdated);
      // A task handed out again (WhiteRoom didn't get the result): send the result again, don't run it twice.
      const sent = done.get(task.taskId);
      if (sent) {
        const again = await sendResult(task.taskId, sent).catch((err) => {
          if (err instanceof Stopped) return null;
          throw err;
        });
        if (again?.status === 401) return sessionOver(again);
        continue;
      }
      let refused: Reply | null;
      try {
        refused = await runTask(task);
      } catch (err) {
        if (err instanceof Stopped) break;
        if (err instanceof Unreachable) return fail(3, sandboxCopy.unreachable);
        throw err;
      }
      if (refused) return sessionOver(refused);
      if (ended) return sessionOver(ended);
      if (stop.signal.aborted) break;
    }
    await engine.once("/api/sandbox-helper/disconnect", {});
    say(sandboxCopy.stopped);
    return 0;
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    process.off("SIGHUP", onStop);
  }
}
