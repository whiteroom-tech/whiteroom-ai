// WhiteRoom practice test adapter (JavaScript starter, Node 20+, no dependencies).
// Run it with: whiteroom practice run --adapter "node wr-adapter.mjs"
// The CLI sends one practice task as a JSON line on stdin. You answer with
// {"type":"tool_call",...} lines (each gets a {"type":"tool_result",...} line
// back) and finish with one {"type":"final","output":"..."} line. Print your
// own logs to stderr: stdout is only for these JSON lines.
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const receive = async () => JSON.parse((await lines.next()).value ?? "null");
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function callTool(name, input) {
  const id = `call-${++calls}`;
  send({ type: "tool_call", id, name, input });
  return (await receive()).result;
}

// The CLI sets only the variable of the provider the practice test uses.
// It decides the API: chat completions for OpenAI and Azure OpenAI (where the
// model is your deployment name), Anthropic's Messages API for Anthropic,
// Claude on Azure (Foundry) and AWS Bedrock. And the header the key goes in.
const KEYS = {
  ANTHROPIC_API_KEY: (k) => ({ "x-api-key": k }),
  ANTHROPIC_FOUNDRY_API_KEY: (k) => ({ "x-api-key": k }),
  AWS_BEARER_TOKEN_BEDROCK: (k) => ({ authorization: `Bearer ${k}` }),
  OPENAI_API_KEY: (k) => ({ authorization: `Bearer ${k}` }),
  AZURE_OPENAI_API_KEY: (k) => ({ "api-key": k }),
};
const KEY_VAR = Object.keys(KEYS).find((v) => process.env[v]) ?? "ANTHROPIC_API_KEY";
const anthropic = !["OPENAI_API_KEY", "AZURE_OPENAI_API_KEY"].includes(KEY_VAR);
// The model to use when the practice task doesn't name one (cloud providers always name one).
const DEFAULT_MODEL = anthropic ? "claude-haiku-4-5" : "gpt-4o-mini";
const BLOCKED = "Stopped: one of my WhiteRoom controls blocked the model call.";
const GONE = "Stopped: WhiteRoom closed this practice task.";

// One model call through WhiteRoom; a final answer (text) if WhiteRoom stopped it.
// Never follows a redirect, so the key only goes to WhiteRoom.
// Waits and tries again when WhiteRoom or the provider asks it to, saying why once per wait.
async function model(base_url, headers, body) {
  const url = anthropic ? `${base_url}/v1/messages` : `${base_url}/chat/completions`;
  const auth = { ...KEYS[KEY_VAR](process.env[KEY_VAR] ?? ""), ...(anthropic && { "anthropic-version": "2023-06-01" }) };
  let said = null;
  for (let tries = 1; ; tries++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers, ...auth },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(180_000) });
    if (res.ok) return res.json();
    const wr = (await res.json().catch(() => null))?.whiteroom;
    const wait = res.status === 503 && wr ? ["WhiteRoom is switching servers. Waiting, then trying again.", Number(res.headers.get("retry-after") || 1)]
      : res.status === 429 && wr ? ["WhiteRoom is saving a summary of your agent's memory. Waiting until it's saved.", 2]
      : res.status === 403 && wr?.retryable ? ["One of your WhiteRoom controls is limiting calls. Waiting, then trying again.", 10]
      : [429, 500, 502, 503, 529].includes(res.status) && !wr && tries < 5 ? ["Your model provider is busy. Waiting, then trying again.", 5 * tries] : null;
    if (res.status === 403 && wr && !wait) return BLOCKED; // Blocked by one of the fleet's controls.
    if (res.status === 410) return GONE; // The practice task's fleet is gone: WhiteRoom reran or ended it.
    if (!wait || tries > 150) throw new Error(`The model call failed (HTTP ${res.status}).`);
    if (wait[0] !== said) console.error((said = wait[0]));
    await sleep(wait[1] * 1000);
  }
}

// ── Replace this function with a call to your own agent. ────────────────
// It gets the task, the test tools, WhiteRoom's address and the model your
// dashboard chose (null: use your own); it calls tools with
// callTool(name, input) and returns its final answer as text.
async function runAgent({ task, tools, base_url, headers, model: chosen }) {
  const MODEL = chosen || DEFAULT_MODEL;
  const messages = [{ role: "user", content: task }];
  const fns = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  for (let turn = 0; turn < 40; turn++) {
    if (anthropic) {
      const r = await model(base_url, headers, { model: MODEL, max_tokens: 1024, tools, messages });
      if (typeof r === "string") return r;
      messages.push({ role: "assistant", content: r.content });
      const uses = r.content.filter((b) => b.type === "tool_use");
      if (!uses.length) return r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const results = [];
      for (const u of uses) results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await callTool(u.name, u.input)) });
      messages.push({ role: "user", content: results });
    } else {
      const r = await model(base_url, headers, { model: MODEL, tools: fns, messages });
      if (typeof r === "string") return r;
      const m = r.choices[0].message;
      messages.push(m);
      if (!m.tool_calls?.length) return m.content ?? "";
      for (const c of m.tool_calls) {
        const result = await callTool(c.function.name, JSON.parse(c.function.arguments || "{}"));
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) });
      }
    }
  }
  return "Stopped: too many turns.";
}

try {
  const msg = await receive();
  if (msg?.type !== "task") throw new Error("Expected a task from the WhiteRoom CLI.");
  send({ type: "final", output: await runAgent(msg) });
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
