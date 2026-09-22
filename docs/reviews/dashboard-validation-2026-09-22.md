# Dashboard hardening validation

22 September 2026. Companion to [the security report](dashboard-security-2026-09-22.md).

- **Baseline:** 112 tests; 111 passed and one failed because a UTC assertion contradicted local-date behavior.
- **Final suite:** 141 tests passed across 15 files in the default local timezone. A second run with `TZ=UTC` also passed all 141 tests. This adds 29 tests to the baseline, including ownership failures, session revocation/outage behavior, canonical origins, analytics redaction, origin checks and daylight-saving boundaries.
- **TypeScript:** `npm run typecheck` passed. The production build's independent TypeScript phase also passed.
- **Production build:** `NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack` passed compilation, type checking, page generation and build tracing. No build configuration was changed to switch bundlers permanently.
- **Default build limitation:** `npm run build` with Turbopack failed when CSS processing attempted an internal port bind and received `Operation not permitted`. Retrying with elevated execution permission produced the same environment error. The default build remains unverified in an unrestricted environment.
- **Headers:** inspected the generated Next.js routes manifest and confirmed that all five configured security headers apply to `/:path*`. This verifies build configuration, not live ingress responses.
- **Diff hygiene:** `git diff --check` passed.
- **Dependency advisory audit:** not completed. The initial request could not resolve the npm registry. Automatic approval review rejected the network-enabled attempt because the audit transmits dependency names and versions to the public registry. Explicit approval was requested and has not been received. No alternative route was used to transmit the inventory.
- **Not run:** real PostgreSQL concurrency tests, Stripe event replay, live engine authorization tests, email delivery, browser authentication flows, Docker image build/runtime smoke tests and production penetration testing.

Changes are local, uncommitted and undeployed. No database migrations were applied. No actual historical fleet credential was tested or rotated.
