# WhiteRoom

Know what your agent did — a tamper-evident audit trail and real token
savings for long-running LLM agents.

## Web address
https://whiteroom.tech

## Endpoints
- `POST https://proxy.whiteroom.tech/v1/messages` — Anthropic format
- `POST https://proxy.whiteroom.tech/v1/chat/completions` — OpenAI format
- `GET https://proxy.whiteroom.tech/health` — health check

## How to use it

### 1. Sign in & get your proxy URL
Sign in at https://app.whiteroom.tech, register your LLM API key, and copy
your personalized proxy URL. We never store the full key — only a secure
hash and the last 4 characters.

### 2. Run your agent
Set one env variable, then run as normal. Your code stays exactly the same.

If you use Anthropic (Claude):

    export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech/sk-wr-xxxxx

If you use OpenAI (GPT):

    export OPENAI_BASE_URL=https://proxy.whiteroom.tech/sk-wr-xxxxx/v1

Then run your agent:

    python my_agent.py    # or node agent.js, etc.

WhiteRoom auto-registers your agent and starts governance on the first API
call. No CLI commands needed.

### 3. Watch your fleet
Open https://app.whiteroom.tech/fleet to monitor your agents in real time —
tasks completed, token savings, watch progress, and the full audit trail.

If one API key runs multiple fleets, pin the fleet with a header:

    x-whiteroom-fleet: <fleet_id>     — assign this agent's traffic to a fleet
    x-whiteroom-agent: <agent_id>     — pin a stable agent identity
