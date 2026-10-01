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

The engine repo (`whiteroom-ai-whiteroom`) has the same two workflows. Engine images are environment-agnostic, so prod gets the exact digest staging ran.

`cloudbuild.yaml` still works as a manual escape hatch, but it skips staging. No Cloud Build trigger deploys the dashboard on push: the only push trigger in `whiteroom-prod` (checked Oct 1, 2026) builds the `whiteroom-tech/website` repo into the `whiteroom-tech` service.

## Auth

GitHub Actions authenticates with Workload Identity Federation (pool `github`, provider `github-actions` in `whiteroom-prod`), with no stored keys. Two service accounts, each trusting exactly one workflow file on `refs/heads/main` in each repo:

- `gh-deploy-staging@whiteroom-prod` ← `deploy-staging.yml`: push images; Run admin on `whiteroom-staging` only.
- `gh-deploy-prod@whiteroom-prod` ← `promote-prod.yml`: Run developer on the two prod services, registry read, Run viewer on staging. It cannot build or push images.

Renaming either workflow file breaks its auth on purpose. Update the `workloadIdentityUser` binding if you rename one.

## Database migrations

The dashboard has no migration runner. Apply a new `apps/dashboard/migrations/*.sql` to **staging first**, then prod:

```sh
cloud-sql-proxy --token "$(gcloud auth print-access-token)" --port 5441 \
  whiteroom-staging:us-central1:whiteroom-db-staging &
PGPASSWORD="$(gcloud secrets versions access latest --secret whiteroom-dashboard-db-password --project whiteroom-staging)" \
  psql -h 127.0.0.1 -p 5441 -U whiteroom_dashboard_app -d whiteroom_dashboard -f apps/dashboard/migrations/NNN_name.sql
```

Staging's schema was loaded from a `pg_dump --schema-only` of prod on 2026-09-30, so it already includes migrations 001–006. The engine migrates its own database at boot.

## Signing in

The email magic link works as is. Google sign-in needs this redirect URI added to the OAuth client in the `whiteroom-prod` console (APIs & Services → Credentials):

```
https://whiteroom-dashboard-667088277671.us-central1.run.app/api/auth/callback/google
```

## Known gaps

- The staging engine has no Anthropic platform key (`WR_PLATFORM_ANTHROPIC_KEY` was removed on 2026-10-01 so staging can't bill to prod). That key only seeds task-cost estimates, so on staging those estimates are the built-in defaults. Give staging its own capped key if you need real estimates there.
- The copy-paste setup snippets in `onboarding.tsx` hard-code `https://proxy.whiteroom.tech`, so on staging they point at the prod engine.
- No Stripe keys are set on staging (none are set on prod either yet).
