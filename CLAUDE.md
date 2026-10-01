# Claude Code notes

Repo layout, setup and PR checks are in CONTRIBUTING.md. This file adds what
an agent needs that isn't there. `apps/dashboard/CLAUDE.md` loads on top of it
when you work in the dashboard (Next.js 16: read the bundled docs before
writing Next code).

## This repo is public

Everything committed here, including history, is published. gitleaks scans
the full history in the Security workflow, so removing a secret in a later
commit does not clear it.

- Never put real tokens, fleet keys, captured production payloads or customer
  data in fixtures, tests, docs or commit messages. Use obvious placeholders.
- When gitleaks fails, check whether the value is real before suppressing it.
  A `.gitleaksignore` entry is only acceptable once the credential is rotated.
- Dependabot alerts are off, so `npm audit --audit-level=high` in the Security
  workflow is the only vulnerability signal.

## Repo shape

- No root workspace: `apps/dashboard`, `packages/sdk` and `packages/cli` each
  install and build on their own. Run commands from the package directory.
- Because of that, per-package Dependabot `directory:` entries are correct
  here. (The engine repo is the opposite.)
- CI runs typecheck, lint, build and test per package on Node 20 / npm 10.
  Don't regenerate a lockfile with npm 11; CI's `npm ci` can reject it.

## Dashboard database

- Migrations in `apps/dashboard/migrations/` are applied by hand with `psql`;
  there is no runner. Number new files after the highest one on `origin/main`,
  and recheck before merging, since parallel branches collide on numbers.
- The base `users` / `user_fleets` tables have no DDL in this repo, so a fresh
  database can't be built from migrations alone. Ask for the base schema
  rather than guessing column types.
- Local dev: Postgres on port 5433 (matches `.env.example`), with `.env.local`
  in `apps/dashboard`. Leave `AUTH_URL` unset locally.

## Engine boundary

The governance engine lives in a separate private repo. The dashboard talks
to it over HTTP only:

- `src/lib/plans.ts` is the only plan catalogue. The dashboard resolves a plan
  to concrete limits and pushes them to the engine's
  `/internal/entitlements` with `WR_ENTITLEMENT_SYNC_SECRET`. Don't send plan
  names and expect the engine to interpret them.
- From the proxy, 429 means the agent is resting (not a rate limit) and 402
  means a quota refusal. Keep that distinction in any UI or client code.

## Deploying

Merging to `main` does **not** deploy the dashboard; there is no Cloud Build
trigger. Deploy from a clean checkout of `origin/main`, never a working tree
with local changes:

```bash
git worktree add --detach ../dashboard-deploy origin/main && cd ../dashboard-deploy
gcloud builds submit --project whiteroom-prod --config cloudbuild.yaml \
  --substitutions=COMMIT_SHA=$(git rev-parse HEAD) .
```

Before deploying, compare the live revision's image tag with `origin/main` so
you don't roll back something that was deployed from another branch. After,
check the service's `status.traffic`: if traffic is pinned to a revision, the
new one gets 0% until you run
`gcloud run services update-traffic whiteroom-dashboard --to-latest`.

## Pull requests

The maintainer merges PRs themselves, sometimes mid-review. Before pushing
follow-up commits to a PR branch, check `gh pr view <n> --json state`; if it's
merged, open a new PR off main instead.
