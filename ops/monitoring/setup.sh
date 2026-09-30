#!/usr/bin/env bash
# Uptime checks and alert policies for WhiteRoom prod in Cloud Monitoring.
#
# Idempotent: anything that already exists (matched by display name) is left
# alone, so rerun it after editing to add what's missing. To change an
# existing check or policy, delete it in the console first.
#
# Usage: ops/monitoring/setup.sh            (needs gcloud auth and jq)
# Env:   PROJECT (default whiteroom-prod), ALERT_EMAIL (default info@whiteroom.tech)
set -euo pipefail

PROJECT="${PROJECT:-whiteroom-prod}"
ALERT_EMAIL="${ALERT_EMAIL:-info@whiteroom.tech}"
SQL_INSTANCE="whiteroom-db-v2"
API="https://monitoring.googleapis.com/v3/projects/$PROJECT"
TOKEN="$(gcloud auth print-access-token)"

api() { # api METHOD PATH [JSON]
  curl -sS --fail-with-body -X "$1" "$API/$2" \
    -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
    ${3:+--data "$3"}
}

# Prints the resource name of the item with this display name, if any.
find_named() { # find_named COLLECTION FIELD DISPLAY_NAME
  api GET "$1?pageSize=100" | jq -r --arg n "$3" ".$2[]? | select(.displayName == \$n) | .name"
}

# ---------- Notification channel ----------

CHANNEL="$(find_named notificationChannels notificationChannels "Email $ALERT_EMAIL")"
if [ -z "$CHANNEL" ]; then
  CHANNEL="$(api POST notificationChannels "$(jq -n --arg e "$ALERT_EMAIL" \
    '{type: "email", displayName: "Email \($e)", labels: {email_address: $e}}')" | jq -r .name)"
  echo "created channel $CHANNEL"
fi

# ---------- Uptime checks ----------

# uptime_check NAME HOST PATH CONTENT  -> prints the check id
uptime_check() {
  local name="$1" host="$2" path="$3" content="$4" existing
  existing="$(find_named uptimeCheckConfigs uptimeCheckConfigs "$name")"
  if [ -z "$existing" ]; then
    existing="$(api POST uptimeCheckConfigs "$(jq -n \
      --arg name "$name" --arg host "$host" --arg path "$path" --arg content "$content" --arg p "$PROJECT" '{
        displayName: $name,
        monitoredResource: {type: "uptime_url", labels: {project_id: $p, host: $host}},
        httpCheck: {
          path: $path, port: 443, useSsl: true, validateSsl: true, requestMethod: "GET",
          acceptedResponseStatusCodes: [{statusValue: 200}]
        },
        contentMatchers: [{content: $content, matcher: "CONTAINS_STRING"}],
        period: "60s",
        timeout: "10s"
      }')" | jq -r .name)"
    echo "created uptime check $name" >&2
  fi
  basename "$existing"
}

WEBSITE_ID="$(uptime_check "Website whiteroom.tech" whiteroom.tech / "WhiteRoom")"
DASHBOARD_ID="$(uptime_check "Dashboard app.whiteroom.tech" app.whiteroom.tech /sign-in "Sign in")"
# /health also pings the database, so a DB outage shows up here too.
PROXY_ID="$(uptime_check "Proxy proxy.whiteroom.tech" proxy.whiteroom.tech /health '"db":"ok"')"

# ---------- Alert policies ----------

# policy NAME DOCS CONDITIONS_JSON
policy() {
  local name="$1" docs="$2" conditions="$3"
  if [ -n "$(find_named alertPolicies alertPolicies "$name")" ]; then return; fi
  api POST alertPolicies "$(jq -n --arg name "$name" --arg docs "$docs" --arg ch "$CHANNEL" \
    --argjson conditions "$conditions" '{
      displayName: $name,
      combiner: "OR",
      conditions: $conditions,
      notificationChannels: [$ch],
      documentation: {content: $docs, mimeType: "text/markdown"},
      alertStrategy: {autoClose: "1800s"}
    }')" >/dev/null
  echo "created policy $name"
}

# Down when more than one checker region fails, so one flaky region doesn't page.
uptime_condition() { # uptime_condition CHECK_ID TITLE
  jq -n --arg id "$1" --arg title "$2" '[{
    displayName: $title,
    conditionThreshold: {
      filter: "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"\($id)\"",
      aggregations: [{
        alignmentPeriod: "1200s",
        perSeriesAligner: "ALIGN_NEXT_OLDER",
        crossSeriesReducer: "REDUCE_COUNT_FALSE",
        groupByFields: ["resource.label.*"]
      }],
      comparison: "COMPARISON_GT",
      thresholdValue: 1,
      duration: "120s",
      trigger: {count: 1}
    }
  }]'
}

