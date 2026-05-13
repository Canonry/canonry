# api-routes

## Purpose

Shared Fastify route plugins used by both the local server (`packages/canonry`) and the cloud API (`apps/api`). This is the HTTP surface for the entire platform — 109 endpoints across 25 route files.

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Plugin entry point, global error handler, `ApiRoutesOptions` interface |
| `src/helpers.ts` | `resolveProject()`, `writeAuditLog()`, `incrementUsage()` |
| `src/projects.ts` | Project CRUD routes (largest route file) |
| `src/runs.ts` | Run trigger, status, and list routes |
| `src/auth.ts` | Auth plugin — API key and session validation |
| `src/openapi.ts` | OpenAPI spec generation |
| `src/analytics.ts` | Analytics and visibility score endpoints |
| `src/google.ts` | Google Search Console integration routes |
| `src/bing.ts` | Bing Webmaster Tools routes |
| `src/ga.ts` | Google Analytics 4 routes |
| `src/intelligence.ts` | Intelligence insights and health snapshot routes |
| `src/report.ts` | `GET /projects/:name/report` (JSON DTO) and `GET /projects/:name/report.html` (standalone downloadable HTML) — aggregated client-facing AEO report bundle (13 sections) |
| `src/report-renderer.ts` | `renderReportHtml(report)` — server-side HTML renderer with inline SVG charts and inline CSS, re-exported from `@ainyc/canonry-api-routes` for the CLI |
| `src/wordpress.ts` | WordPress integration routes |
| `src/traffic.ts` | Server-side traffic ingestion routes — `POST /traffic/connect/cloud-run`, `POST /traffic/sources/:id/sync`, `POST /traffic/sources/:id/backfill` (async — returns `{ runId, status: "running" }` immediately, background task replaces rollup buckets + sample slice in the window inside one transaction, days clamped to `MAX_BACKFILL_DAYS=30` to match Cloud Logging `_Default` retention, `lastSyncedAt` only advances forward so backfill never undoes incremental progress), plus reads: `GET /traffic/sources` (list non-archived), `GET /traffic/status` (composite of detail-per-source — single call powering `canonry traffic status`), `GET /traffic/sources/:id` (detail + last-24h totals + latest run, run filtered by `runs.source_id` so multi-source is correct), `GET /traffic/events` (windowed crawler / ai-referral rollups, defaults to last 24h, totals reflect the full window even when `limit` truncates). Credentials resolved through an injected `cloudRunCredentialStore`; the Cloud Logging pull and access-token resolver are also injectable for tests. Upstream/auth failures throw `providerError()` (502) so CLI exit codes signal system errors. **Cross-sync dedupe:** `lastSyncedAt` clamps the fetch window forward to avoid wholesale re-pulls; the boundary second is then deduped via `traffic_sources.last_event_ids` (bounded ring buffer of `MAX_TRACKED_EVENT_IDS=1000` normalized event IDs from prior syncs, persisted inside the same transaction as the rollup writes). New sync IDs are prepended to retained previous IDs so a Cloud Logging dup that re-appears across multiple subsequent syncs stays deduped. |
| `src/backlinks.ts` | Backlinks (Common Crawl sync + per-project extract/summary/domains/history) routes |
| `src/doctor.ts` | `GET /doctor` and `GET /projects/:name/doctor` — runs check registry, returns `DoctorReport` |
| `src/doctor/registry.ts` | `ALL_CHECKS` — single source of truth for the doctor check catalog |
| `src/doctor/runner.ts` | `runChecks()` and `matchesCheckId()` — execute filtered checks, build the report |
| `src/doctor/checks/*.ts` | Individual `CheckDefinition`s (google-auth, bing-auth, ga-auth, providers, traffic-source). The `traffic-source` checks are adapter-agnostic — they query `traffic_sources` directly for connection/recent-data, and dispatch credential / scope validation through `DoctorContext.trafficSourceValidators[<sourceType>]`. Today only the `cloud-run` validator is registered (built in `index.ts` from the existing `cloudRunCredentialStore` + `resolveCloudRunAccessToken`); future adapters (`wp-plugin`, etc.) plug in by adding a key to that map — no doctor-side changes needed. |
| `src/discovery/routes.ts` | Tracked-basket discovery routes: `POST /projects/:name/discover/run` (writes `discovery_sessions` + `runs` rows and fires the injected `onDiscoveryRunRequested` callback — returns `{ runId, sessionId, status: "running" }` immediately), `GET /projects/:name/discover/sessions` (list), `GET /projects/:name/discover/sessions/:id` (detail + per-query probes), `GET /projects/:name/discover/sessions/:id/promote` (preview of bucketed queries + suggested new competitor domains; the actual write lands in PR 2). |
| `src/discovery/orchestrate.ts` | `executeDiscovery` — pure orchestration with injected `DiscoveryDeps` (seed/embed/probe). Persists `discovery_sessions` status transitions (`seeding` → `probing` → `completed`/`failed`), embeds + clusters via `clusterByCosine`, picks shortest-string representatives, classifies each probe into cited / aspirational / wasted-surface, and aggregates the competitor map. Caps probe budget at 100 default / 500 absolute. Plus pure helpers (`classifyProbeBucket`, `buildCompetitorMap`, `pickCanonicals`, `markSessionFailed`) for unit testing without spinning up the network. |

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

### Event callbacks

Routes fire lifecycle hooks via `opts` callbacks — `onRunCreated`, `onProviderUpdate`, `onScheduleUpdated`, `onProjectDeleted`. Fire these **after** the database transaction commits, not inside it.

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
