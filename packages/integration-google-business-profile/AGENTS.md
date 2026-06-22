# integration-google-business-profile

## Purpose

Google Business Profile (GBP) integration — typed clients for the Account Management, Business Information, Performance, Place Actions, and Lodging APIs. Used by the local-AEO surface (keyword impressions, daily metrics, booking/reservation CTAs, hotel attributes).

> **Note:** Two GBP sub-APIs are deliberately out of scope. Google's My Business **Q&A** API was shut down (returns HTTP 501 `API_UNSUPPORTED` as of 2026). The v4 **Reviews** API is producer-restricted (returns `PERMISSION_DENIED` `110002` unless Google grants per-project access) and cannot be self-enabled, so there is no reviews client here. See the smoke-test findings in the PR description.

OAuth and token storage live in `packages/integration-google` and `packages/api-routes/src/google.ts`. This package only takes an access token and makes API calls.

## Key Files

| File | Role |
|------|------|
| `src/accounts-client.ts` | `listAccounts(accessToken)` — Account Management API |
| `src/locations-client.ts` | `listLocations(accessToken, accountName)` — Business Information API |
| `src/performance-client.ts` | `fetchDailyMetrics` (all 11 DailyMetric over a date range; parses string-encoded values, treats omitted zero-days as 0, flattens split date objects to YYYY-MM-DD) + `listMonthlyKeywords` (paginated; maps the `insightsValue.value\|threshold` union to typed `valueCount`/`valueThreshold`) — Performance API |
| `src/place-actions-client.ts` | `listPlaceActionLinks(accessToken, locationName)` — booking / reservation / order CTAs ("place action links") for a location, fully paginated (Business Information v1 host). Returns `{ placeActionLinkName, placeActionType, uri, isPreferred, providerType }` rows. |
| `src/lodging-client.ts` | `getLodging` (maps HTTP 400 `FAILED_PRECONDITION` → `null` for non-lodging locations so the worker skips them cleanly; other errors propagate) + `countPopulatedGroups` (non-empty top-level attribute groups, excluding `name`/`metadata`) + `hashLodging` (stable key-sorted stringify + sha256, drives snapshot-on-change) — Lodging API |
| `src/attributes-client.ts` | `getAttributes` (owner-set attributes for ANY business category via Business Information `GET /{location}/attributes`; flattens the BOOL/ENUM/URL/REPEATED_ENUM value carriers into `{values, unsetValues, uris}`; returns `[]` on 404; no readMask, no pagination) + `countAttributes` + `hashAttributes` (order-independent sha256, drives snapshot-on-change) — Business Information API |
| `src/http.ts` | `gbpFetchGet` — shared GET helper. Wraps `gbpFetchOnce` in the shared `withRetry`; the GBP-specific `isRetryable` predicate retries 429 (except the 0-QPM access gate, `quotaLimitValue === 0`) and 503, never 401/403/404/4xx/other-5xx. Parses `error.details[].reason` and `quota_limit_value` into `GbpApiError`. |
| `src/types.ts` | `GbpApiError` (carries `status` + structured `reason` like `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `RATE_LIMIT_EXCEEDED`) + `GbpFetchOptions` + response types |
| `src/constants.ts` | API hosts, OAuth scope, request timeout, default page sizes |
| `src/index.ts` | Public re-exports |

## Patterns

- **Single scope** — the Business Profile API family uses one scope: `https://www.googleapis.com/auth/business.manage`. No read-only variant exists. Re-export as `GBP_SCOPE`.
- **Pagination** — all list endpoints return `nextPageToken`. Each client paginates internally and returns the full collected array; callers don't deal with tokens.
- **Quota project header** — when the API is called from a context that needs explicit quota attribution (e.g. gcloud-issued tokens), callers pass an `x-goog-user-project` header. The clients accept an optional `quotaProject` argument that they pass through.
- **Error mapping** — non-2xx responses throw `GbpApiError`. The error carries the HTTP status code, the structured `reason` parsed from `error.details[].reason`, and the parsed `quotaLimitValue` so callers in `packages/api-routes` can map cleanly to `AppError` factories (`quotaExceeded`, `authRequired`, `providerError`).
- **Retry / backoff guards** — `gbpFetchGet` implements Google's documented retry policy ([limits doc](https://developers.google.com/my-business/content/limits)): exponential backoff with jitter (`sleep = random() * baseDelayMs * 2^attempt`, default `baseDelayMs = 1000`, `maxRetries = 5`). Retried: 429 (except the 0-QPM access gate — `quotaLimitValue === 0` — which is unrecoverable until Google approves the form) and 503 transient errors. **Not retried**: 401 (auth expired), 403 (scope / API-disabled / permission), 404, validation errors, other 5xx. Callers can override the retry policy with `opts.retry` for tests or alternate behaviors.

## Host Map

Every GBP sub-API this package calls lives on a v1 host (one host per sub-API — see `constants.ts`): Account Management, Business Information (locations + place actions), Performance, and Lodging. Each client file documents which host it targets. The only sub-API Google never migrated off v4 is **Reviews** (`mybusiness.googleapis.com/v4/...`) — and that surface is access-gated (see the Purpose note), so no client targets it.

## Common Mistakes

- **Storing OAuth tokens in this package** — credentials belong in `~/.canonry/config.yaml`. This package takes an access token as a parameter.
- **Hard-coding scopes other than `business.manage`** — the API family does not publish a read-only scope. Anything we call requires `business.manage`.
- **Forgetting the `x-goog-user-project` header** — gcloud-issued tokens require it for quota attribution.

## See Also

- `packages/api-routes/src/google.ts` — OAuth flow + token storage; calls into this package
- `packages/integration-google/src/oauth.ts` — shared Google OAuth helpers (used by api-routes)
- `skills/canonry/references/google-business-profile.md` — user-facing setup guide
