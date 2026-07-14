# api-routes

## Purpose

Shared Fastify route plugins used by both the local server (`packages/canonry`) and the cloud API (`apps/api`). This is the HTTP surface for the entire platform — ~180 operations across ~27 route files.

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Plugin entry point, global error handler, `ApiRoutesOptions` interface |
| `src/helpers.ts` | `resolveProject()`, `writeAuditLog()`, `incrementUsage()`, `notProbeRun()` (Drizzle predicate every dashboard/analytics/report/timeline/intelligence read MUST AND-in to exclude probe runs — see root AGENTS.md "Probe runs" section) |
| `src/db-derived-dtos.ts` | `drizzle-zod`-derived row schemas (`projectRowSchema`, `runRowSchema`, `scheduleRowSchema`, `notificationRowSchema`) for the migrated tables. Per-column refinements narrow JSON columns and enum text columns to the typed Zod shapes the DB writes. Use for runtime validation of rows read from these tables; the hand-rolled DTOs in `@ainyc/canonry-contracts` remain the SDK source (see the "Derived row schemas" section below). |
| `src/projects.ts` | Project CRUD routes (largest route file) |
| `src/runs.ts` | Run trigger, status, and list routes |
| `src/query-replace.ts` | `replaceProjectQueries` — the ONLY way to declaratively replace a project's tracked queries (used by `POST /apply`, `PUT /queries`, `PUT /keywords`). Diffs by `normalizeQueryText`: unchanged texts KEEP their existing rows (ids anchor every historical snapshot's `query_id` FK — delete-all + reinsert orphans the project's whole sweep history), casing-only changes update text in place, incoming duplicates collapse, and only removed rows are deleted (after `preserveSnapshotQueryText`, also exported here, stamps their text onto referencing snapshots). Migration v98 relinks snapshots already orphaned by the pre-fix behavior. |
| `src/auth.ts` | Auth plugin — API key and session validation. Exports `hashApiKey()` (sha256 of a raw `cnry_…` token → `api_keys.key_hash`) and `requireScope()`; both reused by `keys.ts`. The `onRequest` hook also enforces the **global read-only gate**: a read-only key (`isReadOnlyKey(scopes)` from contracts — has `read`, no `*`/`*.write`) is rejected on every mutating HTTP method (POST/PUT/PATCH/DELETE) with `403`; GET/HEAD/OPTIONS pass. Method-based, so a new write route is read-only-protected automatically — see the root AGENTS.md "Deployment Posture" read-only-keys bullet. |
| `src/keys.ts` | API key management — `GET /keys` (ungated list, SAFE metadata only: id/name/prefix/scopes/timestamps + derived `readOnly`, never the hash or plaintext), `GET /keys/self` (introspect the CURRENT request's key — ungated read, returns the same SAFE DTO incl. `readOnly`; powers `canonry key whoami` + the MCP read-only auto-detection), `POST /keys` (mint a `cnry_…` token, returns the plaintext ONCE; gated by the `KEYS_WRITE_SCOPE` = `keys.write`), `POST /keys/:id/revoke` (sets `revokedAt`, idempotent, refuses to revoke the currently-authenticating key; gated by `keys.write`). The derived `readOnly` flag comes from `isReadOnlyKey(scopes)` in `toApiKeyDto`. Audit-logs `api-key.created` / `api-key.revoked` (prefix + scopes only, never key material). |
| `src/openapi.ts` | OpenAPI spec generation |
| `src/analytics.ts` | Analytics and visibility score endpoints |
| `src/visibility-stats.ts` | `GET /projects/:name/visibility-stats` — aggregated per-query mention/citation counts with a sample size, pooled across many answer-visibility runs (probe-excluded, completed/partial), optional per-provider breakdown. Reads the RAW tri-state `answerMentioned` column (`checked` = non-null) so `null` ("not checked") is never coerced to not-mentioned — `mentionRate = mentioned/checked`, `citedRate = cited/total`. Window via `since`/`until` (ISO), `lastRuns`, or `month=YYYY-MM` (mutually exclusive). `shareOfVoice=1` adds pooled project-vs-tracked-competitor brand-mention share via `buildMentionShare` (opt-in — answer text is loaded only on that path). Pure, testable `computeVisibilityStats` + the route. Also hosts `GET /projects/:name/visibility-compare?from=YYYY-MM&to=YYYY-MM` — statistically honest month-over-month AEO comparison (share-of-voice-led + drift-robust, per-snapshot K-invariant rates, common query+provider basket, Wilson intervals, CI-overlap `verdict`, `modelChanges` diff of the configured model id); the calc is the pure `computeVisibilityCompare` in `src/visibility-compare.ts`. |
| `src/visibility-compare.ts` | Pure `computeVisibilityCompare` (no DB/clock; the `gbp-summary.ts` precedent) — the month-over-month engine behind `GET /visibility-compare`. Restricts to the query+provider basket present in BOTH months, pools per-snapshot rates (K-invariant), computes named + cited share of voice (SoV cancels engine drift so it carries the directional call), attaches Wilson intervals (`wilsonInterval` from contracts) and a CI-overlap `verdict` (`within-noise`/`moved`/`insufficient-data`), and diffs the configured `model` id per provider into `modelChanges` (a config change is visible; a silent upstream version bump is not). Reuses the exported `buildQueryAttribution`/`resolveCurrentQuery` from `visibility-stats.ts`. |
| `src/google.ts` | Google Search Console **and** Google Business Profile (GBP) routes. GSC: OAuth connect/callback, property selection, sync, coverage. GBP: OAuth connect/callback (shares the Google OAuth client; `gbp` connectionType), `GET /gbp/accounts` (accounts the OAuth user can access — account selection is **per project**), `POST /gbp/locations/discover` (resolves the account: explicit `accountName` > the account the project already tracks > first visible; re-pointing a project at a different account is destructive and requires `switchAccount: true`, which clears the old account's footprint via the shared `clearGbpProjectData` helper) + select/deselect, `POST /gbp/sync` (creates the `gbp-sync` run, fires `onGbpSyncRequested`), and the read endpoints `GET /gbp/locations`, `/gbp/metrics`, `/gbp/keywords`, `/gbp/place-actions`, `/gbp/lodging` (collapses to the latest snapshot per location), and `/gbp/summary` (scopes to the project's SELECTED locations — deselected/stale rows never pollute the aggregate, and `locationCount` matches the data covered — passes the server `asOfDate` to `buildGbpSummary`, which derives the complete-day anchor + freshness + daily timeseries from the data). `DELETE /gbp/connection` clears the project's whole GBP footprint (locations + all synced surfaces), not just the connection. |
| `src/gbp-summary.ts` | Pure GBP summary calculation module (no DB, no I/O) — `computeMetricTotals`, `computeWindowDelta` (recent-7d vs prior-7d per metric, both windows backfilled with the union of metrics as explicit `0`s; `deltaPct` is `null` when the prior window is `0` to avoid divide-by-zero), `computeFreshness` (reporting-lag detection: `dataThroughDate` = last non-zero day, `latestStoredDate`, `pendingDays` vs the `asOfDate` — only TRAILING zeros count, #658), `buildTimeseries` (per-day pivot over the most recent ~30 days, each day flagged `pending` when it falls in the lag tail), `computeKeywordCoverage` (total + thresholded count/pct), `summarizePlaceActions` (CTA-type presence flags), `summarizeLodging` (lodging / populated / empty counts), and `buildGbpSummary` which composes them — it anchors the recent/prior windows to the **last complete day** (not the lagging tail) so a reporting-lag artifact is never shown as a real decline. Takes an injected `asOfDate` (never reads the clock) so it's deterministic and unit-testable. Tested exhaustively in `test/gbp-summary.test.ts`. |
| `src/bing.ts` | Bing Webmaster Tools routes |
| `src/ga.ts` | Google Analytics 4 routes |
| `src/ads.ts` | OpenAI ads (ChatGPT ads) routes — `POST /ads/connect` (validates the SDK key against the upstream ad account via the injected `verifyAdsAccount`, stores the credential through `adsCredentialStore` → config.yaml, upserts the metadata row + audit), `DELETE /ads/connection`, `GET /ads/status`, `POST /ads/sync` (creates the `ads-sync` run, fires `onAdsSyncRequested`), `GET /ads/campaigns` (nested snapshots incl. context hints), `GET /ads/insights` (daily rollups; ctr/cpcMicros derived server-side, null on zero denominators), `GET /ads/summary` (campaign-level totals only — ad-group rows are subdivisions and never double-counted) |
| `src/intelligence.ts` | Intelligence insights and health snapshot routes |
| `src/report.ts` | `GET /projects/:name/report` (JSON DTO) and `GET /projects/:name/report.html` (standalone downloadable HTML) — aggregated client-facing AEO report bundle (13 sections) |
| `src/report-renderer.ts` | `renderReportHtml(report)` — server-side HTML renderer with inline SVG charts and inline CSS, re-exported from `@ainyc/canonry-api-routes` for the CLI |
| `src/wordpress.ts` | WordPress integration routes |
| `src/traffic.ts` | Server-side traffic ingestion routes — `POST /traffic/connect/cloud-run`, `POST /traffic/connect/wordpress`, `POST /traffic/connect/vercel` (Vercel connect seeds `lastSyncedAt = NOW` so the first scheduled sync uses a tight window — leaving it null would fall back to `DEFAULT_SYNC_WINDOW_MINUTES = 30 days`, which exceeds Vercel `request-logs` retention (~14d) and would make every first sync throw a retention error — and **auto-creates the project's `traffic-sync` schedule** (`*/30 * * * *`, idempotent via the unique `(project, kind)` index, registered with the live scheduler through `onScheduleUpdated`) in the same transaction as the source upsert, so the source actually keeps syncing without a manual `schedule set` step: seeding `lastSyncedAt = NOW` only keeps the FIRST window tight, and the schedule is what stops the watermark drifting into an unbounded — wedging — pull on a later trigger), `POST /traffic/sources/:id/sync`, `POST /traffic/sources/:id/backfill` (async — returns `{ runId, status: "running" }` immediately, background task replaces rollup buckets + sample slice in the window inside one transaction, days clamped to `MAX_BACKFILL_DAYS=30` to match Cloud Logging `_Default` retention, `lastSyncedAt` only advances forward so backfill never undoes incremental progress; supports `cloud-run`, `wordpress`, and `vercel` source types), `POST /traffic/sources/:id/reset` (operator recovery: requires `{ advanceToNow: true }` — advances `lastSyncedAt` to NOW, sets `status` back to `connected`, clears `last_error`; used when an idle source has aged past the upstream retention boundary and every sync now throws), plus reads: `GET /traffic/sources` (list non-archived), `GET /traffic/status` (composite of detail-per-source — single call powering `canonry traffic status`), `GET /traffic/sources/:id` (detail + last-24h totals + latest run, run filtered by `runs.source_id` so multi-source is correct), `GET /traffic/events` (windowed crawler / ai-referral rollups, defaults to last 24h, totals reflect the full window even when `limit` truncates). Credentials resolved through injected stores (`cloudRunCredentialStore`, `wordpressTrafficCredentialStore`, `vercelTrafficCredentialStore`); the per-adapter pull functions and access-token resolver are also injectable for tests. Upstream/auth failures throw `providerError()` (502) so CLI exit codes signal system errors. **Sync dispatcher:** the sync route resolves the source row, sets up the run + shared error path, then branches by `sourceType`. Cloud Run uses a clamped time window (`startTime`/`endTime` + `lastSyncedAt` clamp); WordPress pages through the plugin's opaque `next_cursor` driven by the response's `hasMore` flag, persisting the final cursor to `traffic_sources.last_cursor` inside the same transaction as the rollup writes; Vercel uses a clamped time window like Cloud Run but the `request-logs` endpoint paginates by page number with no resumable cursor, so the window is drained in adaptive time sub-windows (`drainVercelTrafficEvents`, `DEFAULT_VERCEL_MAX_PAGES=50` per sub-window). Two bounds keep a dense or drifted window from wedging the synchronous sync: **(1)** the start is capped to at most `VERCEL_MAX_SYNC_WINDOW_MS=24h` before the sync instant — a watermark that drifted further is clamped forward and the skipped span is surfaced via `warn` (a backfill recovers it); **(2)** the drain runs under a wall-clock budget (`DEFAULT_VERCEL_SYNC_DEADLINE_MS=4m`, override `vercelSyncDeadlineMs`) — on the budget it stops and the route commits the partial window and advances `lastSyncedAt` **only to where it drained** (the additive rollup makes a partial window safe), so the next sync resumes from there instead of one sync grinding for many minutes; if nothing drained before the budget the run **fails (visible)** rather than orphaning a `running` row. Retention is still enforced: if the drain can only serve a clamped tail it fails so `lastSyncedAt` never advances across missing history. Dedupe + rollup + telemetry are shared across all three branches. **Backfill dispatcher:** the backfill route mirrors the same shape — `runBackfillTask` is adapter-agnostic and takes an injected `pullForBackfill: () => Promise<NormalizedTrafficRequest[]>` closure plus a `pullErrorPrefix` string so error attribution stays specific. The route handler validates credentials per `sourceType` up-front, then builds the closure: Cloud Run pulls a single `[startTime, endTime]` window via the Cloud Logging API; WordPress pages through the plugin's `[since, until)` window via opaque cursor; Vercel pulls the `[windowStart, windowEnd]` window with the large `BACKFILL_MAX_PAGES` budget — replace mode, so a budget exhaustion (`hasMore` still true) fails the run loudly rather than wiping the window's rollups and leaving a partial set. All reuse the shared replace-mode rollup transaction and the `lastSyncedAt`-never-rewinds invariant. **Cross-sync dedupe:** for Cloud Run and Vercel, `lastSyncedAt` clamps the fetch window forward to avoid wholesale re-pulls; the boundary second is then deduped via `traffic_sources.last_event_ids` (bounded ring buffer of `MAX_TRACKED_EVENT_IDS=1000` normalized event IDs from prior syncs, persisted inside the same transaction as the rollup writes). New sync IDs are prepended to retained previous IDs so a dup that re-appears across multiple subsequent syncs stays deduped. WordPress reuses the same ring-buffer logic for plugin-side cursor-boundary re-emissions. |
| `src/backlinks.ts` | Backlinks routes — **source-aware** (`commoncrawl` \| `bing-webmaster`). Common Crawl sync + per-project extract; summary/domains/history take a `?source` filter (default `commoncrawl`) and tag rows with `source`; `GET /projects/:name/backlinks/sources` reports per-source availability (CC = `autoExtractBacklinks` + a `ready` sync; Bing = a connection for the domain); `POST /projects/:name/backlinks/bing-sync` triggers a per-project Bing inbound-links sync (gated on a Bing connection). |
| `src/doctor.ts` | `GET /doctor` and `GET /projects/:name/doctor` — runs check registry, returns `DoctorReport` |
| `src/technical-aeo.ts` | Technical AEO (site-audit) routes: `GET /projects/:name/technical-aeo` (latest scorecard + delta vs prior run), `GET /projects/:name/technical-aeo/pages` (per-page breakdown, `status`/`sort`/`limit`/`offset`), `GET /projects/:name/technical-aeo/trend` (aggregate-score history, oldest-first), `POST /projects/:name/technical-aeo/runs` (idempotent trigger — returns the in-flight run if one is queued/running, else creates a `site-audit` run and fires `onSiteAuditRequested`). All reads join `runs` and AND-in `notProbeRun()` + `kind = site-audit` + status completed/partial. |
| `src/doctor/registry.ts` | `ALL_CHECKS` — single source of truth for the doctor check catalog |
| `src/doctor/runner.ts` | `runChecks()` and `matchesCheckId()` — execute filtered checks, build the report |
| `src/doctor/checks/*.ts` | Individual `CheckDefinition`s (google-auth, gbp-auth, bing-auth, ga-auth, providers, traffic-source, content). `content` covers `content.winnability.coverage`, which measures how many cited-surface domains the shared surface classifier recognizes (own / tracked-competitor / static allow-list / stored discovery `domain_classifications`) so the ownable/ceded gate does not silently fail open, and nudges to set an ICP when the project has none. `gbp-auth` covers `gbp.auth.connection` / `gbp.auth.scopes` / `gbp.account.access` (token refresh + `business.manage` scope + the tracked account is listable via `listAccounts`, mapping `GbpApiError` 0-QPM → a `quota-pending` warn) and `gbp.data.recent-sync` (selected-location sync freshness). The `traffic-source` checks are adapter-agnostic — they query `traffic_sources` directly for connection/recent-data, and dispatch credential / scope validation through `DoctorContext.trafficSourceValidators[<sourceType>]`. v1 registers validators for `cloud-run` (service-account-token resolution), `wordpress` (probe-call against the plugin's REST endpoint), and `vercel` (probe-call against the `request-logs` endpoint — 401/403 maps to `traffic.credentials.unauthorized`), wired from the corresponding credential stores in `index.ts`. Future adapters plug in by adding a key to that map — no doctor-side changes needed. |
| `src/discovery/routes.ts` | Tracked-basket discovery routes: `POST /projects/:name/discover/run` (writes `discovery_sessions` + `runs` rows and fires the injected `onDiscoveryRunRequested` callback; concurrent duplicates consolidate onto the in-flight session, whose identity is (project, `icpDescription`, `buyerDescription`, resolved `locations`, canonical `seedProviders` — explicit `['gemini']` normalizes to the omitted default) — buyer changes seed semantics so a different/absent buyer never reuses another buyer's session, while `dedupThreshold` / `maxProbes` / `probeConcurrency` are tuning and are dropped on reuse; any NEW request field must be classified identity-or-tuning the same way (root AGENTS.md "Request Parameters: Identity vs Tuning") — returns `{ runId, sessionId, status: "running" }` immediately; resolves the request's optional `locations` label override against the project's configured locations via `resolveLocations` — unknown label → 400 — and forwards the resolved `LocationContext[]` on the callback so seed generation is geo-constrained), `GET /projects/:name/discover/sessions` (list), `GET /projects/:name/discover/sessions/:id` (detail + per-query probes), `GET /projects/:name/discover/sessions/:id/harvest` (read-only — reads the issued search-query fan-out, e.g. Gemini `groundingMetadata.webSearchQueries`, back out of the session's stored probe `raw_response` via the injected `harvestSearchQueries` seam, then runs the mandatory `gateHarvestedSearchQueries` lexical gate followed by `applyHarvestSemanticNovelty` — an embedding cosine pass over the tracked queries via the injected `embedQueries` seam (the Gemini embedder, same as discovery seeds) that drops paraphrase/synonym duplicates exact-match can't see; degrades to exact-match when embeddings are unavailable, reported as `semanticNoveltyApplied`. Returns candidate seeds ranked by probe recurrence + per-reason rejection stats incl. `semanticDuplicate`; `minProbeHits`/`anchor` query params; issue #713), `GET /projects/:name/discover/sessions/:id/promote` (read-only preview of bucketed queries + recurring suggested competitor domains of **every** classified type so the operator can see what `competitorTypes` would unlock), `POST /projects/:name/discover/sessions/:id/promote` (adopt a completed session's cited + aspirational queries plus recurring competitor domains classified `direct-competitor` into the project by default, tagged `provenance="discovery:<sessionId>"` — add-only, idempotent, single transaction + audit log; `buckets` / `includeCompetitors` / `competitorTypes` request fields scope it). `parseCompetitorMap` normalizes legacy competitor-map JSON (no `competitorType`) to `unknown`; `selectEligibleCompetitors` filters by hit floor + optional type set. |
| `src/discovery/orchestrate.ts` | `executeDiscovery` — pure orchestration with injected `DiscoveryDeps` (seed/embed/probe/classifyDomains). Persists `discovery_sessions` status transitions (`seeding` → `probing` → `completed`/`failed`), embeds + clusters via `clusterByCosine` (default threshold `DISCOVERY_DEFAULT_DEDUP_THRESHOLD`, calibrated so single-link chaining cannot bridge distinct intents), picks shortest-string representatives, records a session `warning` via `seedCollapseWarning` when dedup degenerately collapses the seed set (measured before the probe-budget slice), classifies each probe into cited / aspirational / wasted-surface and persists the probe's `answerMentioned` (the answer-text mention signal the dep computes, independent of citation; nullable for legacy rows), then runs one best-effort `classifyDomains` call to type every recurring cited domain (`direct-competitor` / `ota-aggregator` / `editorial-media` / `other`; failures fall back to `unknown`) and aggregates the typed competitor map. Caps probe budget at 100 default / 500 absolute. When 2+ seed providers ran, dedup uses a MONOTONIC multi-provider merge (`pickCanonicalsWithStats` with a `primaryMask`): it anchors on the primary provider's own clustering (identical to a single-provider run over that subset) and only ADDS novel secondary candidates, so adding a provider can never reduce the canonical count below a single-primary run (guaranteed floor; proven by a property test). Single-provider sessions are byte-identical to the pooled path. Probes run through a bounded worker pool (`probeConcurrency`, default 1 = serial, cap `DISCOVERY_PROBE_CONCURRENCY_CAP` = 8) whose results are collected by canonical index and batch-inserted in canonical order in one transaction — concurrency never changes row order, bucket counts, or failure semantics (the first probe error fails the session). Also persists the seed dep's optional raw-candidate source split onto `discovery_sessions.seed_from_answer_count` / `seed_from_grounding_count` (diagnostics only). Migration 92 widens the diagnostics into full seed provenance: `seed_raw_candidates` (the pre-filter candidate list — every live session becomes a replayable fixture for filter/dedup changes) plus `dedup_cluster_min_sims` / `dedup_band_pair_fraction` / `dedup_pairs_total` (per-cluster cohesion and the ambiguous 0.90-0.97 band mass, the calibration data for any future threshold/linkage decision). Forwards the optional `locations` (resolved `LocationContext[]`) to `deps.seed` so a location-aware seed implementation can geo-constrain its queries, and passes the FIRST resolved location to every `deps.probe` call as the probe geo context (the provider renders it exactly like a sweep location), so probes measure from the buyer's service area instead of nowhere; location-free sessions probe unchanged. Plus pure helpers (`classifyProbeBucket`, `buildCompetitorMap` — accepts an optional classification map, `pickCanonicals`, `markSessionFailed`) for unit testing without spinning up the network. |

## Discovery replay suite (quality regression)

`test/discovery-replay.test.ts` replays the deterministic seed pipeline (brand filter → exact dedup → cosine clustering → representative pick → collapse warning) against REAL captured sessions in `test/fixtures/discovery-replay/` — five ICP shapes, each with raw candidates + embedding vectors + golden expectations. CI makes zero provider calls. Two assertion tiers: GOLDEN exact equality (a deliberate pipeline change regenerates fixtures via `scripts/capture-discovery-replay-fixtures.ts` in the same PR — never loosen an assertion to pass) and INVARIANTS (canonicals >= the platform gate floor of 8, no collapse warning, branded raw candidates <= 20%). Refresh cost ~$0.50 total; see the capture script header for the procedure.

## Patterns

### Route file structure

Each file exports an async Fastify plugin function:

```typescript
import type { FastifyInstance } from 'fastify'
import type { ApiRoutesOptions } from './index.js'

export async function myRoutes(app: FastifyInstance, opts: ApiRoutesOptions) {
  app.get('/my-endpoint', async (request, reply) => {
    // handler
  })
}
```

### How to add a new route

1. Create a new file in `src/` (or add to an existing domain file).
2. Export an async plugin function following the pattern above.
3. Import and register it in `src/index.ts`.
4. Add the endpoint to the OpenAPI spec in `src/openapi.ts`.

### Error handling

The global error handler in `index.ts` catches `AppError` instances. **Never catch and manually reply.**

```typescript
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

// ✅ Correct — let the global handler serialize
const project = resolveProject(app.db, request.params.name) // throws notFound on miss
if (!body.queries?.length) throw validationError('"queries" must be non-empty')

// ❌ Wrong — duplicates global handler logic
try { resolveProject(app.db, name) } catch (e) { reply.status(e.statusCode).send(e.toJSON()) }
```

### Validation

Use Zod schemas from `@ainyc/canonry-contracts`. Parse with `.safeParse()`, throw `validationError()` on failure.

### Typed responses (Critical)

**Every new route MUST register a Zod schema for its response and reference it via `jsonResponse(...)`.** The SDK (`@ainyc/canonry-api-client`) is regenerated from this spec on every `pnpm gen`; routes that return `rawJsonResponse(..., looseObjectSchema)` give web consumers `Record<string, unknown>` and silently break the end-to-end type pipeline.

The pattern:

1. Define the response shape in `packages/contracts/src/<topic>.ts` as a Zod schema:
   ```typescript
   export const myResponseDtoSchema = z.object({ /* ... */ })
   export type MyResponseDto = z.infer<typeof myResponseDtoSchema>
   ```
2. Register it in `packages/api-routes/src/openapi-schemas.ts` (alphabetized):
   ```typescript
   const SCHEMA_TABLE = {
     // ...
     MyResponseDto: myResponseDtoSchema,
     // ...
   }
   ```
3. Reference it from the route definition in `src/openapi.ts`:
   ```typescript
   responses: {
     200: jsonResponse('Successful response.', 'MyResponseDto'),
     404: errorResponse('Not found.'),
   },
   ```
4. Run `pnpm --filter @ainyc/canonry-api-client gen` to regenerate the SDK.

`rawJsonResponse(..., looseObjectSchema)` is **capped** by the test
`packages/api-routes/test/no-new-loose-routes.test.ts` — the current count is
the high-water mark, and CI fails if it grows. To add an endpoint without a
schema you'd have to raise the cap, which is reviewable as a deliberate
decision. Don't.

For existing loose endpoints that you're typing for the first time, the same
test's TODO-comment cap will go DOWN by one as you remove the `// TODO: Add
`XxxDto` Zod schema in contracts.` placeholder. Drive both numbers toward 0
incrementally.

### Event callbacks

Routes fire lifecycle hooks via `opts` callbacks — `onRunCreated`, `onProviderUpdate`, `onScheduleUpdated`, `onProjectDeleted`. Fire these **after** the database transaction commits, not inside it.

### Derived row schemas (drizzle-zod)

`src/db-derived-dtos.ts` exports `*RowSchema` Zod validators generated from the Drizzle table definitions via `drizzle-zod`'s `createSelectSchema()`. Per-column refinements narrow:
- JSON columns whose `$type<>` is a TypeScript-only hint (drizzle-zod can't introspect those — it produces a loose `ZodUnion` fallback; the refinement supplies the actual schema)
- text columns whose values are an enum at the API layer (`configSource`, `runKind`, `runStatus`, etc.)

Use them when you want runtime validation of a row at the DB → DTO seam:

```typescript
import { projectRowSchema } from './db-derived-dtos.js'

// .parse(row) verifies the row matches the schema. Throws if the column
// types drifted (e.g. configSource got a value not in the enum).
const validated = projectRowSchema.parse(row)
```

Constraints:
- The hand-rolled DTO schemas in `@ainyc/canonry-contracts` remain the OpenAPI / SDK source. Derived schemas are an internal validator, not a public type — they live in `api-routes` because `contracts` can't import from `db` (db already imports types from contracts for `$type<>`, so the reverse would cycle).
- `db-derived-dtos.test.ts` asserts each derived schema's field set equals the table's column set, plus round-trip parse tests on representative rows. Adding a new column to a covered table fails the field-set test until the refinements + DTO are updated.
- Only the migrated tables have derived schemas today (projects, runs, schedules, notifications). Add more by importing the table, listing refinements for any column whose Zod type the SQL type alone can't express, and extending the test's `ENTRIES` table.

## Common Mistakes

- **Catching `AppError` and manually replying** — duplicates the global handler. Just throw.
- **Importing from `apps/*`** — violates the dependency boundary. This package must be app-agnostic.
- **Hardcoding `/api/v1`** — use the `routePrefix` from plugin registration. Base path support requires this.
- **Forgetting to register new route file in `index.ts`** — the routes won't be mounted.
- **Hand-constructing error JSON** — always use factory functions (`validationError()`, `notFound()`, etc.).
- **Doing async I/O inside transactions** — SQLite transactions must be synchronous.

## See Also

- `docs/architecture.md` — system overview and data flow
- `packages/contracts/` — DTOs, error codes, Zod schemas
- `packages/db/` — database schema and migration patterns
