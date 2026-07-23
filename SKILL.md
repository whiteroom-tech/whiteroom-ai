# WhiteRoom

Know what your agent did — a tamper-evident audit trail and real token
savings for long-running LLM agents.

## Web address
https://whiteroom.tech

## Endpoints
https://proxy.whiteroom.tech

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
Watch your agents in real time — tasks completed, token savings, handover
history, and the full audit trail. Sign in with your WhiteRoom key (shown
below the setup steps at https://whiteroom.tech):

    https://app.whiteroom.tech/fleet
