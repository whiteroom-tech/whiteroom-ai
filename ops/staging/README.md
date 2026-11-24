# Staging

A full copy of prod in its own GCP project, `whiteroom-staging`, so a bad deploy or migration breaks staging instead of app.whiteroom.tech.

| | Prod (`whiteroom-prod`) | Staging (`whiteroom-staging`) |
|---|---|---|
| Dashboard | https://app.whiteroom.tech | https://whiteroom-dashboard-667088277671.us-central1.run.app |
| Engine | https://proxy.whiteroom.tech | https://whiteroom-engine-667088277671.us-central1.run.app |
| Database | Cloud SQL `whiteroom-db-v2` (HA) | Cloud SQL `whiteroom-db-staging` (`db-f1-micro`, zonal, backups + PITR) |
| Data | real users | none — staging started empty, with prod's schema only |
| Engine scaling | always 1 instance | 0–1, cold-starts after ~15 min idle |

Nothing is shared between the two except the image registry (prod's `cloud-run-source-deploy`, which staging's Cloud Run agent can read) and two third-party keys copied into staging's Secret Manager: Resend and the Google OAuth client secret. Every other secret (`AUTH_SECRET`, DB passwords, key pepper, signing key, sync and sandbox secrets) was generated fresh for staging, so a staging session or API key is useless against prod.

## How a change ships

1. Merge to `main`. **Deploy staging** (`.github/workflows/deploy-staging.yml`) builds the image and deploys it to staging. The dashboard is built twice from the same checkout, because `NEXT_PUBLIC_PROXY_URL` is baked into the bundle: `<sha>-staging` points at the staging engine, `<sha>` at proxy.whiteroom.tech.
2. Test on the staging URL.
3. Run **Promote to prod** (`promote-prod.yml`, Actions → Run workflow). It refuses any commit staging isn't running or whose latest staging run didn't pass its smoke test (staging's run must have tagged the prod image `<sha>-verified-<run>`), deploys the prebuilt `<sha>` image by digest with no traffic, then moves traffic to it, and rolls back automatically if the traffic move or `/sign-in` fails. Staging deploys and promotions share one concurrency group, so they never overlap.

The engine repo (`whiteroom-ai-whiteroom`) has no deploy workflows: merging there deploys nothing, and its `cloudbuild-engine.yaml` is a manual production deploy.

Staging, then Promote, is the only supported path to production for the dashboard. Don't use `cloudbuild.yaml` to deploy: it skips staging and its checks. No Cloud Build trigger deploys the dashboard on push: the only push trigger in `whiteroom-prod` (checked Oct 1, 2026) builds the `whiteroom-tech/website` repo into the `whiteroom-tech` service.

## Auth

GitHub Actions authenticates with Workload Identity Federation (pool `github`, provider `github-actions` in `whiteroom-prod`), with no stored keys. Two service accounts, each trusting exactly one workflow file on `refs/heads/main` in each repo:

- `gh-deploy-staging@whiteroom-prod` ← `deploy-staging.yml`: push images; Run admin on `whiteroom-staging` only.
- `gh-deploy-prod@whiteroom-prod` ← `promote-prod.yml`: Run developer on the two prod services, registry read, Run viewer on staging. It cannot build or push images.

Renaming either workflow file breaks its auth on purpose. Update the `workloadIdentityUser` binding if you rename one.

## Database migrations

`npm run migrate` in `apps/dashboard` (`scripts/migrate.ts`) applies the pending `migrations/*.sql` files in name order and records each in a `schema_migrations` table. Run it against **staging first**, then US prod, then EU (`ops/eu/README.md`). No deploy runs it.

Connect through the Cloud SQL proxy, as before:

```sh
cloud-sql-proxy --token "$(gcloud auth print-access-token)" --port 5441 \
  whiteroom-staging:us-central1:whiteroom-db-staging &
cd apps/dashboard
export DB_HOST=127.0.0.1 DB_PORT=5441 DB_USER=whiteroom_dashboard_app DB_NAME=whiteroom_dashboard
export DB_PASSWORD="$(gcloud secrets versions access latest --secret whiteroom-dashboard-db-password --project whiteroom-staging)"
npm run migrate               # dry run: lists what is pending
npm run migrate -- --apply    # applies it
```

US prod is the same with `whiteroom-prod:us-central1:whiteroom-db-v2` and `--project whiteroom-prod`.

- **Dry run by default.** Nothing is written without `--apply`.
- **One file, one transaction.** A file and its `schema_migrations` row commit together, so a failed file leaves nothing behind and the next run tries it again. A file that can't run in a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`) says so with the line `-- migrate: no-transaction`, as 013 does. It runs through `psql -f`, as before, so `psql` must be on `PATH`; it is recorded only if psql succeeds, and must be safe to re-run. Without the line, Postgres refuses the statement, the file is rolled back, and the error says to add it.
- **One runner at a time.** `--apply` holds an advisory lock for the whole run. A second runner stops at once and says so.
- **Applied files don't change.** A recorded file whose text differs, or that is gone, stops the run before anything is applied. Put a fix in a new file.
- A file's `SET lock_timeout` still applies: on a timeout, run again.

### Baseline (once per database)

Staging, US prod and EU had migrations applied by hand before the runner existed, so each is baselined once: every file up to the last one it already has is recorded without being run. Until then `--apply` refuses, because the database has tables but no `schema_migrations`.

Check first which is the last file the database has. If `proxy_keys` exists, it has 018:

```sh
PGPASSWORD="$DB_PASSWORD" psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -Atc "SELECT to_regclass('proxy_keys') IS NOT NULL"
```

Then baseline at that file (here 018), dry run first:

```sh
npm run migrate -- --baseline 018_proxy_keys.sql           # lists the files it would record
npm run migrate -- --baseline 018_proxy_keys.sql --apply   # records them
npm run migrate                                             # should say: Up to date
```

If `proxy_keys` is missing, baseline at `017_trial_ending_email.sql` and then `npm run migrate -- --apply` applies 018. A database that already has rows in `schema_migrations` refuses a second baseline.

Staging's schema was loaded from a `pg_dump --schema-only` of prod on 2026-09-30, so it already includes migrations 001–006. The engine migrates its own database at boot.

## Signing in

The email magic link works as is. Google sign-in needs this redirect URI added to the OAuth client in the `whiteroom-prod` console (APIs & Services → Credentials):

```
https://whiteroom-dashboard-667088277671.us-central1.run.app/api/auth/callback/google
```

## Known gaps

- The staging engine has no Anthropic platform key (`WR_PLATFORM_ANTHROPIC_KEY` was removed on 2026-10-01 so staging can't bill to prod). That key only seeds task-cost estimates, so on staging those estimates are the built-in defaults. Give staging its own capped key if you need real estimates there.
- The Bedrock cross-account role recipe always shows `https://proxy.whiteroom.tech`: its routes only run on the prod engine (`WHITEROOM_BEDROCK_SERVER_ID` is unset on staging), and its trust policy names the prod engine's IAM user. Every other setup snippet uses the staging engine's address (`NEXT_PUBLIC_PROXY_URL`).
- No Stripe keys are set on staging (none are set on prod either yet).
