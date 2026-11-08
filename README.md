# WhiteRoom

The AI Agents watchkeeper; control risk, save tokens, and improve performance

WhiteRoom sits between your code and the LLM API. Set one environment variable — no SDK required, no code changes.

## Quickstart

1. Sign up at https://app.whiteroom.tech.
2. Open Sandbox, copy its line into your .env and run your agent.
   Or from a terminal: `npx @whiteroom-ai/cli sandbox run --provider anthropic -- python agent.py`
3. Connect: copy your line from the Fleet key page.

Your line looks like this:

```bash
# Anthropic
export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech/<your-proxy-key>

# OpenAI
export OPENAI_BASE_URL=https://proxy.whiteroom.tech/<your-proxy-key>/v1
```

Your existing agent framework runs unchanged. WhiteRoom intercepts calls, applies governance, and forwards to the LLM.

## SDK

```bash
npm install @whiteroom-ai/sdk
```

```typescript
import { WhiteRoomClient } from "@whiteroom-ai/sdk";

const wr = new WhiteRoomClient({
  baseUrl: "https://proxy.whiteroom.tech",
  apiKey: process.env.WHITEROOM_API_KEY!,
});

await wr.registerAgent("agent-1", "default");
await wr.startWatch("agent-1");
const status = await wr.checkWatch("agent-1");
```

## CLI

```bash
npm install -g @whiteroom-ai/cli

# Or use npx
npx @whiteroom-ai/cli health --url https://proxy.whiteroom.tech
npx @whiteroom-ai/cli register --url https://proxy.whiteroom.tech --key $API_KEY agent-1
npx @whiteroom-ai/cli start --url https://proxy.whiteroom.tech --key $API_KEY agent-1
npx @whiteroom-ai/cli check --url https://proxy.whiteroom.tech --key $API_KEY agent-1
npx @whiteroom-ai/cli report --url https://proxy.whiteroom.tech --key $API_KEY
```

Set `WHITEROOM_URL` and `WHITEROOM_API_KEY` environment variables to skip the flags.

## What it does

- **Watch cycles** — bounded work sessions with automatic enforcement
- **Handovers** — structured context transfer between agents
- **Audit trail** — tamper-evident log of all governance events
- **Fleet management** — register, pair, and monitor agent groups
- **Provider-agnostic** — works with Anthropic, OpenAI, LangChain, CrewAI

## Architecture

```
Open layer (this repo, Apache 2.0):   SDK  |  CLI  |  Types
The contract (API spec):              POST /v1/messages · POST /v1/chat/completions · POST /api/white-room
Governance engine (hosted):           proxy.whiteroom.tech
```

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `@whiteroom-ai/sdk` | [![npm](https://img.shields.io/npm/v/@whiteroom-ai/sdk)](https://www.npmjs.com/package/@whiteroom-ai/sdk) | TypeScript client for the WhiteRoom API |
| `@whiteroom-ai/cli` | [![npm](https://img.shields.io/npm/v/@whiteroom-ai/cli)](https://www.npmjs.com/package/@whiteroom-ai/cli) | Terminal-based fleet management |

## Links

- [Documentation](https://whiteroom.tech/docs.html)
- [API Reference (OpenAPI)](https://whiteroom.tech/openapi.yaml)
- [Website](https://whiteroom.tech)

## License

Apache 2.0 — see [LICENSE](LICENSE).
