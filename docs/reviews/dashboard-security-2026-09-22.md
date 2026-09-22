# WhiteRoom dashboard: security and robustness review

Reviewed 22 September 2026. Repository: `whiteroom-ai`, baseline commit `7ca3bc1`. Scope: `apps/dashboard`, its migrations, container configuration and CI. Changes are local and uncommitted; no deployment or production data changes were performed.

## Assessment

**The dashboard is materially safer after this hardening pass, but billing recovery and fleet entitlement consistency remain release risks.** Server-side ownership verification was missing at fleet-linking and provisioning boundaries. Those boundaries are now checked against the engine before any persistence or entitlement synchronization. Additional changes protect session revocation, credentials, confirmation links, analytics, database connections and HTTP responses.

Do not interpret this report as a penetration-test certification. Findings below come from source review and local regression tests. Production ingress, database constraints as actually deployed, Stripe configuration, engine behavior and real browser flows were not exercised.

There are two checkouts in the parent directory. This review targets the fuller dashboard in `whiteroom-ai`. The `whiteroom-ai-whiteroom` checkout was inspected only to distinguish scope and cross-check the token-login response contract; it was not hardened. A pre-existing edit to `apps/dashboard/next-env.d.ts` was preserved.

## Changes implemented

### 1. High: fleet ownership trusted browser input

Previously, `addUserFleet` and `upsertUserProvisioning` accepted an arbitrary fleet ID and stored it under the signed-in user. `syncEntitlementsToEngine` then used that ID with a privileged synchronization secret. A caller could therefore nominate a fleet they did not control for entitlement changes. Authentication alone did not establish ownership. This is a source-confirmed authorization defect; no live exploit was attempted.

**Fixed:** a server-only `verifyFleetOwnership` helper calls the engine's existing `token_login` operation, requires successful verification and an exact fleet-ID match, disallows redirects, bounds the request time and returns only a generic failure. Both write paths invoke it before storing data. Provisioning additionally rejects non-dashboard key formats so ordinary provider keys cannot accidentally enter that persistence path. Tests assert that a mismatched token cannot write or synchronize entitlements.

Evidence: [ownership helper](../../apps/dashboard/src/lib/fleet-ownership.ts), [fleet actions](../../apps/dashboard/src/lib/user-fleets.ts), [provisioning actions](../../apps/dashboard/src/lib/users.ts).

**Residual:** possession of a fleet token proves control, not exclusive billing ownership. Quotas and replacement/revocation still need the transactional design described below. The token-login endpoint returns a report along with identity; a minimal authenticated introspection endpoint would be more efficient.

### 2. High: provisioning credentials used non-cryptographic randomness

The dashboard generated a credential with `Math.random()`. It now uses 32 bytes from Web Crypto and hex encoding. Existing credentials are unchanged; rotation is a separate operation. Regression validation includes compilation; entropy quality comes from the platform CSPRNG, not a statistical test.

Evidence: [dashboard provisioning](../../apps/dashboard/src/app/dashboard/page.tsx).

### 3. High: analytics could collect token-bearing URLs and credential screens

Analytics initialized in the root layout, including magic-link and email-confirmation pages whose URLs contain live tokens. The initializer had no local privacy controls. This creates a credible disclosure path through analytics defaults; historical collection was not verified.

**Fixed:** disabled automatic pageviews, page-leave events, DOM autocapture and session recording; changed analytics persistence to memory; added a send filter that drops events on sign-in/verification pages and removes URL queries/fragments and credential-named properties from event objects. Existing explicit business events still work. This changes analytics coverage and anonymous identity continuity across reloads intentionally.

Evidence: [analytics initialization and filter](../../apps/dashboard/src/lib/analytics.ts), [root layout](../../apps/dashboard/src/app/layout.tsx), [privacy regression test](../../apps/dashboard/src/__tests__/analytics-privacy.test.ts).

**Follow-up:** inspect historical analytics under normal access controls for token-bearing URLs; expire any still-valid credentials found. Treat the filter as defense in depth, not permission to send arbitrary secret-bearing payloads to telemetry.

### 4. High: session revocation failed open during database outages

The JWT callback returned an existing token when its scheduled revocation lookup failed. Revocation could consequently exceed the documented five-minute window until recovery or expiry.

**Fixed:** after revalidation becomes due, a database failure rejects the session. The normal five-minute cached validation window remains. Tests cover database outage, account deletion, revocation and successful revalidation.

Evidence: [authentication callback](../../apps/dashboard/src/auth.ts), [session tests](../../apps/dashboard/src/__tests__/session-security.test.ts).

**Operational tradeoff:** a database outage can now sign users out when their revalidation becomes due. Account sessions and independent engine fleet tokens have different lifecycles; signing out does not revoke a fleet token.

