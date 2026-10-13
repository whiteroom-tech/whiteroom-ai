# WhiteRoom practice test adapter (Python starter, Python 3.9+, standard library only).
# Run it with: whiteroom practice run --adapter "python3 wr_adapter.py"
# The CLI sends one practice task as a JSON line on stdin. You answer with
# {"type":"tool_call",...} lines (each gets a {"type":"tool_result",...} line
# back) and finish with one {"type":"final","output":"..."} line. Print your
# own logs to stderr: stdout is only for these JSON lines.
import json, os, sys, time, urllib.error, urllib.request

ANTHROPIC = bool(os.environ.get("ANTHROPIC_API_KEY"))
MODEL = "claude-haiku-4-5" if ANTHROPIC else "gpt-4o-mini"
BLOCKED = "Stopped: one of my WhiteRoom controls blocked the model call."
calls = 0


def receive():
    line = sys.stdin.readline()
    return json.loads(line) if line else None


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def call_tool(name, args):
    global calls
    calls += 1
    send({"type": "tool_call", "id": f"call-{calls}", "name": name, "input": args})
    return receive()["result"]


def model(base_url, headers, body):
    """One model call through WhiteRoom; None if one of the fleet's controls blocked it.
    Waits and tries again when WhiteRoom or the provider asks it to."""
    url = f"{base_url}/v1/messages" if ANTHROPIC else f"{base_url}/chat/completions"
    auth = ({"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"} if ANTHROPIC
            else {"authorization": "Bearer " + os.environ["OPENAI_API_KEY"]})
    for tries in range(1, 152):
        req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **headers, **auth})
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            try:
                wr = json.load(err).get("whiteroom")
            except Exception:
                wr = None
            if err.code == 503 and wr:
                wait = ("WhiteRoom is switching servers.", float(err.headers.get("retry-after") or 1))
            elif err.code == 429 and wr:
                wait = ("WhiteRoom is saving a summary of your agent's memory.", 2)
            elif err.code == 403 and wr and wr.get("retryable"):
                wait = ("One of your WhiteRoom controls is limiting calls.", 10)
            elif err.code == 403 and wr:
                return None  # Blocked by one of the fleet's controls.
            elif err.code in (429, 500, 502, 503, 529) and not wr and tries < 5:
                wait = ("Your model provider is busy.", 5 * tries)
            else:
                raise RuntimeError(f"The model call failed (HTTP {err.code}).") from None
            print(f"{wait[0]} Waiting {wait[1]:g} s, then trying again.", file=sys.stderr)
            time.sleep(wait[1])
    raise RuntimeError("The model call kept failing.")


# ── Replace this function with a call to your own agent. ────────────────
# It gets the task, the test tools and WhiteRoom's address; it calls tools
# with call_tool(name, input) and returns its final answer as text.
def run_agent(task, tools, base_url, headers):
    messages = [{"role": "user", "content": task}]
    fns = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}} for t in tools]
    for _ in range(40):
        if ANTHROPIC:
            r = model(base_url, headers, {"model": MODEL, "max_tokens": 1024, "tools": tools, "messages": messages})
            if r is None:
                return BLOCKED
            messages.append({"role": "assistant", "content": r["content"]})
            uses = [b for b in r["content"] if b["type"] == "tool_use"]
            if not uses:
                return "\n".join(b["text"] for b in r["content"] if b["type"] == "text")
            messages.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": u["id"], "content": json.dumps(call_tool(u["name"], u["input"]))} for u in uses]})
        else:
            r = model(base_url, headers, {"model": MODEL, "tools": fns, "messages": messages})
            if r is None:
                return BLOCKED
            m = r["choices"][0]["message"]
            messages.append(m)
            if not m.get("tool_calls"):
                return m.get("content") or ""
            for c in m["tool_calls"]:
                result = call_tool(c["function"]["name"], json.loads(c["function"]["arguments"] or "{}"))
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(result)})
    return "Stopped: too many turns."


if __name__ == "__main__":
    try:
        msg = receive()
        if not msg or msg.get("type") != "task":
            raise RuntimeError("Expected a task from the WhiteRoom CLI.")
        send({"type": "final", "output": run_agent(msg["task"], msg["tools"], msg["base_url"], msg["headers"])})
    except Exception as err:
        print(err, file=sys.stderr)
        sys.exit(1)
