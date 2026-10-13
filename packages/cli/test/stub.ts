// A stand-in WhiteRoom for the CLI tests: the /api/readiness routes answer
// with the engine's frozen contract fixtures (test/fixtures, R4), every
// request body the CLI sends is checked against the fixture's request shape,
// Template A's test tools keep records, and a scripted fake model answers
// /v1/messages and /v1/chat/completions the way a provider would.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const PKG = new URL("..", import.meta.url).pathname;
// Obvious placeholders (CLAUDE.md: this repo is public).
export const KEY = "sk-ant-placeholder-test-key-91c0";
export const OPENAI_KEY = "sk-placeholder-openai-test-key-77aa";
export const CODE = `wrrt_${"A".repeat(43)}`;
/** R7: a key saved on Fleet key per cloud provider, and the variable it's read from. */
export const CLOUD = {
  "azure-openai": { key: "azure-placeholder-test-key-a1b2", keyVar: "AZURE_OPENAI_API_KEY" },
  foundry: { key: "foundry-placeholder-test-key-c3d4", keyVar: "ANTHROPIC_FOUNDRY_API_KEY" },
  "bedrock-mantle": { key: "bedrock-placeholder-long-term-key-e5f6", keyVar: "AWS_BEARER_TOKEN_BEDROCK" },
} as const;
export type CloudProvider = keyof typeof CLOUD;
/** The attempt's proxy key in a provider-key run's base URL (placeholder). */
export const ATTEMPT_PROXY_KEY = `sk-wr-${"0".repeat(40)}`;
export const SESSION = `wrrs_${"B".repeat(43)}`;

type Entry = { name: string; method: string; path: string; request: unknown; status: number; response: unknown };
const contract = JSON.parse(readFileSync(new URL("fixtures/contract.json", import.meta.url), "utf8")) as { phase: string; entries: Entry[] };
export const fixture = (name: string): Entry => {
  const e = contract.entries.find((x) => x.name === name);
  if (!e) throw new Error(`no fixture ${name}`);
  return structuredClone(e);
};

/** A body's shape: its keys, all the way down, except values the CLI passes through untouched. */
function shape(v: unknown, key = ""): unknown {
  if (["input", "result", "output", "code", "key", "version", "adapter"].includes(key)) return "*";
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k], k)]));
  }
  return typeof v;
}

// Template A's made-up tickets: two qualify (Enterprise and an outage), one doesn't.
const TICKETS = [
  { id: "T-1", subject: "Invoice totals are wrong", customerPlan: "Enterprise", severity: "outage", team: "billing" },
  { id: "T-2", subject: "Card payments are failing", customerPlan: "Enterprise", severity: "outage", team: "platform" },
  { id: "T-3", subject: "Invoice totals are wrong", customerPlan: "Pro", severity: "outage", team: "billing" },
];

export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}
type Reply = [number, unknown, Record<string, string>?];

export interface StubOptions {
  /** What tasks/next hands out, in order; then the fixture's result. */
  plan?: Array<"A" | "controls">;
  /** How long a practice task has. */
  taskMs?: number;
  /** Per-request override: return a reply to answer instead of the stub. `n` counts requests to that path. */
  route?: (path: string, body: any, n: number) => Reply | undefined;
  /** The fake model's first call on each practice task is answered as WhiteRoom does while it saves a summary. */
  summaryFirst?: boolean;
  /** The result tasks/next returns at the end (default: the fixture's). */
  done?: unknown;
  /** The practice task's model (default: the fixture's); null means none was chosen. */
  taskModel?: string | null;
  /** R7: the run uses this cloud provider's Fleet key key (the r7 fixtures); else the fleet's own Anthropic or OpenAI key. */
  cloud?: CloudProvider;
}

export interface Stub {
  url: string;
  seen: Seen[];
  /** Request bodies that don't match the fixture's request for that route. */
  contractErrors: string[];
  escalations: Array<{ ticketId: string; team: string }>;
  /** The model each practice-task model call asked for. */
  models: string[];
  /** Each model call's path and the header its key came in. */
  calls: Array<{ path: string; keyHeader: string }>;
  finals: Array<{ attemptId: string; output: string | null; ended: string }>;
  controlResults: unknown[];
  count: (path: string) => number;
  close: () => Promise<void>;
}