### 5. Medium: outgoing confirmation and billing URLs trusted request hosts

Account email-change links and Stripe return URLs fell back to forwarded host/protocol headers when `AUTH_URL` was absent. Exploitability depends on ingress header sanitization.

**Fixed:** both use one server-only application-origin function. It accepts HTTPS configuration, permits HTTP loopback only outside production and otherwise uses `https://app.whiteroom.tech`. Request headers cannot choose these destinations. Set `AUTH_URL` explicitly for staging and non-default domains.

Evidence: [trusted origin](../../apps/dashboard/src/lib/app-origin.ts), [account](../../apps/dashboard/src/lib/account.ts), [billing](../../apps/dashboard/src/lib/billing.ts).

Auth.js still uses `trustHost: true`; its OAuth/magic-link host behavior and admin-host routing require a verified trusted ingress configuration.

### 6. Medium: error messages could disclose internals

Several account, billing and admin actions returned raw exception messages. Resend response bodies and some engine/Stripe exceptions were logged verbatim.

**Fixed:** these reviewed paths now return stable public messages or log bounded status/context without raw upstream bodies. Failed email delivery deletes only its own matching request token, avoiding deletion of a newer concurrent request. This is targeted redaction, not a whole-system logging audit. Structured correlation IDs and redacted operational diagnostics remain recommended.

### 7. Medium: header configuration did not apply to the documented runtime

`public/_headers` contains a static-host policy, but the Dockerfile starts a standalone Next.js server. Next.js does not apply that file as its response-header configuration.

**Fixed:** `next.config.ts` now sets frame denial, MIME sniffing protection, no-referrer, restricted browser permissions and a baseline CSP that blocks framing, object embeds and foreign base URLs. It also removes the framework identification header.

**Residual:** this baseline is deliberately not a complete script-execution CSP. Add a nonce-based policy after inventorying Next.js inline scripts, Google Fonts and analytics. Validate TLS/HSTS at the actual ingress. Existing edge policies may provide additional protections; they were not inspected.

### 8. Medium: unbounded waits and idle database errors

The database pool had no connection acquisition deadline, statement deadline or idle-connection error handler. Several external requests had no deadline.

**Fixed:** added a five-second pool connection deadline, fifteen-second database statement and idle-transaction deadlines, an idle-socket error handler, and bounded engine/email requests with redirect refusal on credential-bearing paths. The dashboard provisioning UI now exits its loading state with a recoverable message on an unexpected failure.

Evidence: [database pool](../../apps/dashboard/src/lib/db.ts), [engine client](../../apps/dashboard/src/lib/whiteroom/client.ts), [email client](../../apps/dashboard/src/lib/email.ts), [entitlement client](../../apps/dashboard/src/lib/entitlements.ts).

### 9. Medium: origin checks compared only host names

Sandbox mutation checks previously accepted an insecure or non-HTTP URL with a matching host. They now require a serialized HTTPS origin, with a development-only loopback HTTP exception. Tests cover hostile hosts, absent origins, credentials in URLs and insecure schemes.

Evidence: [sandbox authorization](../../apps/dashboard/src/lib/sandbox/auth.ts).

### 10. Medium: runtime container used root

The runner now copies application files with ownership for the image's existing `node` account and runs as that account. A container build/runtime smoke test is still required; the local Next.js build does not validate container permissions.

Evidence: [Dockerfile](../../apps/dashboard/Dockerfile).

### 11. Low: analytics tests and calendar arithmetic disagreed

The initial suite had 111 passing tests and one failure: a test expected UTC dates while the implementation intentionally displays local dates. Tests now use local date boundaries. Range subtraction now uses calendar dates instead of fixed 24-hour durations, with explicit daylight-saving regression tests. The dashboard also has an explicit `typecheck` script so the existing CI step no longer silently skips it.

### 12. Credential hygiene: captured token in a fixture

A provisioning test described its token as a verbatim production response. Replaced that token and its associated fleet identifier with synthetic fixtures. The token was not used or checked against production. **An authorized operator should determine whether the historical token remains valid and rotate it if necessary.** Editing the current file does not remove it from prior Git commits or copies.

## Remaining findings and priorities

### R1 — High: payment events can be lost or applied out of order

Evidence: [webhook handler](../../apps/dashboard/src/app/api/stripe/webhook/route.ts), especially the claim insert before `handle`, and direct application of subscription event snapshots; [event schema](../../apps/dashboard/migrations/003_billing.sql).

