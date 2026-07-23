# WhiteRoom

Know what your agent did — a tamper-evident audit trail and real token
savings for long-running LLM agents.

## Web address
https://whiteroom.tech

## How to use it
Point your agent's LLM client at WhiteRoom instead of the provider directly:

1. Get a WhiteRoom API key at https://whiteroom.tech
2. Set your client's `base_url` to `https://proxy.whiteroom.tech`
3. Use your WhiteRoom key as the `api_key`.
4. No other changes needed — WhiteRoom speaks the same request/response
   format as the underlying provider.