RUNBOOK_RUN='Check the service in Cloud Run (revisions, logs, `status.traffic`). If traffic is pinned to an old revision: `gcloud run services update-traffic SERVICE --to-latest --region REGION --project whiteroom-prod`. All three hosts sit behind the `whiteroom-lb` load balancer, so if all three are down at once, look at the LB first.'

policy "Down: whiteroom.tech" \
  "The public website failed its uptime check from more than one region. Cloud Run service \`whiteroom-tech\` (northamerica-northeast1). $RUNBOOK_RUN" \
  "$(uptime_condition "$WEBSITE_ID" "whiteroom.tech failing")"

policy "Down: app.whiteroom.tech" \
  "The dashboard sign-in page failed its uptime check from more than one region. Cloud Run service \`whiteroom-dashboard\` (us-central1). $RUNBOOK_RUN" \
  "$(uptime_condition "$DASHBOARD_ID" "app.whiteroom.tech failing")"

policy "Down: proxy.whiteroom.tech" \
  "The proxy's /health failed from more than one region. It checks the database too, so also look at Cloud SQL \`$SQL_INSTANCE\`. The engine exits on startup if it can't reach the DB. Cloud Run service \`whiteroom-engine\` (us-central1). $RUNBOOK_RUN" \
  "$(uptime_condition "$PROXY_ID" "proxy.whiteroom.tech/health failing")"

policy "TLS certificate expiring" \
  "A certificate served on a WhiteRoom host expires within 14 days. Certificates are managed on the \`whiteroom-lb\` load balancer; check its certificate status." \
  "$(jq -n '[{
    displayName: "Certificate expires in under 14 days",
    conditionThreshold: {
      filter: "metric.type=\"monitoring.googleapis.com/uptime_check/time_until_ssl_cert_expires\" AND resource.type=\"uptime_url\"",
      aggregations: [{
        alignmentPeriod: "1200s",
        perSeriesAligner: "ALIGN_NEXT_OLDER",
        crossSeriesReducer: "REDUCE_MEAN",
        groupByFields: ["metric.label.check_id"]
      }],
      comparison: "COMPARISON_LT",
      thresholdValue: 14,
      duration: "600s",
      trigger: {count: 1}
    }
  }]')"

# Catches a service that's up but failing requests, which the uptime checks
# miss when only some routes break.
policy "Cloud Run 5xx errors" \
  "A Cloud Run service returned more than 20 server errors in 5 minutes. Check that service's logs in Cloud Run. For \`whiteroom-engine\`, upstream provider errors passed through can also trigger this." \
  "$(jq -n '[{
    displayName: "More than 20 5xx responses in 5 minutes",
    conditionThreshold: {
      filter: "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND metric.label.response_code_class=\"5xx\"",
      aggregations: [{
        alignmentPeriod: "300s",
        perSeriesAligner: "ALIGN_SUM",
        crossSeriesReducer: "REDUCE_SUM",
        groupByFields: ["resource.label.service_name"]
      }],
      comparison: "COMPARISON_GT",
      thresholdValue: 20,
      duration: "0s",
      trigger: {count: 1}
    }
  }]')"

policy "Down: Cloud SQL $SQL_INSTANCE" \
  "Cloud SQL \`$SQL_INSTANCE\` reports down or stopped sending metrics. Both the dashboard and the proxy need it. Check the instance state in Cloud SQL: SUSPENDED means a billing or trial problem, not a crash." \
  "$(jq -n --arg db "$PROJECT:$SQL_INSTANCE" '[
    {
      displayName: "Instance reports down",
      conditionThreshold: {
        filter: "metric.type=\"cloudsql.googleapis.com/database/up\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"\($db)\"",
        aggregations: [{alignmentPeriod: "300s", perSeriesAligner: "ALIGN_MIN"}],
        comparison: "COMPARISON_LT",
        thresholdValue: 1,
        duration: "300s",
        trigger: {count: 1}
      }
    },
    {
      displayName: "Instance stopped reporting",
      conditionAbsent: {
        filter: "metric.type=\"cloudsql.googleapis.com/database/up\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"\($db)\"",
        aggregations: [{alignmentPeriod: "300s", perSeriesAligner: "ALIGN_MIN"}],
        duration: "600s",
        trigger: {count: 1}
      }
    }
  ]')"

echo "done: alerts go to $ALERT_EMAIL"
