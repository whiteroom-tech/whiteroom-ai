# @whiteroom-ai/cli

The `whiteroom` command: practice tests for your agent, plus fleet commands.

## Practice tests

Start a practice test in the dashboard (Sandbox), then run it from your computer with Node 20 or later:

```sh
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY: the key your agent uses
whiteroom practice run                                   # WhiteRoom's sample agent
whiteroom practice run --adapter "node wr-adapter.mjs"   # your own agent
```

The CLI asks for the run code from the dashboard (or reads it from stdin with `--code-stdin`), and asks for the key if neither variable is set. Keep the terminal open until it prints the result. Exit codes: `0` passed, `1` didn't pass, `2` a setup or usage problem, `3` didn't finish (safe to run again). macOS and Linux only in this beta.

Practice tasks use made-up records and WhiteRoom's test tools, not your agent's real job. Use the result to help decide, not as a certificate.

## Connecting your own agent

Print a starter adapter, replace its marked function with a call to your agent, and pass the command that runs it:

```sh
whiteroom practice adapter --lang js > wr-adapter.mjs       # Node, no dependencies
whiteroom practice adapter --lang python > wr_adapter.py    # Python, standard library only
```

The CLI starts the adapter once per practice task and talks to it in JSON lines:

| Direction | Line |
|---|---|
| CLI → adapter | `{"type":"task","task":"<instructions>","tools":[…],"base_url":"…","headers":{…}}` |
| adapter → CLI | `{"type":"tool_call","id":"<your id>","name":"<tool>","input":{…}}` |
| CLI → adapter | `{"type":"tool_result","id":"<your id>","result":…}` |
| adapter → CLI | `{"type":"final","output":"<your agent's answer>"}` |

- Send model calls to `base_url` with every header in `headers`. For OpenAI SDKs `base_url` already ends in `/v1`. The key is in `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the adapter's environment.
- When WhiteRoom answers 429 or 503 with a `whiteroom` field, wait a moment and send the same call again. Let model calls run up to 180 seconds.
- Write logs to stderr. Lines on stdout that aren't JSON are shown in your terminal and never sent to WhiteRoom.
- Limits: lines up to 1 MiB, tool calls up to 64 KiB, 200 tool calls per practice task. The adapter is stopped (its whole process group) at the task's deadline.
