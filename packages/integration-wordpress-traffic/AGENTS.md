# integration-wordpress-traffic

## Purpose

WordPress traffic-logger integration — pulls candidate AI traffic events
(crawler hits + AI-referral hits) from the canonry traffic-logger WordPress
plugin's REST endpoint (`/wp-json/canonry/v1/events`) and normalizes them
into provider-neutral `NormalizedTrafficRequest` events for the traffic
ingestion pipeline.

Companion package: `packages/integration-wordpress/` (content-publishing
client) is **separate** — that handles page/SEO/schema management on a WP
site and shares only the Application-Password auth pattern.

## Key Files

| File | Role |
|------|------|
| `src/client.ts` | `listWordpressTrafficEvents` — cursor-paginated pull, `WordpressTrafficApiError` |
| `src/normalize.ts` | `normalizeWordpressTrafficEvent` — converts a plugin event row into a `NormalizedTrafficRequest` |
| `src/types.ts` | Adapter option/response shapes (`WordpressTrafficEventPayload`, `ListWordpressTrafficEventsOptions`, `WordpressTrafficEventsPage`) |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Application-Password auth.** Callers pass a WordPress username + Application
  Password (the same scheme used by `packages/integration-wordpress/`). This
  package base64-encodes them for HTTP Basic auth. Credentials are caller-supplied
  per request — they live in `~/.canonry/config.yaml` under `wordpressTraffic.connections`.
- **Egress through the caller's fetch.** Every page request goes through
  `options.fetchImpl`, falling back to global `fetch`. `api-routes` passes
  `createGuardedFetch`, which checks the address of each request and redirect
  hop and dials only that address, so the Basic-auth header cannot be steered
  to an internal host by DNS rebinding or a redirect.
- **Pull-only, cursor-paginated.** `listWordpressTrafficEvents` accepts an opaque
  `cursor` string returned from the previous page (`next_cursor`). No push,
  no SaaS relay.
- **Cache-buster on every request.** Each call to the plugin endpoint carries
  a unique `_cb` query param and a `Cache-Control: no-cache` request header.
  Some WordPress hosts front the site with a page cache (LiteSpeed and
  similar) that caches the REST response keyed on the URL despite its
  no-cache headers; without a varying URL the sync reads a frozen page and
  silently misses new events.
- **No classification.** This package only pulls + normalizes. UA pattern
  matching and AI-referer detection happen in `packages/integration-traffic`
  alongside Cloud Run events, so classifier rules evolve without plugin updates.
- **The plugin sends the real client IP.** Plugin 0.3.0+ records the raw
  client IP (`remote_ip`), so `normalize.ts` maps it straight to `remoteIp`.
  The classifier in `packages/integration-traffic` verifies it against
  operator IP ranges, exactly as it does for Cloud Run events. An older
  plugin (pre-0.3.0) omits the field, so those events stay
  `claimed_unverified` until the site updates the plugin.
- **Provider-neutral output.** Every adapter in the traffic stack emits the
  same `NormalizedTrafficRequest` shape from `@ainyc/canonry-contracts`. Do
  not leak WordPress-specific types past the package boundary.

## Common Mistakes

- **Storing the Application Password in this package.** Credentials live in
  `~/.canonry/config.yaml` and are supplied per call.
- **Adding UA/referer classification here.** All classification lives in
  `packages/integration-traffic` so Cloud Run, WordPress, and future adapters
  share one rule set.
- **Calling `fetch` against the raw `baseUrl`.** Always append
  `/wp-json/canonry/v1/events` — `resolveEndpoint` does this. Hand-rolled URL
  composition will drop trailing slashes or double up paths.

## Test Ownership

- `wordpress-traffic-client.test.ts` owns normalization and native HTTP protocol behavior. Invalid-row fixtures need valid sibling fields so each rejection reaches its named guard.
- Check the returned continuation flag as well as the cursor. Cache freshness needs distinct URLs and no-cache headers on every page across multiple syncs.
- Error-body truncation needs a response longer than the limit and an independent exact expected prefix and suffix.

## See Also

- `packages/contracts/src/traffic.ts` — `NormalizedTrafficRequest`,
  `wordpressTrafficSourceConfigSchema`, `trafficConnectWordpressRequestSchema`
- `packages/integration-traffic/` — provider-neutral classifier + hourly rollup
- `packages/integration-cloud-run/` — sibling pull adapter; mirror this file
  layout when adding a new adapter
