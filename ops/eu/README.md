# EU deployment

EU customers use their own copy of WhiteRoom in the GCP project `whiteroom-eu`,
in `europe-west1` (Belgium). Their data never leaves the EU: the project's
location policy (`gcp.resourceLocations: in:eu-locations`) refuses anything
created outside the EU.

| | US (`whiteroom-prod`) | EU (`whiteroom-eu`) |
|---|---|---|
| Dashboard | https://app.whiteroom.tech | https://eu.app.whiteroom.tech |
| Engine | https://proxy.whiteroom.tech | https://eu.proxy.whiteroom.tech |
| Database | `whiteroom-db-v2`, us-central1 | `whiteroom-db-eu`, europe-west1 (HA, backups in europe-west1) |
| Logs | Cloud Logging | bucket `eu-default`, europe-west1, 30 days |
| Product analytics | PostHog (US) | off (`NEXT_PUBLIC_ANALYTICS=off`) |

Accounts don't move between regions: a customer signs up on the one they
want. `/admin` on the EU dashboard only opens for users with an admin row in
the EU database.

## Deploying the dashboard

The EU dashboard is a sanctioned exception to "Staging, then Promote": there
is no EU staging yet, so it deploys by hand from `cloudbuild-dashboard-eu.yaml`.
Only deploy a commit that US staging is already running, and only when asked.

```sh
gcloud builds submit --config=cloudbuild-dashboard-eu.yaml \
  --substitutions=COMMIT_SHA=$(git rev-parse HEAD) --project=whiteroom-eu \
  --region=europe-west1 \
  --service-account=projects/whiteroom-eu/serviceAccounts/whiteroom-deployer@whiteroom-eu.iam.gserviceaccount.com \
  --gcs-source-staging-dir=gs://whiteroom-eu-build-src/source
```

What the build does, in order:

1. **Guards.** Stops if the checkout predates the analytics switch, because the image would then report to PostHog's US host.
2. **Build and push** to Artifact Registry in europe-west1.
3. **Deploy.** Creates a new revision with **no traffic**, tagged `candidate`, and records the revision that was serving.
4. **Verify.** Checks that the service is public and that `/sign-in` renders at the candidate's own URL. If this fails, users stay on the old revision.
5. **Promote.** Moves all traffic to the new revision, then checks the live URL. If that fails, traffic goes back to the recorded revision on its own.

The build runs as `whiteroom-deployer`, which can deploy and move traffic but
can't change who may call the service. If Verify says the dashboard is
private, an owner runs:

```sh
gcloud run services update whiteroom-dashboard --no-invoker-iam-check \
  --region=europe-west1 --project=whiteroom-eu
```

## Rolling back by hand

```sh
# The last revisions, newest first
gcloud run revisions list --service=whiteroom-dashboard \
  --region=europe-west1 --project=whiteroom-eu --limit=5
# Send all traffic to one of them
gcloud run services update-traffic whiteroom-dashboard \
  --to-revisions=<revision-name>=100 --region=europe-west1 --project=whiteroom-eu
```

## Free invite code

The deploy reads `FREE_INVITE_CODE` from the secret
`whiteroom-dashboard-free-invite-code` in `whiteroom-eu`. The secret must
exist (and be readable by `whiteroom-dashboard-run`) before the next deploy,
or Deploy fails and users stay on the old revision. Any value works while
`FREE_PLAN` is unset; it only matters with `FREE_PLAN=invite`.

```sh
printf '%s' "$(openssl rand -hex 12)" | gcloud secrets create whiteroom-dashboard-free-invite-code \
  --data-file=- --replication-policy=user-managed --locations=europe-west1 --project=whiteroom-eu
```

## Database migrations

The EU dashboard database was built from a schema-only dump of staging
(migrations through 013, no rows). Every new migration in
`apps/dashboard/migrations/` must now be applied to **staging, prod and EU**,
in that order. Connect to the EU database the way `ops/staging/README.md`
shows for staging, with instance `whiteroom-eu:europe-west1:whiteroom-db-eu`
and the password in the `whiteroom-dashboard-db-password` secret in `whiteroom-eu`.

## Still to do

- **Fold the EU deploy into the workflows.** `deploy-staging.yml` would build the EU image too, and `promote-prod.yml` would ship the verified image to both regions, with Workload Identity Federation for `whiteroom-eu`. That would retire this exception.
- **A migration runner**, so migrations stop being a manual step in three databases.
- **Stripe.** When billing goes live, the EU dashboard needs the live key, its own live webhook secret and the `STRIPE_PRICE_*` variables.
