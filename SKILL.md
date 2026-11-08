# WhiteRoom

Know what your agent did — a tamper-evident audit trail and real token
savings for long-running LLM agents.

## Web address
https://whiteroom.tech

## Endpoints
- `POST https://proxy.whiteroom.tech/<your-proxy-key>/v1/messages` — Anthropic format
- `POST https://proxy.whiteroom.tech/<your-proxy-key>/v1/chat/completions` — OpenAI format
- `GET https://proxy.whiteroom.tech/health` — health check

## How to use it

### 1. Add one line to your environment variable
Sign up at https://app.whiteroom.tech, then copy your line from the Fleet
key page into your .env file, your shell, or wherever you configure env
vars. Your existing API key and code stay exactly the same.

If you use Anthropic (Claude):

    ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech/<your-proxy-key>

If you use OpenAI (GPT):

    OPENAI_BASE_URL=https://proxy.whiteroom.tech/<your-proxy-key>/v1

### 2. Run your agent
Run your agent exactly as before. WhiteRoom auto-registers and starts
governance when your first API call flows through the proxy.

    python my_agent.py    # or node agent.js, etc.

### 3. Watch it in the dashboard
Your agent appears on Home at https://app.whiteroom.tech on its first call,
with token savings and the full audit trail.

To give an agent a stable name, send a header:

    x-whiteroom-agent: <agent_id>
