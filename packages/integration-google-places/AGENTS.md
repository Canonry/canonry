# integration-google-places

## Purpose

Google **Places API (New)** integration — a typed Place Details client used to pull
the *rendered-listing* data Google synthesizes for a location (amenities,
accessibility, editorial summary) and cross-reference it against the
owner-configured Google Business Profile (GBP) structured profile. This is the
data behind issue #648: a hotel with an empty GBP lodging profile can still show
a rich public listing, and Places is canonry's read into that gap.

Unlike the GBP APIs (OAuth, `business.manage` scope), the Places API authenticates
with a **plain API key** (`X-Goog-Api-Key` header) and requires an explicit
**field mask** (`X-Goog-FieldMask`) on every request. The key lives in
`~/.canonry/config.yaml` under `google.placesApiKey` (or the `GOOGLE_PLACES_API_KEY`
env var) — this package only takes the key as a parameter.

The Place ID that addresses a place comes from the GBP location's
`metadata.placeId` (captured during `gbp locations discover`) — there is no
fuzzy text-search step.

## Key Files

| File | Role |
|------|------|
| `src/place-details-client.ts` | `getPlaceDetails(placeId, apiKey, opts)` — GET `/v1/places/{placeId}`; `buildPlaceDetailsFieldMask(tier)` — tier → field mask |
| `src/http.ts` | `placesFetchGet` — shared GET helper: `X-Goog-Api-Key` + `X-Goog-FieldMask` headers, `withRetry` (retries 429/503 only), maps non-2xx → `PlacesApiError` (carries HTTP status + `error.status` reason) |
| `src/constants.ts` | `PLACES_API_BASE`, request timeout, and the `PlacesTier` field-mask tiers (`PLACES_PRO_FIELDS`, `PLACES_ATMOSPHERE_FIELDS`) |
| `src/types.ts` | `PlaceDetails` (trimmed to requested fields), `PlacesApiError`, `PlacesFetchOptions` |
| `src/index.ts` | Public re-exports |

## Pricing (Critical — the field mask is the cost lever)

Place Details (New) bills at the **highest SKU tier among the fields requested**.
The tiers this package exposes:

| Tier | SKU | Free/month | Then | Fields |
|------|-----|-----------|------|--------|
| `pro` | Place Details Pro | 5,000 | $17/1k | IDs, types, Maps link, website, `accessibilityOptions` |
| `atmosphere` | Place Details Enterprise + Atmosphere | **1,000** | $25/1k | Pro **+** amenity booleans (`servesBreakfast`, `allowsDogs`, `parkingOptions`, …) + `editorialSummary` |

The amenity booleans (the cross-reference signal) only exist at the Atmosphere
SKU. For a typical operator book — a handful of hotels on a weekly Places refresh
— usage stays inside the **1,000 free Atmosphere calls/month**, i.e. $0. A
billing account (card on the GCP project) is required even within the free tier.
Default tier is `atmosphere`; drop to `pro` (or disable Places) to trade signal
for cost headroom.

## Patterns

- **API key, not OAuth** — the only Google integration in canonry that authenticates with an API key. Never thread an OAuth token here.
- **Field mask required** — every request sends `X-Goog-FieldMask`. An empty/invalid mask returns 400 `INVALID_ARGUMENT`.
- **Error mapping** — non-2xx throws `PlacesApiError` with the HTTP status + the `error.status` reason (`INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`, `RESOURCE_EXHAUSTED`). 404 means a stale place id (the location dropped off Maps).
- **Best-effort in the sync** — callers treat Places as supplemental: a `PlacesApiError` is caught per-location and never fails the `gbp-sync` run.
- **Retry** — `withRetry` from contracts; only 429 (rate limit) and 503 (transient) retry. 400/401/403/404 fail fast.

## Common Mistakes

- **Storing the API key in this package** — it belongs in `~/.canonry/config.yaml` / `GOOGLE_PLACES_API_KEY`. This package takes the key as a parameter.
- **Requesting Atmosphere fields when you only need IDs** — the whole call is billed at the highest tier. Use the narrowest tier that yields the signal you need.
- **Assuming every GBP location has a place id** — `metadata.placeId` is null when the location is not on Maps; skip Places for those.

## See Also

- `packages/integration-google-business-profile/` — the OAuth-based GBP clients; `metadata.placeId` from `listLocations` is the join key
- `skills/canonry/references/google-business-profile.md` — user-facing setup guide (Places API key + pricing)
