# integration-google-business-profile

## Purpose

Google Business Profile (GBP) integration — typed clients for the Account Management, Business Information, Performance, Lodging, Place Actions, and v4 Reviews APIs. Used by the local-AEO surface (reviews tracking, keyword impressions, daily metrics, hotel attributes, booking CTAs).

> **Note:** Google's My Business Q&A API was shut down (returns HTTP 501 `API_UNSUPPORTED` as of 2026). Q&A is not part of this integration. See the smoke-test findings in the PR description.

OAuth and token storage live in `packages/integration-google` and `packages/api-routes/src/google.ts`. This package only takes an access token and makes API calls.

## Key Files

| File | Role |
|------|------|
| `src/accounts-client.ts` | `listAccounts(accessToken)` — Account Management API |
| `src/locations-client.ts` | `listLocations(accessToken, accountName)` — Business Information API |
| `src/performance-client.ts` | `fetchDailyMetrics` (all 11 DailyMetric over a date range; parses string-encoded values, treats omitted zero-days as 0, flattens split date objects to YYYY-MM-DD) + `listMonthlyKeywords` (paginated; maps the `insightsValue.value\|threshold` union to typed `valueCount`/`valueThreshold`) — Performance API |
| `src/types.ts` | `GbpApiError` (carries `status` + structured `reason` like `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `RATE_LIMIT_EXCEEDED`) + response types |
| `src/constants.ts` | API hosts, OAuth scope, request timeout, default page sizes |
| `src/index.ts` | Public re-exports |

## Patterns

- **Single scope** — the Business Profile API family uses one scope: `https://www.googleapis.com/auth/business.manage`. No read-only variant exists. Re-export as `GBP_SCOPE`.
- **Pagination** — all list endpoints return `nextPageToken`. Each client paginates internally and returns the full collected array; callers don't deal with tokens.
- **Quota project header** — when the API is called from a context that needs explicit quota attribution (e.g. gcloud-issued tokens), callers pass an `x-goog-user-project` header. The clients accept an optional `quotaProject` argument that they pass through.
- **Error mapping** — non-2xx responses throw `GbpApiError`. The error carries the HTTP status code, the structured `reason` parsed from `error.details[].reason`, and the parsed `quotaLimitValue` so callers in `packages/api-routes` can map cleanly to `AppError` factories (`quotaExceeded`, `authRequired`, `providerError`).
- **Retry / backoff guards** — `gbpFetchGet` implements Google's documented retry policy ([limits doc](https://developers.google.com/my-business/content/limits)): exponential backoff with jitter (`sleep = random() * baseDelayMs * 2^attempt`, default `baseDelayMs = 1000`, `maxRetries = 5`). Retried: 429 (except the 0-QPM access gate — `quotaLimitValue === 0` — which is unrecoverable until Google approves the form) and 503 transient errors. **Not retried**: 401 (auth expired), 403 (scope / API-disabled / permission), 404, validation errors, other 5xx. Callers can override the retry policy with `opts.retry` for tests or alternate behaviors.

## Hybrid v1/v4 Surface

Most GBP endpoints live on v1 hosts (one host per sub-API). **Reviews stay on v4** (`mybusiness.googleapis.com/v4/...`) because Google never migrated them. Each client file documents which host it targets.

## Common Mistakes

- **Storing OAuth tokens in this package** — credentials belong in `~/.canonry/config.yaml`. This package takes an access token as a parameter.
- **Hard-coding scopes other than `business.manage`** — the API family does not publish a read-only scope. Anything we call requires `business.manage`.
- **Forgetting the `x-goog-user-project` header** — gcloud-issued tokens require it for quota attribution.

## See Also

- `packages/api-routes/src/google.ts` — OAuth flow + token storage; calls into this package
- `packages/integration-google/src/oauth.ts` — shared Google OAuth helpers (used by api-routes)
- `skills/canonry-setup/references/google-business-profile.md` — user-facing setup guide
