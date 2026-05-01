# Server-Side Traffic Source Model Review

**Status:** implementation note for the Cloud Run stacked PR
**Last updated:** 2026-05-01

## Why this exists

The server-side traffic plan needs one model that can handle Cloud Run, WordPress,
Cloudflare, Vercel, and future hosting providers without turning the API into a
set of provider-specific dashboards. The important split is not provider name;
it is evidence type.

## Source facts checked

- Cloud Run automatically sends service request logs to Cloud Logging, separate
  from container and system logs. Google documents that these request logs are
  created automatically for Cloud Run services:
  https://docs.cloud.google.com/run/docs/logging
- Cloud Logging `entries.list` is a pull API over log entries. It accepts
  `resourceNames`, a Logging query `filter`, `orderBy`, `pageSize`, and
  `pageToken`, and it requires `logging.logEntries.list`-class permission:
  https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list
- Cloud Logging `LogEntry.httpRequest` carries the request URL, status, user
  agent, remote IP, referer, sizes, and latency fields Canonry needs for raw
  server-side evidence:
  https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#HttpRequest
- Cloudflare GraphQL Analytics is aggregate analytics over HTTP requests, and
  Cloudflare AI Crawl Control exposes crawler-oriented filters such as
  `userAgent_like`, `clientRequestPath_like`, `clientRefererHost_like`, and
  `botDetectionIds_hasany` through that aggregate API:
  https://developers.cloudflare.com/analytics/graphql-api/
  https://developers.cloudflare.com/ai-crawl-control/reference/graphql-api/
- Vercel Log Drains include proxy fields such as method, host, path, user
  agent, referer, status code, and client IP, but drains send logs to a
  configured destination. That makes them raw-event capable, but not directly
  pull-only unless the customer configures a destination Canonry can later pull
  from:
  https://vercel.com/docs/drains/reference/logs
  https://vercel.com/docs/drains

## Models considered

### 1. Provider-specific tables

Example: `cloud_run_request_logs`, `wordpress_crawler_hits`,
`cloudflare_ai_crawler_groups`, `vercel_proxy_events`.

Rejected. It would make every API/CLI/dashboard query provider-aware, and it
would make citation-crawl-click joins expensive to maintain. It also bakes the
first provider's quirks into the product.

### 2. Store full raw logs

Example: persist every Cloud Logging `LogEntry`, Vercel drain row, or WordPress
request row.

Rejected for the main database. Raw logs are high-cardinality, privacy-sensitive,
and provider-shaped. Canonry should retain only normalized evidence plus a small
sample tail for debugging.

### 3. Aggregate-only model

Example: every adapter writes hourly `{bot, path, status, hits}` buckets and
never preserves per-request evidence.

Rejected as the only model. It fits Cloudflare GraphQL well, but loses the raw
IP/user-agent/referrer fields needed for verification, replaying classifier
improvements, and sampling.

### 4. Canonical evidence model plus provider capabilities

Recommended. Each adapter declares what it can supply:

- `raw-request-events`: individual request evidence, e.g. Cloud Run request
  logs and the WordPress plugin.
- `aggregate-request-metrics`: grouped request counts, e.g. Cloudflare
  GraphQL Analytics.
- field capabilities: `request-url`, `status-code`, `user-agent`, `remote-ip`,
  `referer`, `cursor-pull`.

Raw adapters normalize into `NormalizedTrafficRequest`. Aggregate adapters
normalize into a future `NormalizedTrafficAggregateBucket`. Both feed the same
rollup tables and public API. Raw evidence can be reclassified as the bot
manifest improves; aggregate evidence carries lower replay/verification power.

## Recommended provider mapping

| Provider | Evidence model | Why |
|---|---|---|
| Cloud Run / Cloud Logging | Raw request events | Pull API, automatic request logs, `httpRequest` includes URL, status, UA, IP, referer. |
| WordPress plugin | Raw request events | Plugin runs server-side and Canonry pulls plugin-owned rows. |
| Cloudflare GraphQL | Aggregate request metrics | GraphQL Analytics groups/filter counts; AI Crawl Control can filter crawler/referrer dimensions, but it is not raw log replay. |
| Vercel Log Drains | Raw request events only if customer provides a pullable drain destination | Vercel sends drains to a destination, which conflicts with Canonry local-only pull unless the destination is user-owned storage/API. |

## Cloud Run PR scope

This stacked PR starts the Cloud Run path without adding a partial dashboard:

1. Add provider-neutral traffic contract constants and `NormalizedTrafficRequest`.
2. Add a provider-neutral local traffic analysis package that rolls normalized
   request evidence into crawler/referral buckets before DB persistence exists.
3. Add a Cloud Run integration package that:
   - builds Cloud Logging filters for `cloud_run_revision`;
   - optionally narrows by service, location, timestamp window, and user-agent
     substrings;
   - pulls `entries.list` with page tokens;
   - normalizes `LogEntry.httpRequest` into Canonry request evidence.
4. Keep persistence/API/CLI for the next PR so public surfaces are introduced
   only when the storage and sync semantics are complete.

## Local pull and analysis probe

Before adding Canonry DB/API/CLI surfaces, use the local probe to test the
pull-normalize-ingest-analyze loop:

```bash
pnpm tsx scripts/test-cloud-run-traffic-pull.ts \
  --fixture scripts/fixtures/cloud-run-traffic-sample.json
```

For real Cloud Run logs:

```bash
pnpm tsx scripts/test-cloud-run-traffic-pull.ts \
  --gcp-project <gcp-project-id> \
  --service <cloud-run-service> \
  --location <region> \
  --since 6h \
  --use-gcloud \
  --out .tmp/cloud-run-traffic-report.json
```

Use `--narrow-bots` to add known AI-crawler user-agent filters to the Cloud
Logging query. That lowers log volume, but it intentionally misses human AI
referrals because those requests normally have browser user agents.

## Next implementation slice

The next stacked PR should add the shared traffic persistence and public
surfaces:

- DB tables: `traffic_sources`, `crawler_events_hourly`,
  `ai_referral_events_hourly`, `raw_event_samples`.
- API/CLI:
  - `traffic connect cloud-run`
  - `traffic sync --source cloud-run`
  - `traffic sources`
  - `traffic crawlers`
  - `traffic referrals`
  - `traffic timeline`
- Config storage under `~/.canonry/config.yaml`, not SQLite.
- MCP registry entries only after the API and CLI exist.
