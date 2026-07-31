# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via
[GitHub private vulnerability reporting](https://github.com/whiteroom-tech/whiteroom-ai/security/advisories/new)
or email **security@whiteroom.tech**.

You will receive an acknowledgment confirming receipt, a severity assessment, and updates
as a fix progresses. Credit is given in the release notes unless you request otherwise.

### Response targets

| Severity | Acknowledgment  | Fix target   |
|----------|-----------------|--------------|
| Critical | 24 hours        | 7 days       |
| High     | 48 hours        | 14 days      |
| Medium   | 5 business days | 30 days      |
| Low      | Best effort     | Next release |

## Scope

This repository contains the open-source SDK (`@whiteroom-ai/sdk`), CLI
(`@whiteroom-ai/cli`), and dashboard. The governance engine is maintained separately;
vulnerabilities there are handled under the same reporting process.

### Handling API keys

The WhiteRoom SDK and CLI operate on a **bring-your-own-key** basis — your provider API
keys are sent with each request and are never stored by these clients. When reporting an
issue, **never include real API keys, tokens, or credentials** in issue text, logs, or
reproduction steps. Redact them first.

## Automated security controls

Every push and pull request is scanned by:

- **Secret scanning** — gitleaks over the full git history.
- **Dependency audit** — `npm audit` with a high-severity gate on every package.
- **Dependency review** — blocks pull requests that introduce vulnerable dependencies.
- **CodeQL** — static analysis for JavaScript/TypeScript on push, PR, and weekly.
- **Dependabot** — automated dependency and GitHub Actions update proposals.

For public repositories we also recommend enabling GitHub-native **secret scanning with
push protection** in repository settings as an additional layer.
