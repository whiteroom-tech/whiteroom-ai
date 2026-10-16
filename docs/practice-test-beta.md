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

- [x] Engine: `WR_READINESS=on` only where the beta runs, with `WHITEROOM_KEY_PEPPER` and `WR_DASHBOARD_SERVICE_SECRET` set. The dashboard shows practice tests only when the engine's `/api/readiness/runs` answers, so with the flag off nothing appears.
- [x] Dashboard: `WR_DASHBOARD_SERVICE_SECRET` set (the BFF answers 503 without it).
- [x] CLI: `packages/cli/package.json` is `2.0.0`. For an invite, `npm run build && npm pack` in `packages/cli`, and send `whiteroom-ai-cli-2.0.0.tgz` and the output of `shasum -a 256` on it with the invite note.
- [x] `CLI_VERSION` in `apps/dashboard/src/lib/sandbox/practice/model.ts` equals the CLI's version.

**Public launch (D2, D12)**

- [x] Publish the CLI from a clean checkout of `main` at the bump commit, logged in to npm as an owner of `@whiteroom-ai`:
  ```sh
  cd packages/cli && npm install && npm test && npm publish --access public
  ```
  Then `npm view @whiteroom-ai/cli version` prints `2.0.0`. `prepublishOnly` builds `dist` first, so the package never ships a stale build. (Provenance needs a publish from CI; add a release workflow before the next version.) The practice commands load no runtime dependencies; the fleet commands load `@whiteroom-ai/sdk`.
- Published Oct 14 2026 from the npm account `whiteroomtech` (2FA on: `npm publish` asks for a code from its authenticator, or a browser approval).
- [x] Only after `npm view` shows `2.0.0`: in `model.ts`, set `CLI_ON_NPM = true` (its own PR). The dashboard then shows `npx @whiteroom-ai/cli@2.0.0 practice …` and drops the install step and sha256 note (PR #239).
- [x] Promote that dashboard to prod after checking it on staging (b72944c, prod Oct 14 2026).
- Ongoing: bump `CLI_VERSION` together with every later CLI release.
- [x] `WR_READINESS` on in production (owner sign-off, Oct 13 2026).
