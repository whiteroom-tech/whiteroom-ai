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

### 1. Point your agent at WhiteRoom
Add one URL to your agent's environment variables so its API calls flow
through WhiteRoom. No code changes needed — your agent runs exactly as
before, but now with governance.

If you use Anthropic (Claude):

    export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech

If you use OpenAI (GPT):

    export OPENAI_BASE_URL=https://proxy.whiteroom.tech/v1

### 2. Run your agent
Run your agent exactly as before. WhiteRoom auto-registers, auto-pairs, and
starts governance automatically when your first API call flows through the
proxy. No CLI commands needed.

    python my_agent.py    # or node agent.js, etc.

### 3. View your dashboard
Register your LLM key at https://whiteroom.tech to view your fleet — WhiteRoom
stores only a secure hash and the last 4 characters, never your full key. Watch
your agents in real time — tasks completed, token savings, handover history,
and the full audit trail:

    https://app.whiteroom.tech/fleet

If one API key holds multiple fleets, pin the fleet so the dashboard shows the
right one:

    x-whiteroom-fleet: <fleet_id>     — assign this agent's traffic to a fleet
    x-whiteroom-agent: <agent_id>     — pin a stable agent identity
