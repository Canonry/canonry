# integration-cloud-run

## Purpose

Cloud Run / Cloud Logging integration — pulls request logs for `cloud_run_revision` resources via the Cloud Logging `entries.list` API and normalizes them into provider-neutral `NormalizedTrafficRequest` events for the traffic ingestion pipeline.

## Key Files

| File | Role |
|------|------|
| `src/client.ts` | `listCloudRunTrafficEvents` — paginated `entries.list` pull, page-token cursoring, `CloudRunLoggingApiError` |
| `src/filter.ts` | `buildCloudRunLogFilter` — composes the Cloud Logging query string from service/location/timestamp/url/UA narrowing options |
| `src/normalize.ts` | `normalizeCloudRunLogEntry` — converts a Cloud Logging `LogEntry.httpRequest` into a `NormalizedTrafficRequest` |
| `src/types.ts` | Adapter option/response shapes (`ListCloudRunTrafficEventsOptions`, `CloudRunTrafficEventsPage`, raw `LogEntry` types) |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Bearer-token auth.** The caller supplies an OAuth access token (`logging.logEntries.list`-class scope). This package does not own the token — credentials live in `~/.canonry/config.yaml` and are exchanged by the consumer (CLI/script/server).
- **Pull-only, cursor-paginated.** `listCloudRunTrafficEvents` accepts `pageToken` / `pageSize` / `maxPages` so callers can do incremental syncs. No push, no SaaS relay.
- **Provider-neutral output.** Every adapter in the traffic stack normalizes to the same `NormalizedTrafficRequest` shape from `@ainyc/canonry-contracts`. Do not leak Cloud Logging types past the package boundary.
- **Narrow filters when possible.** `buildCloudRunLogFilter` composes filters incrementally (service, location, time window, request URL substring, user-agent substrings). Narrower filters lower Cloud Logging cost; the `--narrow-bots` mode in the probe script intentionally trades human-AI-referral coverage for crawler-only coverage.

## Common Mistakes

- **Calling `entries.list` without `resourceNames`.** Cloud Logging requires it; the client always passes `projects/<id>`.
- **Storing access tokens in this package.** Tokens are short-lived and supplied per call.
- **Using this client for non-`cloud_run_revision` resources.** The filter and normalizer are scoped to Cloud Run request logs. Other resource types need a separate adapter.

## See Also

- `packages/contracts/src/traffic.ts` — the `NormalizedTrafficRequest` contract this package emits
- `packages/integration-traffic/` — provider-neutral classifier + rollup over normalized events
- `plans/cloud-run-traffic-source-model-review.md` — design rationale for the raw-event vs aggregate-bucket split
- `plans/server-side-ai-traffic-ingestion.md` — overall traffic ingestion plan
- `scripts/test-cloud-run-traffic-pull.ts` — local probe that exercises pull → normalize → analyze
