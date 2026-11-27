# @whiteroom-ai/sdk

TypeScript client for the WhiteRoom API, and a `fetch` for model SDKs that decides what happens when WhiteRoom can't be reached.

## If WhiteRoom is down: fail open or fail closed

By default your agent's calls wait for WhiteRoom (fail closed). To send them straight to the model provider instead (fail open), pass `whiteroomFetch` as the `fetch` option of your model SDK:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { whiteroomFetch } from "@whiteroom-ai/sdk";

const client = new Anthropic({
  baseURL: "https://proxy.whiteroom.tech",
  fetch: whiteroomFetch({
    failOpen: true,
    providerBaseUrl: "https://api.anthropic.com",
    onFailOpen: ({ reason }) => console.warn(`WhiteRoom unreachable (${reason}); sent direct`),
  }),
});
```

For OpenAI, use `baseURL: "https://proxy.whiteroom.tech/v1"`, `whiteroomBaseUrl: "https://proxy.whiteroom.tech/v1"` and `providerBaseUrl: "https://api.openai.com/v1"`.

A call goes direct only when WhiteRoom can't be reached: the connection fails, or a 503 comes back that WhiteRoom didn't send. Anything WhiteRoom answers is passed back unchanged, including a block, a rest (429), a quota refusal (402), and a 503 when rules couldn't be checked. Failing open never gets around a rule WhiteRoom can enforce.

502 and 504 are passed back, not resent: WhiteRoom may already have sent the call to the provider, and sending it again would run it twice. A connection that drops mid-call carries the same small risk. To also fail open when WhiteRoom is slow, set `whiteroomTimeoutMs`; it's off by default for the same reason.

A call sent direct isn't governed or recorded by WhiteRoom. Use `onFailOpen` to log each one.
