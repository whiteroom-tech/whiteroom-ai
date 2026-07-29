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

### 1. Add one line to your .env file
Your existing API key and code stay exactly the same. WhiteRoom intercepts
every call automatically.

If you use Anthropic (Claude):

    ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech

If you use OpenAI (GPT):

    OPENAI_BASE_URL=https://proxy.whiteroom.tech/v1

### 2. Run your agent
Run your agent exactly as before. WhiteRoom auto-registers and starts
governance when your first API call flows through the proxy.

    python my_agent.py    # or node agent.js, etc.

### 3. Link your fleet
Sign in at https://app.whiteroom.tech and enter your API key to connect
your agent's fleet to the dashboard. We only save a secure hash and the last
4 characters — your full key is never stored.

Once linked, the Live Dashboard unlocks — monitor your agents in real time
at https://app.whiteroom.tech/fleet with tasks completed, token savings,
watch progress, and the full audit trail.

For multi-fleet scenarios, pin the fleet with a header:

    x-whiteroom-fleet: <fleet_id>     — assign this agent's traffic to a fleet
    x-whiteroom-agent: <agent_id>     — pin a stable agent identity
