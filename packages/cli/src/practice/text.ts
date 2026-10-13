// What the practice commands print (spec §8, §10, Appendix D). Plain words
// only: no internal names, no engine reason codes. Every way a run ends
// names the dashboard and the button to click there. Task, status, provider
// and refusal words are the engine's catalog's.

import { CATALOG } from "./catalog.js";

export const DASHBOARD = "https://app.whiteroom.tech/sandbox";
const KEY_VARS = Object.values(CATALOG.providers).map((p) => p.keyVar);

/** Control, C1 and bidi characters, which could rewrite what the terminal shows. Tabs and newlines stay. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const secrets = new Set<string>();
/** Remembers a secret (provider key, run code, session) so `clean` never prints it. */
export function hideSecret(s: string): void {
  if (s.length >= 8) secrets.add(s);
}

/** Text safe to print: no terminal control characters, no known secret. */
export function clean(s: string): string {
  let out = s.replace(UNSAFE, "");
  for (const x of secrets) out = out.split(x).join("[hidden]");
  return out;
}

export const say = (s: string) => process.stdout.write(clean(s) + "\n");
export const warn = (s: string) => process.stderr.write(clean(s) + "\n");

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "A, B and C". */
const list = (xs: string[], and = "and") => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} ${and} ${xs[xs.length - 1]}` : xs.join(""));
const button = (name: string) => `In the dashboard (${DASHBOARD}), click ${name}`;

/** A way the command ends: the exit code (§8) and what to print. */
export interface Ending {
  code: 0 | 1 | 2 | 3;
  lines: string[];
  /** The test's result (printed on stdout), not a refusal. */
  result?: true;
  /** The run finished, but the reply didn't carry its result: ask tasks/next for it. */
  replay?: true;
}
export const ending = (code: Ending["code"], ...lines: string[]): Ending => ({ code, lines });

export const copy = {
  ignoringUrl: "Ignoring WHITEROOM_URL: practice tests always run on WhiteRoom.",
  keyInUse: (v: string, key: string) => `Using the key in ${v} (ends ${key.slice(-4)}).`,
  host: (host: string) => `Sending your key to ${host} to start the practice test.`,
  started: (tasks: number, runs: number) =>
    `Practice test started: ${plural(tasks, "practice task")}${runs > 1 ? ` over ${runs} runs` : ""}. Keep this terminal open and your computer awake.`,
  restart: "WhiteRoom restarted this practice task, so it starts again. This doesn't count against your agent.",
  lostTask: "Lost contact with WhiteRoom during this practice task, so it starts again. This doesn't count against your agent.",
  offline: "Lost connection to WhiteRoom. Trying again for up to 5 minutes.",
  deadline: "Your agent didn't finish this practice task in time, so it was stopped.",
  pressAgain: "Press Ctrl+C again to end the practice test. Finished practice tasks are kept.",

  badCode: "That isn't a run code. Copy it again from the dashboard (it starts with wrrt_).",
  needCode: "Paste the run code from the dashboard (it won't show): ",
  needKey: "Paste the model provider key your agent uses (it won't show): ",
  bothKeys: (vars: string[]) => `${vars.length === 2 ? `Both ${vars[0]} and ${vars[1]} are` : `${list(vars)} are all`} set. Add --key-env with the one your agent uses (for example --key-env ${vars[0]}), then run the command again. Nothing was sent.`,
  noKey: (keyEnv?: string) => `Set the key your agent uses (${keyEnv ?? list(KEY_VARS, "or")}), then run the command again.`,
  badKeyEnv: (v: string) => `--key-env must name a provider key variable (${list(KEY_VARS, "or")}), not ${v}.`,
  shortTermKey: CATALOG.keyRefusals.short_term_key,
  node: (v: string) => `Needs Node 20 or later (you have ${v}).`,
  windows: "Practice tests run on macOS and Linux in this beta. Run the command there, or in WSL.",
  badUrl: "--url must be a WhiteRoom address (https://….whiteroom.tech) or http://localhost for local testing.",
  adapterMissing: (cmd: string, why: string) =>
    `Couldn't start the adapter \`${cmd}\`: ${why}. Nothing was sent or charged, and your run code still works.`,

  keyMismatch: (v: string, left: number, fleet: string | null = null) =>
    `This key isn't the one your agent uses with ${fleet ?? "this fleet"}. Nothing was charged, and your run code still works (${plural(left, "more try", "more tries")}). Set ${v} to the right key, then run the same command again.`,
  /** §17: a run on a Fleet key provider key names that key as Fleet key does; a new test is the way to pick another. */
  providerKeyMismatch: (from: string | null, key: string, provider: string, hint: string | null) =>
    `${from ? `The key in ${from}` : "The key you pasted"} (ends ${key.slice(-4)}) isn't the ${provider} key saved on Fleet key${hint ? ` (key ending ${hint})` : ""}. Nothing was charged. If you've changed keys, add the new one on Fleet key, then start a new test in the dashboard and pick that key.`,
  lastTry: `That was the last try, so this run code no longer works. Nothing was charged. ${button("Get a new run code")}, then set the right key and run the command again.`,
  codeInvalid: `This run code doesn't work any more: it expired or was already used. ${button("Get a new run code")}, then run the command again.`,
  busy: "Practice tests are busy right now. Try again in a few minutes. Your run code still works.",
  unavailable: "Practice tests aren't available yet. Try again later.",
  unreachable: "Couldn't reach WhiteRoom. Check your connection, then run the command again.",
  cliOutdated: "WhiteRoom sent something this CLI doesn't understand. Update the CLI, then run the test again.",
  redirected: "WhiteRoom's server tried to send the CLI to another address, so it stopped there. Nothing was sent anywhere else. Try again in a few minutes.",
  refused: `WhiteRoom refused the CLI's request. ${button("Start test")} to run it again.`,
  otherHost: "WhiteRoom sent an address on another host, so the CLI stopped before sending your key there.",

  engineUpdate: (kept: number) => `WhiteRoom was updated during your practice test, so it stopped. ${kept ? `${plural(kept, "finished practice task")} kept. ` : ""}${button("Start test")} to run it again.`,
  endedByOwner: `The practice test was ended from the dashboard. Finished practice tasks were kept. ${button("Start test")} to test again.`,
  expired: `This practice test has ended: it lost contact with this computer or ran out of time. ${button("Start test")} to run it again.`,
  callCap: `Stopped at this test's model-call limit after WhiteRoom had to rerun a task (not your agent). ${button("Start test")} to run it again.`,
  noModelCalls: `Stopped: your agent didn't make any model calls through WhiteRoom in 2 practice tasks in a row. Check your adapter sends its calls to the base_url the CLI gives it. ${button("Start test")} to run it again.`,
  engineError: `WhiteRoom couldn't finish working out the result (not your agent). ${button("Start test")} to run a new test.`,
  finished: (verdict: unknown) => {
    const label = typeof verdict === "string" && Object.hasOwn(CATALOG.verdictLabels, verdict) ? `: ${CATALOG.verdictLabels[verdict as Report["verdict"]]}` : "";
    return `The practice test finished${label}. See the results in the dashboard (${DASHBOARD}), under Past tests.`;
  },
  sessionGone: `WhiteRoom no longer knows this practice test. ${button("Start test")} to run it again.`,
  cancelled: `Practice test ended. Finished practice tasks were kept. ${button("Start test")} to run it again.`,
  adapterCrashed: (code: string, tail: string[]) => [
    `Your adapter stopped before it finished the practice task (${code}).`,
    ...(tail.length ? ["Its last lines:", ...tail.map((l) => `  ${l}`)] : []),
    "Run the adapter on its own to see why.",
  ],
  adapterBroke: (why: string) => `Your adapter ${why}, so it was stopped.`,
  keptResults: `The test ended early. The practice tasks your agent finished are in the results: see the dashboard (${DASHBOARD}), under Past tests.`,
  keptUnconfirmed: `The test ended early. WhiteRoom didn't confirm it kept the results: check Past tests in the dashboard (${DASHBOARD}).`,
  tooManyTools: "made more test-tool calls than a practice task allows",
  badTool: "sent a tool call WhiteRoom couldn't accept",
  noTerminal: "There's no terminal to paste the run code into. Pipe it in with --code-stdin instead.",
  stoppedEarly: "Stopped before the practice test started.",
};

