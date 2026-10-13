// `whiteroom practice run` (spec §4 Claim / Practice tasks, §6, §8, §10):
// preflight, claim, then the practice tasks and control checks the engine
// hands out, one at a time, until it returns the result.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { childEnv, runAdapter, type Launch, type ToolAnswer } from "./adapter.js";
import { Engine, pace, REDIRECTED, sleep, Stopped, Unreachable, type Reply } from "./engine.js";
import { CATALOG } from "./catalog.js";
import {
  adapterLabel, adapterProblem, chatCompletions, firstLineOfStdin, hiddenPrompt, Interrupted, isKeyVar, isProvider, isShortTermBedrockKey, keyFromEnv, keyHeader,
  keyVarOf, nodeTooOld, providerByShape, RUN_CODE, targetOrigin, type KeyChoice, type Provider,
} from "./preflight.js";
import { copy, ending, hideSecret, results, say, warn, type Ending } from "./text.js";

const HEARTBEAT_MS = 30_000;
/** A practice task WhiteRoom dropped (a restart, a failed capture): ask for it again, it doesn't count (§2 rule 4). */
const RESTART = new Set(["attempt_discarded", "not_found"]);
/** The final answer WhiteRoom takes: 32 Ki characters, inside its 64 KiB body limit. */
export function finalText(s: string): string {
  let out = s.slice(0, 32 * 1024);
  while (Buffer.byteLength(out) > 60_000) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

export const STARTERS_DIR = new URL("../../starters/", import.meta.url);
/** The sample agent is the JS starter adapter (§5 Agents). */
const SAMPLE_AGENT = fileURLToPath(new URL("wr-adapter.mjs", STARTERS_DIR));
const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export interface RunArgs {
  adapter?: string;
  codeStdin: boolean;
  url?: string;
  /** --key-env: the variable the run's key is read from, when several are set. */
  keyEnv?: string;
}

interface Progress {
  done: number;
  total: number;
}
interface PracticeTask {
  attemptId: string;
  runIndex: number;
  deadline: string;
  baseUrl: string;
  scenario: string;
  /** The model the sample agent and the starters use; null keeps their own default. */
  model?: string | null;
  prompt: string;
  tools: unknown[];
  headers: Record<string, string>;
}
interface ControlPlan {
  attemptId: string;
  runIndex: number;
  baseUrl: string;
}
interface ControlRequest {
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  delayMs?: number;
}

/**
 * Any refusal after a good claim ends the test with exit 3 (§8, §10 "Post-claim 409s").
 * 5xx and network errors never get here: Engine.post retries them or throws Unreachable.
 */
function sessionEnding(r: Reply): Ending {
  const reason = r.body?.reason;
  // The run already finished (WhiteRoom finished it meanwhile): its result, not a refusal. Without one, tasks/next replays it.
  if (r.body?.done || reason === "finished") return r.body?.report ? results(r.body.report) : { ...ending(3, copy.finished(r.body?.verdict)), result: true, replay: true };
  if (r.status === REDIRECTED) return ending(3, copy.redirected);
  if (reason === "engine_update") return ending(3, copy.engineUpdate(Number(r.body.tasksFinished) || 0));
  if (reason === "ended_by_owner") return ending(3, copy.endedByOwner);
  if (reason === "expired") return ending(3, copy.expired);
  if (reason === "call_cap") return ending(3, copy.callCap);
  if (reason === "no_model_calls") return ending(3, copy.noModelCalls);
  if (reason === "engine_error") return ending(3, copy.engineError);
  if (r.status === 401) return ending(3, copy.sessionGone);
  if (r.status === 429) return ending(3, copy.busy);
  if (r.status === 403) return ending(3, copy.refused);
  if (r.status === 404 && !reason) return ending(3, copy.unavailable);
  return ending(3, copy.cliOutdated); // A 4xx this CLI doesn't know: it's older than the server.
}

const print = (e: Ending, out = say) => {
  for (const l of e.lines) out(l);
  return e.code;
};
/** A refusal on stderr; a result (the run had already finished) on stdout. */
const fail = (e: Ending) => print(e, e.result ? say : warn);

export async function practiceRun(a: RunArgs): Promise<number> {
  // ── Preflight: nothing is sent until every check passes ──
  const old = nodeTooOld();
  if (old) return fail(ending(2, old));
  if (process.platform === "win32") return fail(ending(2, copy.windows));
  if (process.env.WHITEROOM_URL) say(copy.ignoringUrl);
  const origin = targetOrigin(a.url);
  if (!origin) return fail(ending(2, copy.badUrl));
  if (a.adapter !== undefined) {
    const why = adapterProblem(a.adapter);
    if (why) return fail(ending(2, copy.adapterMissing(a.adapter, why)));
  }
  // The user's own command runs through their shell as typed; nothing from WhiteRoom is ever put into it (§9.4).
  const launch: Launch = a.adapter !== undefined ? { shell: a.adapter } : { file: process.execPath, args: [SAMPLE_AGENT] };

  if (a.keyEnv !== undefined && !isKeyVar(a.keyEnv)) return fail(ending(2, copy.badKeyEnv(a.keyEnv)));
  const fromEnv = keyFromEnv(process.env, a.keyEnv);
  if (Array.isArray(fromEnv)) return fail(ending(2, copy.bothKeys(fromEnv)));
  let choice: KeyChoice | null = fromEnv;
  let code = "";
  try {
    if (a.codeStdin) code = await firstLineOfStdin();
    if (!choice) {
      if (!process.stdin.isTTY) return fail(ending(2, copy.noKey(a.keyEnv)));
      const pasted = await hiddenPrompt(copy.needKey);
      if (!pasted) return fail(ending(2, copy.noKey(a.keyEnv)));
      choice = { from: null, key: pasted };
    }
    if (!a.codeStdin) {
      if (!process.stdin.isTTY) return fail(ending(2, copy.noTerminal));
      // A malformed paste uses no try: ask again, up to 3 times.
      for (let i = 0; i < 3 && !RUN_CODE.test(code); i++) {
        if (i) warn(copy.badCode);
        code = await hiddenPrompt(copy.needCode);
      }
    }
  } catch (err) {
    if (err instanceof Interrupted) return fail(ending(3, copy.stoppedEarly));
    throw err;
  }
  if (!RUN_CODE.test(code)) return fail(ending(2, copy.badCode));
  const { key, from } = choice;
  hideSecret(key);
  hideSecret(code);
  // WhiteRoom refuses these without using a try; saying so here sends nothing.
  if (isShortTermBedrockKey(key)) return fail(ending(2, copy.shortTermKey));
  if (from) say(copy.keyInUse(from, key));
  say(copy.host(new URL(origin).host));

  // ── Claim: the key is checked against the fleet's; a mismatch uses a try and nothing else ──
  const engine = new Engine(origin);
  let claim: Reply;
  try {
    claim = await engine.post("/api/readiness/claim", {
      code, key, cli: { version: VERSION, adapter: a.adapter === undefined ? "sample agent" : adapterLabel(a.adapter) },
    });
  } catch (err) {
    if (err instanceof Unreachable) return fail(ending(3, copy.unreachable));
    throw err;
  }
  if (claim.status === 401 && claim.body?.reason === "key_mismatch") {
    const b = claim.body;
    const left = Number(b.triesLeft) || 0;
    if (left <= 0) return fail(ending(2, copy.lastTry));
    // A run on a Fleet key provider key (R7) names that key's provider and last four.
    const keyProvider: unknown = b.provider;
    if (isProvider(keyProvider)) {
      const hint = typeof b.keyHint === "string" && /^[\w-]{1,8}$/.test(b.keyHint) && b.keyHint !== "none" ? b.keyHint : null;
      return fail(ending(2, copy.providerKeyMismatch(from, key, CATALOG.providers[keyProvider].label, hint)));
    }
    const fleet = typeof b.fleetName === "string" && b.fleetName.trim() ? b.fleetName.trim().slice(0, 100) : null;
    return fail(ending(2, copy.keyMismatch(from ?? keyVarOf(providerByShape(key)), left, fleet)));
  }
  if (claim.status === 400 && claim.body?.reason === "short_term_key") return fail(ending(2, copy.shortTermKey));
  if (claim.status === REDIRECTED) return fail(ending(2, copy.redirected));
  if (claim.status === 410) return fail(ending(2, copy.codeInvalid));
  if (claim.status === 429) return fail(ending(3, copy.busy));
  if (claim.status === 404) return fail(ending(2, copy.unavailable));
  if (claim.status !== 200 || typeof claim.body?.session !== "string") return fail(ending(2, copy.cliOutdated));
  // The provider the run's calls go to decides the adapter's key variable, the header and the API.
  const runProvider: unknown = claim.body.run?.provider;
  if (!isProvider(runProvider)) return fail(ending(2, copy.cliOutdated));
  const provider: Provider = runProvider;
  engine.session = claim.body.session as string;
  hideSecret(engine.session);
  const runs = Number(claim.body.run?.runs) || 1;
  say(copy.started(Number(claim.body.run?.tasks) || 0, runs));

  // ── From here the session is live: Ctrl+C twice, a signal, or WhiteRoom (heartbeat) can stop it ──
  const stop = new AbortController();
  engine.signal = stop.signal;
  const halt: { why: Ending | null; cancel: boolean } = { why: null, cancel: false };
  const stopWith = (e: Ending, cancel: boolean) => {
    if (!halt.why) Object.assign(halt, { why: e, cancel });
    stop.abort();
  };
  let pressed = 0;
  const onSigint = () => (++pressed === 1 ? warn(copy.pressAgain) : stopWith(ending(3, copy.cancelled), true));
  const onTerm = () => stopWith(ending(3, copy.cancelled), true);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onTerm);
  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating) return;
    beating = true;
    engine.post("/api/readiness/heartbeat", {}, { retryNetwork: true })
      .then((r) => (r.status !== 200 || r.body?.done) && stopWith(sessionEnding(r), false))
      .catch((err) => err instanceof Unreachable && stopWith(ending(3, copy.unreachable), false))
      .finally(() => { beating = false; });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  /** The key only ever goes to the host the user chose. */
  const ourHost = (url: unknown) => {
    try {
      return new URL(String(url)).origin === origin;
    } catch {
      return false;
    }
  };

  /** One practice task through the adapter. An Ending stops the test; null asks for the next task. */
  const practiceTask = async (t: PracticeTask, p: Progress): Promise<Ending | null> => {
    if (!ourHost(t.baseUrl)) return ending(3, copy.otherHost);
    const deadline = Date.parse(t.deadline);
    if (!Number.isFinite(deadline)) return ending(3, copy.cliOutdated);
    const run = runs > 1 ? ` (run ${t.runIndex + 1} of ${runs})` : "";
    say(`Practice task ${p.done + 1} of ${p.total}: ${CATALOG.taskNames[t.scenario] ?? "Practice task"}${run}`);
    const out = await runAdapter({
      launch, env: childEnv(process.env, keyVarOf(provider), key), deadline, signal: stop.signal,
      message: {
        type: "task", task: t.prompt, tools: t.tools, headers: t.headers,
        model: typeof t.model === "string" && t.model ? t.model : null,
        // OpenAI SDKs (Azure OpenAI's too) take a base URL that ends in /v1.
        base_url: chatCompletions(provider) ? `${t.baseUrl}/v1` : t.baseUrl,
      },
      tool: async (call): Promise<ToolAnswer> => {
        const r = await engine.post("/api/readiness/tools", { attemptId: t.attemptId, ...call }).catch(() => null);
        if (!r) return { end: "lost" };
        if (r.status === 200) return { result: r.body?.result ?? null };
        const reason = r.body?.reason;
        return { end: RESTART.has(reason) ? "restart" : reason === "expired" ? "deadline" : reason === "tool_limit" ? "tool_limit" : r.status === 400 ? "bad_tool" : sessionEnding(r) };
      },
    });
    if (out.kind === "stopped") return null;
    const why = out.kind === "ended" ? out.by : out.kind;
    if (typeof why === "object") return why as Ending;
    if (why === "restart" || why === "lost") return warn(why === "lost" ? copy.lostTask : copy.restart), null;

    const send = (output: string | null, ended: "final" | "adapter_exited" | "deadline") =>
      engine.post(`/api/readiness/tasks/${encodeURIComponent(t.attemptId)}/final`, { output, ended }).catch(() => null);
    const final = async (output: string | null, ended: "final" | "deadline"): Promise<Ending | null> => {
      const r = await send(output, ended);
      if (!r) return warn(copy.lostTask), null;
      if (r.status === 200) return null;
      if (RESTART.has(r.body?.reason)) return warn(copy.restart), null;
      return sessionEnding(r);
    };
    if (out.kind === "final") return final(finalText(out.output), "final");
    if (why === "deadline") return warn(copy.deadline), final(null, "deadline");
    // The adapter crashed or broke the protocol: kept as this task's result, unless WhiteRoom dropped the task
    // (it runs again); then the test ends with a result over the tasks done so far (exit 3).
    const r = await send(null, "adapter_exited");
    if (r && r.status !== 200) return RESTART.has(r.body?.reason) ? (warn(copy.restart), null) : sessionEnding(r);
    const c = await engine.cancel(true);
    if (c && c.status !== 200 && c.body?.reason === "finished") return sessionEnding(c); // It finished meanwhile: its result wins.
    const kept = c?.status === 200 && c.body?.lifecycle === "finished" ? copy.keptResults : copy.keptUnconfirmed;
    if (out.kind === "exited") return ending(3, ...copy.adapterCrashed(out.how, out.tail), kept);
    return ending(3, copy.adapterBroke(out.kind === "broke" ? out.why : why === "tool_limit" ? copy.tooManyTools : copy.badTool), kept);
  };

  /** The control checks: each call WhiteRoom plans, sent with the key, its response reported back (§6). */
  const controlChecks = async (c: ControlPlan): Promise<Ending | null> => {
    if (!ourHost(c.baseUrl)) return ending(3, copy.otherHost);
    say(`Checking your controls${runs > 1 ? ` (run ${c.runIndex + 1} of ${runs})` : ""}`);
    let result: { status: number; reason: string | null; ruleId: string | null } | null = null;
    for (;;) {
      const r = await engine.post("/api/readiness/controls/next", { attemptId: c.attemptId, result }).catch(() => null);
      if (stop.signal.aborted) return null;
      // Lost or dropped: tasks/next starts the control checks again. Not safe to resend `result`.
      if (!r) return warn(copy.lostTask), null;
      if (r.status !== 200) return RESTART.has(r.body?.reason) || r.body?.reason === "expired" ? (warn(copy.restart), null) : sessionEnding(r);
      if (r.body?.done) return null;
      const q = r.body?.request as ControlRequest | undefined;
      if (!q || typeof q.path !== "string") return ending(3, copy.cliOutdated);
      if (!ourHost(q.url)) return ending(3, copy.otherHost);
      await sleep(Math.min(Math.max(Number(q.delayMs) || 0, 0), 120_000), stop.signal);
      if (stop.signal.aborted) return null;
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries(q.headers ?? {})) if (!/^(authorization|x-api-key|api-key)$/i.test(h)) headers[h] = String(v);
      Object.assign(headers, keyHeader(provider, key));
      await pace();
      try {
        const res = await fetch(q.url, { method: "POST", headers, body: JSON.stringify(q.body), redirect: "error", signal: AbortSignal.timeout(60_000) });
        const wr = (await res.json().catch(() => null))?.whiteroom;
        const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
        result = { status: res.status, reason: str(wr?.reason, 64), ruleId: str(wr?.ruleId, 128) };
      } catch {
        // A network error or a redirect (never followed, so the key stays on this host):
        // not a result, so WhiteRoom calls the check a test problem.
        result = { status: 0, reason: null, ruleId: null };
      }
    }
  };

  /** Shows how the test ended; a finished run whose reply had no result gets it from tasks/next (one try). */
  const end = async (e: Ending): Promise<number> => {
    if (e.replay) {
      engine.signal = null;
      const r = await engine.post("/api/readiness/tasks/next", { key }).catch(() => null);
      if (r?.status === 200 && r.body?.done && r.body.report) return print(results(r.body.report));
    }
    return fail(e);
  };

  // ── The practice tasks, until the result ──
  try {
    while (!halt.why) {
      let next: Reply;
      try {
        next = await engine.post("/api/readiness/tasks/next", { key }, { retryNetwork: true });
      } catch (err) {
        if (err instanceof Stopped) break;
        if (err instanceof Unreachable) return fail(ending(3, copy.unreachable));
        throw err;
      }
      if (next.status !== 200 || next.body?.done) return end(sessionEnding(next));
      const b = next.body;
      const e = b?.task ? await practiceTask(b.task, b.progress) : b?.controls ? await controlChecks(b.controls) : ending(3, copy.cliOutdated);
      // A result wins over how the session stopped meanwhile.
      if (e && (!halt.why || e.result)) return end(e);
    }
    // Ctrl+C or a signal ends the run, so the dashboard doesn't wait for this computer.
    if (halt.cancel) await engine.cancel();
    return end(halt.why!);
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onTerm);
  }
}
