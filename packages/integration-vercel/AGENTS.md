# integration-vercel

## Purpose

Vercel traffic integration — pulls request logs from Vercel's internal
`request-logs` endpoint (`https://vercel.com/api/logs/request-logs`, the same
endpoint the `vercel` CLI rides) and normalizes them into provider-neutral
`NormalizedTrafficRequest` events for the traffic ingestion pipeline.

Unlike the `vercel logs --json` CLI surface, this endpoint exposes
`clientUserAgent`, `requestReferer`, and `requestSearchParams` natively — so
Canonry can classify AI crawlers and AI referrals from a pure outbound pull,
with **no in-app instrumentation** required on the user's Vercel project.

## Key Files

| File | Role |
|------|------|
| `src/client.ts` | `listVercelTrafficEvents` — page-paginated `request-logs` pull, `VercelLogsApiError` |
| `src/normalize.ts` | `normalizeVercelLogRow` — converts a raw `request-logs` row into a `NormalizedTrafficRequest` |
| `src/types.ts` | Adapter option/response shapes (`VercelRequestLogRow`, `ListVercelTrafficEventsOptions`, `VercelTrafficEventsPage`) |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Bearer-token auth.** The caller supplies a Vercel API token (personal
  access token). This package does not own the token — credentials live in
  `~/.canonry/config.yaml` under `vercelTraffic.connections` and are supplied
  per call by the consumer (API route / sync orchestrator).
- **Pull-only, page-paginated.** `listVercelTrafficEvents` accepts a
  `startDate`/`endDate` window plus `maxPages`; the endpoint paginates by
  `page` and reports `hasMoreRows`. No push, no SaaS relay. Incremental syncs
  advance the time window (the `lastSyncedAt` timestamp is the cursor), not a
  page token.
- **Internal endpoint, defensively read.** `request-logs` is not the
  documented `api.vercel.com` REST API — it is the endpoint the official CLI
  uses. Every field read is optional and tolerated-missing; never assume a
  field is present.
- **`statusCode` fallback.** Vercel's top-level `statusCode` is sometimes `0`
  (populated lazily). `normalizeVercelLogRow` falls back to the last real HTTP
  status in the merged `events[]` timeline.
- **No classification.** This package only pulls + normalizes. UA-pattern and
  AI-referer detection happen in `packages/integration-traffic` alongside
  Cloud Run and WordPress events, so the classifier rule set evolves in one
  place.
- **No client IP from the pull endpoint.** `request-logs` does not expose a
  client IP, so `remoteIp` is always `null` and Vercel crawler hits stay
  `claimed_unverified` (UA-only) in the classifier. rDNS / IP-range
  verification is impossible on this surface. Vercel only exposes the real
  client IP via a **Configurable Log Drain** (`proxy.clientIp` in the
  request-log payload), a push model (Vercel POSTs to an HTTPS receiver,
  Pro/Enterprise plan only) that is not implemented here. Verified Vercel
  hits would require building that receiver.
- **Provider-neutral output.** Every adapter in the traffic stack emits the
  same `NormalizedTrafficRequest` shape from `@ainyc/canonry-contracts`. Do not
  leak Vercel-specific types past the package boundary.

## Common Mistakes

- **Storing the API token in this package.** Credentials live in
  `~/.canonry/config.yaml` and are supplied per call.
- **Trusting top-level `statusCode`.** It is `0` on freshly-logged rows — use
  `normalizeVercelLogRow`'s `events[]` fallback.
- **Adding UA/referer classification here.** All classification lives in
  `packages/integration-traffic` so every adapter shares one rule set.
- **Treating `request-logs` as a stable contract.** It is undocumented —
  validate the response shape and fail loudly on drift rather than silently
  emitting empty rollups.

## See Also

- `packages/contracts/src/traffic.ts` — `NormalizedTrafficRequest`,
  `vercelTrafficSourceConfigSchema`, `trafficConnectVercelRequestSchema`
- `packages/integration-traffic/` — provider-neutral classifier + hourly rollup
- `packages/integration-cloud-run/` / `packages/integration-wordpress-traffic/`
  — sibling pull adapters; mirror this file layout
- `packages/api-routes/src/traffic.ts` — the consumer: `POST /traffic/connect/vercel`
  + the `vercel` branch of the sync / backfill dispatchers. The sync route drains
  the whole time window in one pass (page-number pagination has no resumable
  cursor) and fails loudly if `hasMore` is still true rather than advancing
  `lastSyncedAt` past un-pulled rows.
- `plans/server-side-ai-traffic-ingestion.md` — overall traffic plan
- Vercel Configurable Log Drains (`https://vercel.com/docs/drains`): the only
  Vercel surface that exposes the client IP (`proxy.clientIp`). Relevant only
  if verified Vercel crawler hits are ever required.