export async function startStub(o: StubOptions = {}): Promise<Stub> {
  const plan = [...(o.plan ?? ["A"])];
  const total = plan.length;
  const counts = new Map<string, number>();
  const stub = { seen: [] as Seen[], contractErrors: [] as string[], escalations: [] as Stub["escalations"], models: [] as string[], calls: [] as Stub["calls"], finals: [] as Stub["finals"], controlResults: [] as unknown[] };
  let attempt = 0;
  let current: { id: string; reads: Set<string>; summarised: boolean } | null = null;
  let controlSteps = 0;
  let origin = "";
  let provider = "anthropic";
  /** Where the run's model calls go: this server, or a provider-key run's attempt proxy key URL. */
  const baseUrl = () => (o.cloud ? `${origin}/${ATTEMPT_PROXY_KEY}${o.cloud === "azure-openai" ? "/openai" : ""}` : origin);

  const expect = (name: string, body: unknown) => {
    const want = JSON.stringify(shape(fixture(name).request));
    const got = JSON.stringify(shape(body));
    if (want !== got) stub.contractErrors.push(`${name}: sent ${got}, fixture has ${want}`);
  };
  const fromFixture = (name: string, patch: (r: any) => void = () => {}): Reply => {
    const f = fixture(name);
    patch(f.response);
    return [f.status, f.response];
  };

  const readiness = (path: string, body: any, headers: IncomingMessage["headers"]): Reply => {
    if (path === "/api/readiness/claim") {
      expect("claim", body);
      if (body.code !== CODE) return fromFixture("claim.code_invalid");
      if (o.cloud) {
        if (body.key.startsWith("bedrock-api-key-")) return fromFixture("r7.claim.short_term_key");
        if (body.key !== CLOUD[o.cloud].key) return fromFixture("r7.claim.key_mismatch", (r) => Object.assign(r, { provider: o.cloud }));
        provider = o.cloud;
        return fromFixture("r7.claim", (r) => Object.assign(r, { session: SESSION, run: { ...r.run, provider, tasks: plan.length } }));
      }
      if (body.key !== KEY && body.key !== OPENAI_KEY) return fromFixture("claim.key_mismatch");
      provider = body.key === KEY ? "anthropic" : "openai";
      return fromFixture("claim", (r) => Object.assign(r, { session: SESSION, run: { ...r.run, provider, runs: 1, tasks: plan.length } }));
    }
    if (headers.authorization !== `Bearer ${SESSION}`) return fromFixture("session.unknown");
    if (path === "/api/readiness/tasks/next") {
      expect("tasks.next.task.A", body);
      const item = plan.shift();
      if (!item) return o.done ? [200, o.done] : fromFixture("tasks.next.done");
      const id = `a-${++attempt}`;
      const progress = { done: total - plan.length - 1, total };
      current = { id, reads: new Set(), summarised: false };
      const deadline = new Date(Date.now() + (o.taskMs ?? 60_000)).toISOString();
      if (item === "controls") {
        controlSteps = 0;
        return fromFixture("tasks.next.controls", (r) => {
          Object.assign(r.controls, { attemptId: id, deadline, baseUrl: baseUrl(), provider });
          r.progress = progress;
        });
      }
      return fromFixture(o.cloud ? "r7.tasks.next.task" : "tasks.next.task.A", (r) => {
        Object.assign(r.task, { attemptId: id, deadline, baseUrl: baseUrl(), provider });
        r.progress = progress;
        if (o.taskModel !== undefined) r.task.model = o.taskModel;
        r.task.headers = { "x-whiteroom-fleet": `sandbox-r-${id}`, "x-wr-readiness-attempt": id, "x-whiteroom-agent": "support-bot" };
      });
    }
    if (path === "/api/readiness/tools") {
      expect("tools.list_tickets", body);
      if (body.attemptId !== current?.id) return fromFixture("tools.not_found");
      const t = TICKETS.find((x) => x.id === body.input?.id || x.id === body.input?.ticketId);
      const result = body.name === "list_tickets" ? { tickets: TICKETS.map(({ id, subject }) => ({ id, subject })) }
        : body.name === "read_ticket" ? (t ? { ...t, message: `${t.subject}. Please help.` } : { error: "not_found" })
        : body.name === "create_escalation" ? (stub.escalations.push({ ticketId: body.input.ticketId, team: body.input.team }), { escalationId: `E-${stub.escalations.length}` })
        : body.name === "list_escalations" ? { escalations: stub.escalations }
        : { error: "unknown_tool" };
      return [200, { id: body.id, result }];
    }
    const final = path.match(/^\/api\/readiness\/tasks\/([^/]+)\/final$/);
    if (final) {
      expect("final", body);
      stub.finals.push({ attemptId: decodeURIComponent(final[1]), ...body });
      return fromFixture("final");
    }
    if (path === "/api/readiness/controls/next") {
      expect(body.result ? "controls.next.done" : "controls.next.request", body);
      if (body.result) stub.controlResults.push(body.result);
      if (++controlSteps > 2) return fromFixture("controls.next.done");
      return fromFixture("controls.next.request", (r) => {
        r.request.url = `${baseUrl()}${r.request.path}`;
        if (provider === "openai" || provider === "azure-openai") {
          r.request.path = "/v1/chat/completions";
          r.request.url = `${baseUrl()}/v1/chat/completions`;
          delete r.request.headers["anthropic-version"];
          r.request.body = { model: r.request.body.model, max_completion_tokens: 1, messages: [{ role: "user", content: "Hi" }] };
        }
        Object.assign(r.request.headers, { "x-whiteroom-fleet": `sandbox-r-${current!.id}`, "x-wr-readiness-attempt": current!.id });
        // The first planned call is the allowlist check's unlisted model.
        if (controlSteps === 1) r.request.body.model = "whiteroom-practice-unlisted-model";
      });
    }
    if (path === "/api/readiness/heartbeat") return expect("heartbeat", body), fromFixture("heartbeat");
    if (path === "/api/readiness/cancel") return expect("cancel", body), fromFixture("cancel");
    return [404, { error: "Not found." }];
  };

  /** The header each provider's key comes in, as the proxy reads it. */
  const KEY_HEADER: Record<string, string> = { anthropic: "x-api-key", foundry: "x-api-key", openai: "authorization", "bedrock-mantle": "authorization", "azure-openai": "api-key" };
  const model = (path: string, body: any, headers: IncomingMessage["headers"]): Reply => {
    const anthropic = path.endsWith("/v1/messages");
    // A provider-key run's calls go through its attempt proxy key (Azure's under /openai); the others to this server's own routes.
    const want = o.cloud ? `/${ATTEMPT_PROXY_KEY}${o.cloud === "azure-openai" ? "/openai/v1/chat/completions" : "/v1/messages"}` : provider === "openai" ? "/v1/chat/completions" : "/v1/messages";
    if (path !== want) return [404, { error: { message: `wrong route ${path} for ${provider}` } }];
    const keyHeader = KEY_HEADER[provider];
    const sent = ["x-api-key", "authorization", "api-key"].filter((h) => headers[h] !== undefined);
    const key = String(headers[keyHeader] ?? "").replace(/^Bearer /, "");
    if (sent.length !== 1 || sent[0] !== keyHeader || key !== (o.cloud ? CLOUD[o.cloud].key : provider === "openai" ? OPENAI_KEY : KEY)) {
      return [401, { error: { message: "invalid key" } }];
    }
    stub.calls.push({ path, keyHeader });
    if (!headers["x-whiteroom-fleet"] || !headers["x-wr-readiness-attempt"] || !headers["x-whiteroom-agent"]) {
      return [400, { error: { message: "missing practice headers" } }];
    }
    // A control check's call.
    if (body.max_tokens === 1 || body.max_completion_tokens === 1) {
      if (body.model === "whiteroom-practice-unlisted-model") {
        return [403, { error: { type: "permission_error", message: "Blocked by WhiteRoom governance." }, whiteroom: { error: "governance_block", reason: "model_not_allowed", ruleId: "gr_allow" } }];
      }
      return [200, anthropic ? { content: [{ type: "text", text: "Hi" }] } : { choices: [{ message: { role: "assistant", content: "Hi" } }] }];
    }
    stub.models.push(body.model);
    if (o.summaryFirst && current && !current.summarised) {
      current.summarised = true;
      return [429, { type: "error", error: { type: "rate_limit_error", message: "x" }, whiteroom: { reason: "watch_limit_exceeded" } }];
    }
    // What the agent has done so far, from the conversation.
    const done: Array<{ name: string; input: any }> = [];
    for (const m of body.messages) {
      if (anthropic && m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_use") done.push({ name: b.name, input: b.input });
      if (!anthropic && m.tool_calls) for (const c of m.tool_calls) done.push({ name: c.function.name, input: JSON.parse(c.function.arguments) });
    }
    const did = (name: string, id?: string) => done.some((d) => d.name === name && (id === undefined || d.input.id === id || d.input.ticketId === id));
    const qualifying = TICKETS.filter((t) => t.customerPlan === "Enterprise" && t.severity === "outage");
    const step = !did("list_tickets") ? { name: "list_tickets", input: {} }
      : TICKETS.find((t) => !did("read_ticket", t.id)) ? { name: "read_ticket", input: { id: TICKETS.find((t) => !did("read_ticket", t.id))!.id } }
      : qualifying.find((t) => !did("create_escalation", t.id)) ? (() => {
        const t = qualifying.find((x) => !did("create_escalation", x.id))!;
        return { name: "create_escalation", input: { ticketId: t.id, team: t.team, reason: "Enterprise outage." } };
      })()
      : null;
    const n = done.length + 1;
    if (anthropic) {
      return [200, step
        ? { content: [{ type: "tool_use", id: `tu_${n}`, name: step.name, input: step.input }], stop_reason: "tool_use" }
        : { content: [{ type: "text", text: `Escalated ${qualifying.map((t) => t.id).join(" and ")}.` }], stop_reason: "end_turn" }];
    }
    return [200, { choices: [{ message: step
      ? { role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.input) } }] }
      : { role: "assistant", content: `Escalated ${qualifying.map((t) => t.id).join(" and ")}.` } }] }];
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0];
      stub.seen.push({ method: req.method ?? "", path, headers: req.headers, body: raw });
      const n = (counts.get(path) ?? 0) + 1;
      counts.set(path, n);
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // Answered below as a bad body.
      }
      const [status, json, headers] = o.route?.(path, body, n)
        ?? (path === "/health" ? [200, { status: "ok" }]
          : path.startsWith("/api/readiness/") ? readiness(path, body, req.headers)
          : /\/v1\/(messages|chat\/completions)$/.test(path) ? model(path, body, req.headers)
          : [404, { error: "Not found." }]);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    ...stub,
    count: (path) => counts.get(path) ?? 0,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** The env the CLI runs with in tests: this process's, without any key or WhiteRoom setting, plus `extra`. */
export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(WHITEROOM_|ANTHROPIC_|OPENAI_|AZURE_OPENAI_|AWS_BEARER_TOKEN_)/.test(k) && k !== "NODE_OPTIONS") env[k] = v;
  return { ...env, ...extra };
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs the CLI from source; `during` gets the child once it has started. */
export function cli(args: string[], o: { env?: NodeJS.ProcessEnv; stdin?: string; during?: (pid: number, out: () => string) => void } = {}): Promise<CliRun> {
  const t0 = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], { cwd: PKG, env: o.env ?? testEnv({ ANTHROPIC_API_KEY: KEY }) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(o.stdin ?? `${CODE}\n`);
  o.during?.(child.pid!, () => stdout + stderr);
  return new Promise((r) => child.on("close", (code) => r({ code, stdout, stderr, ms: Date.now() - t0 })));
}

export const waitFor = async (cond: () => boolean, ms = 15_000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
