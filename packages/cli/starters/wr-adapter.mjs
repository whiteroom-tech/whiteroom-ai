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

const anthropic = !!process.env.ANTHROPIC_API_KEY;
const MODEL = anthropic ? "claude-haiku-4-5" : "gpt-4o-mini";
const BLOCKED = "Stopped: one of my WhiteRoom controls blocked the model call.";

// One model call through WhiteRoom; null if one of the fleet's controls blocked it.
// Waits and tries again when WhiteRoom or the provider asks it to.
async function model(base_url, headers, body) {
  const url = anthropic ? `${base_url}/v1/messages` : `${base_url}/chat/completions`;
  const auth = anthropic
    ? { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  for (let tries = 1; ; tries++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers, ...auth },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    if (res.ok) return res.json();
    const wr = (await res.json().catch(() => null))?.whiteroom;
    const wait = res.status === 503 && wr ? ["WhiteRoom is switching servers.", Number(res.headers.get("retry-after") || 1)]
      : res.status === 429 && wr ? ["WhiteRoom is saving a summary of your agent's memory.", 2]
      : res.status === 403 && wr?.retryable ? ["One of your WhiteRoom controls is limiting calls.", 10]
      : [429, 500, 502, 503, 529].includes(res.status) && !wr && tries < 5 ? ["Your model provider is busy.", 5 * tries] : null;
    if (res.status === 403 && wr && !wait) return null; // Blocked by one of the fleet's controls.
    if (!wait || tries > 150) throw new Error(`The model call failed (HTTP ${res.status}).`);
    console.error(`${wait[0]} Waiting ${wait[1]} s, then trying again.`);
    await sleep(wait[1] * 1000);
  }
}

// ── Replace this function with a call to your own agent. ────────────────
// It gets the task, the test tools and WhiteRoom's address; it calls tools
// with callTool(name, input) and returns its final answer as text.
async function runAgent({ task, tools, base_url, headers }) {
  const messages = [{ role: "user", content: task }];
  const fns = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  for (let turn = 0; turn < 40; turn++) {
    if (anthropic) {
      const r = await model(base_url, headers, { model: MODEL, max_tokens: 1024, tools, messages });
      if (!r) return BLOCKED;
      messages.push({ role: "assistant", content: r.content });
      const uses = r.content.filter((b) => b.type === "tool_use");
      if (!uses.length) return r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const results = [];
      for (const u of uses) results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await callTool(u.name, u.input)) });
      messages.push({ role: "user", content: results });
    } else {
      const r = await model(base_url, headers, { model: MODEL, tools: fns, messages });
      if (!r) return BLOCKED;
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
