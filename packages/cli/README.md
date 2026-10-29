# @whiteroom-ai/cli

The `whiteroom` command: practice tests for your agent, plus fleet commands.

## Practice tests

Start a practice test in the dashboard (Sandbox), then run it from your computer with Node 20 or later:

```sh
export ANTHROPIC_API_KEY=...   # the key your agent uses (see the table below)
whiteroom practice run                                   # WhiteRoom's sample agent
whiteroom practice run --adapter "node wr-adapter.mjs"   # your own agent
```

The dashboard shows these commands ready to copy, run with `npx @whiteroom-ai/cli@<version>` so nothing needs installing. To use the `whiteroom` command as above, install it once: `npm install -g @whiteroom-ai/cli`.

Set the one variable for your agent's provider. For Azure OpenAI, Claude on Azure (Foundry) and AWS Bedrock, use the same key you added on Fleet key and picked in the dashboard:

| Provider | Variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` |
| Claude on Azure (Foundry) | `ANTHROPIC_FOUNDRY_API_KEY` |
| AWS Bedrock (a long-term Bedrock API key) | `AWS_BEARER_TOKEN_BEDROCK` |

The CLI asks for the run code from the dashboard (or reads it from stdin with `--code-stdin`), and asks for the key if none of these is set. If more than one is set, it stops and asks you to unset the others. Keep the terminal open until it prints the result. Exit codes: `0` passed, `1` didn't pass, `2` a setup or usage problem, `3` didn't finish (safe to run again). With `--require`, `1` also when a required check isn't Passed in Enforce. macOS and Linux only for now.

### Requiring checks in CI

By default a check that's Not set up, Not checked or only in Watch doesn't fail the test. To insist on some, name them with `--require`:

```sh
whiteroom practice run --adapter "node wr-adapter.mjs" --require spend_cap,keyword
```

Each named check must be Passed, and a guardrail must be in Enforce: Watch, Not checked and Not set up all exit `1`, with a line naming the check. The checks: `finishes_job`, `long_task`, `fails_gracefully`, `spend_cap`, `loop_breaker`, `keyword`, `pause_stop`. An unknown name exits `2`.

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
| CLI → adapter | `{"type":"task","task":"<instructions>","tools":[…],"base_url":"…","headers":{…},"model":"…"}` |
| adapter → CLI | `{"type":"tool_call","id":"<your id>","name":"<tool>","input":{…}}` |
| CLI → adapter | `{"type":"tool_result","id":"<your id>","result":…}` |
| adapter → CLI | `{"type":"final","output":"<your agent's answer>"}` |

- Send model calls to `base_url` with every header in `headers`. For OpenAI SDKs (Azure OpenAI's too) `base_url` already ends in `/v1`. The adapter's environment has the key in the provider's variable from the table above, and no other provider's.
- Send the key as that provider's SDK does: `x-api-key` for Anthropic and Foundry, `Authorization: Bearer` for OpenAI and Bedrock, `api-key` for Azure OpenAI. Azure OpenAI and OpenAI take chat completions (on Azure, `model` is your deployment name); Anthropic, Foundry and Bedrock take Anthropic's Messages API. The starters do this.
- When WhiteRoom answers 429 or 503 with a `whiteroom` field, wait a moment and send the same call again. Let model calls run up to 180 seconds.
- `model` is the model chosen for the practice test in the dashboard, or `null` when none was chosen: then use your agent's own model. The starters do this.
- Write logs to stderr. Lines on stdout that aren't JSON are shown in your terminal and never sent to WhiteRoom.
- Limits: lines up to 1 MiB, tool calls up to 64 KiB, 200 tool calls per practice task. The adapter is stopped (its whole process group) at the task's deadline.

## Running your agent from the Sandbox page

The Sandbox page's **Run agent** button sends a task to a helper on your computer, which runs your agent through your adapter. Point your agent at the Sandbox first (the Sandbox URL from the Sandbox page), then start the helper with the helper code that Run agent shows:

```sh
export ANTHROPIC_BASE_URL=<Sandbox URL>   # or the variable your agent reads its base URL from
whiteroom sandbox listen --adapter "node wr-adapter.mjs"
```

- It asks for the helper code (or reads it from stdin with `--code-stdin`), prints `Helper connected · waiting for tasks from the Sandbox page (Ctrl+C to stop)`, and runs each task as it arrives. A code works once, for 30 minutes.
- The adapter gets the same JSON lines as a practice task. `task` is the prompt typed on the Sandbox page, `tools` is empty, and `base_url` is your Sandbox URL (ending in `/v1` for OpenAI SDKs). Your adapter gets your own environment, with your provider key, minus any `WHITEROOM_` settings. Each task has 10 minutes.
- The Sandbox page sends only the task's text. The command that runs is the one you typed here, and nothing from WhiteRoom is added to it.
- One helper per Sandbox: starting another one stops this one. The Sandbox page can run up to 30 tasks an hour.
- Exit codes: `0` stopped with Ctrl+C, `2` a setup or usage problem, `3` the session ended. If WhiteRoom restarts, the helper stops and asks you to get a new code from Run agent.
