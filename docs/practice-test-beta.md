# Practice tests: invite-only beta

Practice tests (Sandbox › Practice test) run an agent through 5 practice tasks
and a check of its fleet's controls. Until the CLI is on npm (D2), they are an
invite-only beta: invited owners install a packed CLI build.

## Invite note (send with the `.tgz` and its sha256)

> You're invited to try WhiteRoom practice tests.
>
> 1. Save the attached `whiteroom-ai-cli-2.0.0.tgz` on the computer where your agent runs (macOS or Linux, Node 20 or later).
> 2. Check it: `shasum -a 256 whiteroom-ai-cli-2.0.0.tgz` must print `<sha256>`. If it doesn't, don't install it; tell us.
> 3. Install it: `npm install -g ./whiteroom-ai-cli-2.0.0.tgz`
> 4. In the dashboard, open Sandbox › Set up a practice test, pick who runs it and click Start test. Follow the steps it shows.
>
> Tests run on your agent's own model key: the dashboard shows the usual cost and the most calls a test can make before you start. Practice tasks use made-up records and WhiteRoom's test tools, not your agent's real job. Use the result to help decide, not as a certificate.

## Owner launch checklist

**Beta (now)**

- [ ] Engine: `WR_READINESS=on` only where the beta runs, with `WHITEROOM_KEY_PEPPER` and `WR_DASHBOARD_SERVICE_SECRET` set. The dashboard shows practice tests only when the engine's `/api/readiness/runs` answers, so with the flag off nothing appears.
- [ ] Dashboard: `WR_DASHBOARD_SERVICE_SECRET` set (the BFF answers 503 without it).
- [ ] CLI: set `packages/cli/package.json` `version` to `2.0.0`, then `npm run build && npm pack` in `packages/cli`. Send `whiteroom-ai-cli-2.0.0.tgz` and the output of `shasum -a 256` on it with the invite note.
- [ ] Keep `CLI_VERSION` in `apps/dashboard/src/lib/sandbox/practice/model.ts` equal to the packed version: the dashboard names that file.

**Public launch (D2, D12)**

- [ ] Publish the CLI with provenance: `npm publish --provenance --access public` from CI for `@whiteroom-ai/cli@2.0.0` (zero runtime dependencies for the practice commands).
- [ ] In `model.ts`, set `CLI_ON_NPM = true`: the dashboard then shows `npx @whiteroom-ai/cli@2.0.0 practice …` and drops the install step and sha256 note.
- [ ] Bump `CLI_VERSION` together with every later CLI release.
- [ ] Turn `WR_READINESS` on in production only with separate sign-off (spec §13).
