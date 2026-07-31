# Contributing to WhiteRoom

Thanks for your interest in contributing! WhiteRoom is the open-source SDK, CLI, and
dashboard for work/rest governance of AI agents. This repo is Apache-2.0 licensed and
community contributions are welcome.

> The governance **engine** itself is maintained in a separate private repository. This
> repo covers the client-facing surface: the TypeScript SDK, the CLI, and the dashboard.

## Repository layout

This is a lightweight monorepo with **no root workspace** — each package installs and
builds independently.

| Path                | Package               | What it is                          |
|---------------------|-----------------------|-------------------------------------|
| `packages/sdk`      | `@whiteroom-ai/sdk`   | TypeScript SDK for the WhiteRoom API |
| `packages/cli`      | `@whiteroom-ai/cli`   | Terminal CLI for managing agent fleets |
| `apps/dashboard`    | `@whiteroom/dashboard`| Next.js dashboard                   |
| `docs`              | —                     | OpenAPI spec and generated docs     |

## Prerequisites

- **Node.js 20+** (matches CI)
- npm

## Getting started

Install and work within the package you're changing. For example, the SDK:

```bash
cd packages/sdk
npm ci
npm run build
npm run typecheck
```

The CLI (installs the published SDK from npm):

```bash
cd packages/cli
npm install
npm run typecheck
npm run build
npm run dev        # run the CLI locally
```

The dashboard:

```bash
cd apps/dashboard
npm ci
cp .env.example .env.local   # fill in your own Supabase / proxy values
npm run dev
npm test
```

## Before you open a PR

CI runs the same checks on every pull request. Run the ones relevant to your change
locally first so review is fast:

- `npm run typecheck` — type checks (SDK, CLI)
- `npm run build` — must compile (all packages)
- `npm test` — unit tests (dashboard; please add tests for new behavior)
- `npm run lint` — where a lint script exists

Security checks also run automatically (see below) — no local setup required.

## Pull request guidelines

1. **Fork** the repo and create a topic branch: `git checkout -b feat/short-description`.
2. Keep PRs focused — one logical change per PR.
3. Write a clear description of **what** changed and **why**. Fill out the PR template.
4. Reference any related issue (`Fixes #123`).
5. Ensure CI is green. Maintainers won't merge red PRs.

### Commit messages

Use short, imperative summaries. Conventional-commit prefixes are appreciated but not
required: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`.

## Continuous integration

Every push and pull request runs:

- **CI** (`.github/workflows/ci.yml`) — install, typecheck, build, and test each package.
- **Security** (`.github/workflows/security.yml`) — gitleaks secret scan, `npm audit`
  (high-severity gate), and dependency review on PRs.
- **CodeQL** (`.github/workflows/codeql.yml`) — static analysis for JavaScript/TypeScript.

Dependency updates are proposed automatically by Dependabot.

> **Note for fork PRs:** GitHub does not expose repository secrets to workflows triggered
> from forks. All CI here is designed to run without secrets, so your PR checks will run
> normally. A maintainer may re-run any check that requires elevated permissions.

## Reporting bugs and requesting features

Use the issue templates. For **security vulnerabilities**, do **not** open a public
issue — follow [SECURITY.md](./SECURITY.md).

## Code of conduct

By participating, you agree to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE).
