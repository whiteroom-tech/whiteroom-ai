# Monitoring

There are two independent watchdogs, so an outage gets noticed even when GCP itself is the problem.

**Cloud Monitoring** runs in project `whiteroom-prod` and is created by `setup.sh`. It emails info@whiteroom.tech.

| Alert | Fires when |
|---|---|
| Down: whiteroom.tech | `/` isn't 200 with "WhiteRoom" in the page, from more than one region for 2 minutes |
| Down: app.whiteroom.tech | `/sign-in` isn't 200 with "Sign in" in the page, as above |
| Down: proxy.whiteroom.tech | `/health` isn't 200 with `"db":"ok"`, as above (this covers the database too) |
| Down: Cloud SQL whiteroom-db-v2 | the instance reports down for 5 minutes, or stops reporting for 10 |
| Cloud Run 5xx errors | a service returns more than 20 5xx responses in 5 minutes |
| TLS certificate expiring | a host's certificate expires within 14 days |

Uptime checks run every minute. The setup is idempotent: after editing `setup.sh`, run `ops/monitoring/setup.sh` again to add whatever is missing. To change a check or policy that already exists, delete it in the console (Monitoring → Uptime checks or Alerting) and rerun the script.

**GitHub Actions** (`.github/workflows/uptime.yml`) checks the same three URLs every 10 minutes from outside GCP. It opens an `outage` issue per host while that host is down and closes it once the host recovers. It keeps working if the GCP project is suspended or billing lapses, which would also silence Cloud Monitoring. GitHub can delay scheduled runs by several minutes, so treat this as the backup.
