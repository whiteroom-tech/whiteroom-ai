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

## When EU turns on FREE_PLAN=invite (step 4.10)

The Free invite link needs `FREE_INVITE_CODE`, kept in Secret Manager (this
repo is public). It isn't in `cloudbuild-dashboard-eu.yaml` yet, so routine
deploys don't depend on the secret. Without it, no invite link works (the
dashboard treats a missing code as "no invite").

1. Create the secret (any hard-to-guess value; change it to close the link):

   ```sh
   printf '%s' "$(openssl rand -hex 12)" | gcloud secrets create whiteroom-dashboard-free-invite-code \
     --data-file=- --replication-policy=user-managed --locations=europe-west1 --project=whiteroom-eu
   ```

2. In `cloudbuild-dashboard-eu.yaml`, append it to the end of the `--set-secrets=` list:

   ```
   ...,WR_CRED_ENCRYPTION_KEY=whiteroom-dashboard-cred-key:1,FREE_INVITE_CODE=whiteroom-dashboard-free-invite-code:latest \
   ```

   and add `|FREE_PLAN=invite` to the end of `--set-env-vars`. Both flags
   replace the whole list on every deploy, so edit the file rather than the
   service.

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
- **Billing jobs.** Cloud Scheduler isn't enabled in `whiteroom-eu`, so `billing-sync` (hourly) and `entitlement-sweep` (every 2 minutes) don't run in the EU yet: free periods don't end on time, no trial reminders go out and savings aren't reported to Stripe. Create both jobs as in `whiteroom-prod`, with the EU's `whiteroom-entitlement-sync-secret` in the `x-wr-sync-secret` header.

## Stripe

The EU dashboard bills through the same WhiteRoom Tech live Stripe account as the US, with its own credentials:

- **Key and webhook secret:** `whiteroom-dashboard-stripe-secret-key` and `whiteroom-dashboard-stripe-webhook-secret` in `whiteroom-eu`'s Secret Manager (a separate live key from the US one).
- **Webhook destination:** `whiteroom-dashboard-eu` -> `https://eu.app.whiteroom.tech/api/stripe/webhook`, API version `2026-08-26.dahlia`, the same 7 events as the US destination.
- **Meter and prices:** the US ones, set in `cloudbuild-dashboard-eu.yaml`. The meter's event name is `whiteroom_saving_cents` (singular, the live meter's exact name).
- **Shared account:** each webhook destination receives the other region's events too. The webhook skips users and customers that aren't in its own region's database.