If the process dies after inserting an event claim but before handling it, the retry is treated as a completed duplicate. Concurrent deliveries can also see a claim before the first handler succeeds. Older subscription snapshots can overwrite newer state, and a late event for a replaced subscription can overwrite the user's single subscription row. Removing claims in a caught exception does not handle process termination.

**Recommendation:** use a durable webhook inbox with explicit pending/processing/completed states and recoverable leases; serialize processing by billing owner; reconcile the current Stripe subscription; commit subscription state and an entitlement-outbox record atomically. Acknowledge only durable receipt. Avoid relying solely on timestamps as a complete ordering solution.

**Acceptance:** kill a worker after claim, deliver duplicates concurrently, reverse event order and replace a subscription; the eventual local state must match Stripe exactly without dropping work. Stripe explicitly documents duplicate and unordered delivery in its [webhook guidance](https://docs.stripe.com/webhooks).

### R2 — High: account deletion does not cancel paid billing

Evidence: [deleteAccount](../../apps/dashboard/src/lib/account.ts) deletes the local subscription and user without invoking Stripe cancellation or checking active paid status. Its comment intentionally preserves engine fleets, but that does not settle the billing lifecycle.

**Impact:** an account can disappear while its external recurring subscription continues. Later webhooks may reference a deleted user and fail to apply.

**Recommendation:** choose and implement an explicit deletion policy: require subscription cancellation first, or execute an idempotent cancellation-and-deletion workflow. Preserve only the billing tombstone needed for reconciliation and the chosen retention requirements. Engine fleet retention should be a separate, visible choice.

**Acceptance:** deletion of a paying account cannot leave unintended future charges or an unrecoverable webhook loop. Inject a Stripe outage between cancellation and database deletion and verify safe retry.

### R3 — High: entitlement synchronization is lossy

Evidence: [sync and revoke](../../apps/dashboard/src/lib/entitlements.ts), [unlink](../../apps/dashboard/src/lib/user-fleets.ts), [admin resync](../../apps/dashboard/src/lib/admin-actions.ts).

Engine synchronization failures are logged and swallowed. No durable retry is created. Unlink deletes the fleet mapping before revocation succeeds, losing the natural retry source. A restart reloading the engine's old data cannot reconstruct a dashboard update it never received. Manual resync can report success despite a failed push.

**Recommendation:** write a versioned desired entitlement plus an outbox entry in the same database transaction as the account/billing mutation. Use a retrying worker with idempotent engine writes and a periodic reconciliation job. Expose pending/failed synchronization to admins. Keep revocation tombstones until acknowledged.

**Acceptance:** take the engine offline during a downgrade, unlink and upgrade; restore it and verify convergence without another user action. Older retry attempts must not overwrite newer desired state.

### R4 — High: quota and primary-fleet changes are not atomic

Evidence: [addUserFleet](../../apps/dashboard/src/lib/user-fleets.ts) checks capacity separately from insertion; [upsertUserProvisioning](../../apps/dashboard/src/lib/users.ts) can replace the primary fleet without revoking its predecessor or applying the same quota rule.

**Impact:** simultaneous requests can pass the same quota check. Repeated primary-fleet replacements can leave previously entitled fleets behind. Unlinking a fleet that remains the user's primary fleet can also downgrade a still-owned fleet. Multiple users presenting the same bearer token need an explicit ownership/entitlement policy.

**Recommendation:** normalize primary and linked fleets into one membership model, designate the billing owner, lock the account while checking and mutating its membership, enforce database uniqueness, and enqueue old/new entitlement reconciliation atomically. Until that exists, reject replacing an established primary fleet outside an explicit transfer workflow.

**Acceptance:** parallel linking cannot exceed quota; primary-fleet replacement and overlapping memberships yield one deterministic entitlement owner and no orphaned paid grants.

### R5 — High impact, conditional: long-lived fleet credentials are exposed to browser JavaScript

Evidence: [provisioning DTO](../../apps/dashboard/src/lib/users.ts), [fleet DTO](../../apps/dashboard/src/lib/user-fleets.ts), and credential storage in the agents/runs/performance pages and sandbox flow. Current database writes also store reusable dashboard credentials as plaintext columns at the application layer; database volume encryption was not inspected.

This is not evidence of an existing XSS exploit. It increases the consequence of any future script compromise or compromised third-party script: a long-lived engine credential can escape the application's session and revocation controls.

**Recommendation:** route privileged engine operations through a session-authenticated backend-for-frontend. Return minimal DTOs without reusable credentials; store required engine secrets under managed encryption; use narrowly scoped, short-lived tokens where direct browser access is unavoidable. Rotate existing tokens during a staged migration. OWASP advises against placing sensitive credentials in [local storage](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html).

### R6 — Medium: inconsistent request validation and abuse controls

Evidence: [sandbox create route](../../apps/dashboard/src/app/api/sandbox/runs/route.ts) directly parses and forwards unvalidated JSON; several account actions assume TypeScript argument types at runtime. No dashboard-owned rate limiter was found for email-change or other expensive actions. External provider/ingress controls may exist but were not verified.

**Recommendation:** parse every public boundary with runtime schemas; reject malformed JSON, null/primitive bodies, excessive arrays, oversized strings and unsupported values. Set body-size limits and per-user/IP rate limits for email, provisioning and checkout. Keep downstream engine validation as an additional boundary.

**Acceptance:** malformed/oversized inputs produce stable 400/413 responses without a 500; repeated expensive requests produce 429 and a usable retry interval. No secrets enter diagnostic logs.

### R7 — Medium: admin writes and their audit events can diverge

Evidence: [setPlanOverride](../../apps/dashboard/src/lib/admin-actions.ts) updates the subscription before a separate audit insertion. Awaiting both does not make them atomic.

**Recommendation:** perform mutation and audit insertion in one transaction with before/after values read under an appropriate lock; enqueue synchronization in that transaction as well. Restrict audit deletion to a separate operational role.

**Acceptance:** failure to insert the audit row rolls back the mutation; concurrent overrides produce truthful audit history.

### R8 — Medium: build reproducibility and runtime validation need tightening

Evidence: [CI workflow](../../.github/workflows/ci.yml) falls back from `npm ci` to `npm install`, allowing lockfile problems to be hidden. The container uses an unpinned Node image tag. No route-specific error/loading boundary files were found. The performance page is over 1,200 lines and combines credential handling, queries, mutations and presentation.

**Recommendation:** require clean lockfile installs for the dashboard; run explicit typecheck, tests and production builds; scan dependencies and container images in CI; pin a supported Node image by reviewed digest with automated updates. Add staging integration tests and route error boundaries. Split the performance page by feature and move shared polling/cancellation into small typed hooks. Refactor incrementally rather than replacing the framework.

**Acceptance:** a lockfile mismatch fails CI; browser navigation cannot show stale data from a prior fleet; failed requests leave recoverable UI; a non-root container starts and serves assets successfully.

## Recommended architecture

Keep Next.js, PostgreSQL and the existing engine. The main improvement is clearer ownership of security decisions and durable side effects:

1. **Browser:** presentation, user input and session cookies; minimal data objects and no persistent engine credentials.
2. **Actions/routes:** thin adapters that authenticate, parse runtime input and invoke a domain service. Treat every exported server action as a public endpoint, as described in the [Next.js security guidance](https://nextjs.org/docs/app/guides/data-security).
3. **Server-only domain services:** account, fleet membership and billing policy. Authorize the target resource, not only the caller.
4. **Database transaction:** change domain state, record the audit event and enqueue outgoing work together.
5. **Workers and reconciliation:** reliably apply Stripe/engine effects with leases, retries, idempotency and observable failure states.

The existing parameterized SQL, per-request database-backed admin role check, server-only boundaries for admin/entitlement helpers, raw-body Stripe signature verification and transactional email-token redemption are good foundations to retain. PostgreSQL's pool also needs an idle error listener, as its [pooling guide](https://node-postgres.com/features/pooling) explains; that change is included.

## Verification and deployment notes

- Baseline: 111 passing tests and one timezone-dependent failure.
- Validation results are recorded in the companion `dashboard-validation-2026-09-22.md` file.
- New regression coverage exercises actual ownership and session callbacks with mocked external services. It is not a substitute for PostgreSQL concurrency tests, Stripe replay tests or a browser smoke test.
- No migrations, live engine calls, real emails, charges, credential rotations or deployments were performed.
- Dependency inventory was read locally. The public npm advisory query was blocked by automatic approval review because it would disclose dependency names and versions to the registry; the audit remains pending explicit approval. No clean-CVE assertion is made.
- Local installed/locked versions inspected: Next.js 16.3.4, Auth.js 5.0.0-beta.32, React/React DOM 19.2.8, pg 8.23.0, Stripe 22.6.2, PostHog 1.428.6 and Vitest 4.1.11. These are inventory facts, not vulnerability assessments.
- Before rollout, configure `AUTH_URL`, confirm the engine's token-login contract in staging, test the stricter session outage behavior, check analytics coverage changes, and verify origin handling behind the actual proxy.
- Validate non-root image startup, filesystem cache writes and runtime response headers. A local build cannot prove the deployed ingress or container configuration.

Prioritize R1–R4 before expanding paid production use. Then migrate browser credentials, complete boundary validation and harden the deployment pipeline. These remaining items require durable-state and lifecycle design, not cosmetic refactoring.
