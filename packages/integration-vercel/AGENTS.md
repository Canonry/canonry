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
| `src/drain.ts` | `drainVercelTrafficEvents` — adaptive time-sub-window drain over a wide window; retention-clamps the start; optional wall-clock `deadlineMs` stops early with `drainedThroughMs` for resumable partial progress |
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
- **Adaptive sub-window drain.** Page-number pagination has no resumable
  cursor, so a window denser than the page budget cannot be pulled in one
  pass. `drainVercelTrafficEvents` narrows the window into adaptive time
  slices: it halves the span on page-budget overflow and generally doubles
  back up after a clean slice, with `eventId` dedup across slice boundaries.
  The bisection floor is **one second** (`MIN_SUB_WINDOW_MS = 1_000`), small
  enough to drain real-world burst minutes (sites routinely hit 1000+ log
  pages in a single minute) without escalating to the floor-budget re-pull. A
  floor-width slice that still overflows the normal page budget is re-pulled
  once with the larger `FLOOR_SLICE_MAX_PAGES` budget and drained whole; nearby
  congested floor slices temporarily reuse that floor shape before probing
  wider again. A floor slice that overflows even that budget cannot be sliced
  thinner (e.g. a bot flood packing 1000+ log pages into one second). Rather
  than failing — which would freeze `lastSyncedAt` and wedge the source forever
  on that single second — the drain ingests the sample it pulled, advances past
  the slice, and records it in `truncatedSliceCount` / `truncatedSliceStartsMs`
  for the caller to surface. The **incremental sync** samples-and-advances on
  truncation (it is additive, so losing the tail of one pathological second is
  safe and `lastSyncedAt` keeps moving); the **replace-mode backfill** instead
  fails loud on truncation so it never overwrites a full window with a partial
  sample.
- **Wall-clock deadline (optional).** `deadlineMs` (with an injectable `now`,
  defaulting to `Date.now`) bounds a single drain's wall-clock cost: the loop
  stops before starting a sub-window once the clock passes it, returning
  `deadlineReached: true` and `drainedThroughMs` at the last fully-drained
  boundary. An additive incremental caller commits `[startDate, drainedThroughMs]`
  and advances `lastSyncedAt` there, so a dense or slow window converges over
  several syncs instead of one unbounded grind — which would time out the
  synchronous sync route and orphan a `running` run. Left unset, the drain runs
  to completion or `maxSubWindows` (replace-mode backfill keeps that). One
  in-flight pull can overrun the deadline, so the bound is approximate.
- **Retention clamp.** Vercel rejects a window starting before the plan's
  `request-logs` retention with HTTP 400 `ExceedsBillingLimitError`.
  `drainVercelTrafficEvents` detects that, binary-searches the retention
  boundary, clamps the start forward to what Vercel will serve, and flags the
  result `retentionClamped` instead of failing the whole drain. A normal
  recurring sync keeps the window small, so the clamp only fires on a wide
  backfill or a long-idle source. Consumers must treat `retentionClamped` as
  an incomplete pull unless explicitly accepting a gap; the API route rejects
  it so `lastSyncedAt` never advances across missing history.
- **First-sync window seeded at connect.** `POST /traffic/connect/vercel`
  seeds `lastSyncedAt = NOW` on the new `traffic_sources` row. Leaving it
  null would make the very first scheduled sync fall back to
  `DEFAULT_SYNC_WINDOW_MINUTES` (30 days), which exceeds Vercel's
  request-logs retention (~14 days) — every first sync would throw the
  retention error and leave the source permanently stuck before draining a
  single event. The trade-off: a newly connected source captures only
  going-forward traffic. Operators who want any historical recovery run an
  explicit `cnry traffic backfill --days N` (capped at retention).
- **Operator recovery from a stuck source.** An idle source whose
  `lastSyncedAt` ages past retention (or the gjelina-class case where many
  consecutive syncs failed before this drain was hardened) gets the same
  permanent-stuck symptom — the operator runs
  `cnry traffic reset <project> --source <id> --advance-to-now` to advance
  `lastSyncedAt` to NOW, clear the error state, and resume going-forward
  syncs. Skipped history is unrecoverable from the sync path; `traffic
  backfill` is the separate operator action for any of it.
- **Transient-failure retry.** `listVercelTrafficEvents` retries each page
  fetch on HTTP 429, HTTP 5xx, and raw network errors up to `maxRetries`
  times (default 3) with exponential backoff (1s, 2s, 4s). A `Retry-After`
  header on the failed response overrides the computed delay for that
  attempt. 4xx errors other than 429 — `Unauthorized`, `Forbidden`, the
  retention `400` `ExceedsBillingLimitError` — surface immediately so the
  drain's retention-probe path and the caller see the real error instead of
  waiting through the backoff. Critical for long backfills: a 13-day pull
  makes thousands of page fetches, and an unretried single 5xx anywhere in
  that run would force the whole replace-mode transaction to roll back.
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
  + the `vercel` branch of the sync / backfill dispatchers. Both drain via
  `drainVercelTrafficEvents`, which sub-windows the span and retention-clamps
  the start; the route fails when `retentionClamped` is set so an operator can
  rerun a narrower pull instead of silently skipping history.
- `plans/server-side-ai-traffic-ingestion.md` — overall traffic plan
- Vercel Configurable Log Drains (`https://vercel.com/docs/drains`): the only
  Vercel surface that exposes the client IP (`proxy.clientIp`). Relevant only
  if verified Vercel crawler hits are ever required.