// ── Results (§8) ─────────────────────────────────────────────────────────

export interface Check {
  id: string;
  label: string;
  scenario?: string;
  status: "passed" | "failed" | "not_tested" | "unsupported" | "error";
  required: boolean;
  testProblem?: boolean;
  summary?: string | null;
  fix?: string | null;
  mode?: string | null;
}
export interface Report {
  verdict: "passed" | "not_passed" | "incomplete";
  runs: number;
  sample: boolean;
  scope: string[] | null;
  checks: Check[];
}

const STATUS = CATALOG.statusLabels;

/** The results screen in the terminal, and its exit code: 0 Passed, 1 Didn't pass, 3 Didn't finish. */
export function results(r: Report): Ending {
  const required = r.checks.filter((c) => c.required);
  const runs = plural(r.runs, "run");
  const failed = required.filter((c) => c.status === "failed");
  const open = required.filter((c) => c.status !== "passed");
  const scope = r.scope && [...new Set(required.map((c) => c.scenario).filter(Boolean))].join(", ");
  const lines: string[] = [""];
  let code: Ending["code"];
  if (r.verdict === "passed") {
    code = 0;
    lines.push(`${CATALOG.verdictLabels.passed} · ${scope ? `${scope} only` : `all ${plural(required.length, "check")}`} · ${runs}`);
  } else if (r.verdict === "not_passed") {
    code = 1;
    lines.push(`${CATALOG.verdictLabels.not_passed} · ${plural(failed.length, "check")} failed`);
  } else {
    code = 3;
    const ours = open.length > 0 && open.every((c) => c.testProblem);
    lines.push(`${CATALOG.verdictLabels.incomplete} · ${open.length ? `${plural(open.length, "check")} couldn't run` : "no checks could run"}${ours ? " (not your agent)" : ""}`);
  }
  if (r.sample) lines.push("This was WhiteRoom's sample agent: it checks your controls and this setup, not your own agent.");
  else if (r.runs === 1 && code === 0) lines.push("One run shows your agent can pass. Run it 3 times to see that it passes every time.");
  lines.push("");
  for (const c of r.checks) {
    const name = c.mode ? `${c.label} · ${c.mode}` : c.label;
    // A control row says what happened; a row that wasn't checked says why instead of a status.
    if (c.status === "unsupported" && c.summary) lines.push(`  ${name}: ${c.summary}`);
    else lines.push(`  ${STATUS[c.status]}: ${name}${c.id.startsWith("ctl") && c.summary ? ` (${c.summary})` : ""}`);
  }
  const fixes = (code === 1 ? failed : code === 3 ? open : []).filter((c) => c.fix);
  if (fixes.length) {
    lines.push("", code === 3 ? "What stopped the test" : "What to fix");
    for (const c of fixes) lines.push(`  ${c.label}: ${c.fix}`);
  }
  const next = code === 1 ? "Rerun failed checks" : code === 3 ? "Rerun checks that didn't run" : !r.sample && r.runs === 1 ? "Run it 3 times" : "Past tests";
  lines.push("", CATALOG.disclaimer, next === "Past tests" ? `See the full result in the dashboard (${DASHBOARD}), under Past tests.` : `${button(next)}.`);
  return { code, lines, result: true };
}
