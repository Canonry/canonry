# api-routes

## Purpose

Shared Fastify route plugins used by both the local server (`packages/canonry`) and the cloud API (`apps/api`). This is the HTTP surface for the entire platform — ~180 operations across ~27 route files.

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Plugin entry point, global error handler, `ApiRoutesOptions` interface |
| `src/helpers.ts` | `resolveProject()`, `writeAuditLog()`, `incrementUsage()`, `notProbeRun()` Drizzle predicate (see "Probe runs") |
| `src/auth.ts` | Auth plugin: API key and session validation, scope gates (see "Deployment posture and key authority") |
| `src/keys.ts` | API key management routes: `/keys` list, self, mint, revoke |
| `src/request-context.ts` / `src/runtime-logger.ts` / `src/operational-logs.ts` | Request-local actor context; shared redacting logger; `GET /operations/logs` reader |
| `src/openapi.ts` | OpenAPI spec generation, the source of the generated SDK (see "Typed responses") |
| `src/db-derived-dtos.ts` | `drizzle-zod` row schemas for the migrated tables (see "Derived row schemas") |
| `src/projects.ts` / `src/runs.ts` | Project CRUD routes (largest route file); run trigger, status, and list routes |
| `src/query-replace.ts` | `replaceProjectQueries`, the declarative tracked-query replace (see "Declarative query replacement") |
| `src/results-export.ts` | `GET /projects/:name/results/export` bulk observation export (JSON or CSV) |
| `src/analytics.ts` | Analytics and visibility score endpoints |
| `src/visibility-stats.ts` / `src/visibility-compare.ts` | `GET /visibility-stats` and `GET /visibility-compare`; pure `computeVisibilityCompare` |
| `src/visibility-attribution.ts` | `buildQueryAttribution` + `resolveCurrentQuery`: historical query attribution |
| `src/report.ts` / `src/report-renderer.ts` | Client-facing AEO report bundle (JSON + HTML); `renderReportHtml(report)`. Strings and shared display helpers come from `packages/contracts/src/report-sections.ts`, which the SPA report also renders from. It assembles its own ordered section list rather than reading one: `reportSectionOrder(report, audience)` encodes that same order for the SPA, and `test/report-renderer-bytes.test.ts` (`ORDER_CASES` / `ORDER_MATRIX`) asserts the two agree. That suite also pins the output bytes for both audiences and writes the outline goldens in `test/fixtures/report-outline/` the SPA must match; update a snapshot or golden only for an intended change, in the same commit. |
| `src/google.ts` | Google Search Console and Google Business Profile (GBP) routes |
| `src/gsc-period-comparison.ts` / `src/gbp-summary.ts` | Pure calculations behind the GSC performance tiles and `/gbp/summary` |
| `src/ga.ts` | Google Analytics 4 routes |
| `src/ads.ts` / `src/ads-live-delivery.ts` | OpenAI ads (ChatGPT ads) routes; pure live-vs-stored comparison engine |
| `src/traffic.ts` / `src/ai-referral-status.ts` | Server-side traffic ingestion routes; shared `ai_referral_events_hourly` read conditions |
| `src/referral-assessment.ts` | DB-only project/source burst diagnostic. Raw headlines unchanged; grouped candidate counts and separate adjusted estimate, with GA quotient coverage limits. |
| `src/technical-aeo.ts` | Site Health / Technical AEO routes |
| `src/measurement-property-evidence.ts` | `GET /projects/:name/measurement-property-evidence`: one Property's cursor-paged evidence |
| `src/discovery/routes.ts` / `src/discovery/orchestrate.ts` | Tracked-basket discovery routes; `executeDiscovery` orchestration (rules: `src/discovery/AGENTS.md`) |
| `src/doctor.ts` / `src/doctor/registry.ts` / `src/doctor/runner.ts` | `GET /doctor`, `GET /projects/:name/doctor` → `DoctorReport`; `ALL_CHECKS`; `runChecks()`, `matchesCheckId()` |
| `src/doctor/checks/*.ts` | Individual `CheckDefinition`s (rules: `src/doctor/AGENTS.md`) |
| `src/bing.ts` / `src/wordpress.ts` / `src/intelligence.ts` / `src/backlinks.ts` | Bing Webmaster Tools, WordPress, intelligence insight + health snapshot, and Common Crawl backlinks routes |
| `src/visibility-report.ts` | Stored-evidence `GET /projects/:name/visibility-report`. `previousEligibleVisibilityRun` uses `notProbeRun()` and ignores the date window and pinned run. An unreadable predecessor omits `comparison`. |
| `src/measurement-scope-options.ts` | `planScopeOptions` is the single scope-option builder. The visibility report calls it with `marketLinks: true`; the query-tracking workspace calls it with `marketLinks: false`. |

## Patterns

### Run admission

Visibility admission is locked by `(projectId, kind)` in `queueRunIfProjectIdle`
and the all-locations transaction. Unrelated run kinds may overlap. A location
fan-out remains one atomic admission; a second visibility sweep is refused until
all its active siblings finish. `RUN_IN_PROGRESS` includes the kind and blocking
run ID. Keep existing per-kind deduplication and shared provider limits.

### Simple measurement provenance

`captureSimpleMeasurementDefinition` stores resolved inputs before a simple run calls providers.
Capture requires a running, planless `answer-visibility` run and project-owned query IDs.
First capture is refused if the run already has stored answers.
Probe and advanced runs do not receive this definition.
Identical capture is idempotent. Changed capture fails before provider work.
The checksum includes capture time. It is not a cross-run comparability key.
Historical runs receive no inferred definition. `visibility-report` reads this storage and labels older results as unclassified.

### Query control and visibility

`query-tracking` owns workspace, preview, and commit for simple sites and v2 portfolios.
Commit requires the exact workspace version and preview token. A no-op must not publish a revision.
Before changing catalog rows, commit calls `assertNoActivePlanlessSweep` inside its write transaction, including when an Advanced plan was published after a simple sweep queued. Plan-only edits and no-ops remain available.
Query identity uses normalized text and prefers the ID already bound by the active plan.
Publication starts zero provider calls. Existing drafts become stale through their normal base-version guard.
Research rejects normalized duplicate queries before dispatch while preserving accepted text exactly. Research templates must be project-configured; editor and server expansion share declared bindings, and saved provenance remains immutable.
`visibility-report` owns metrics, denominators, scope, provenance, trends, and paginated evidence.
Mention coverage excludes unattributable answers (no verified mention of the rate's Properties, at least one unresolved) from both numerator and denominator and reports them as `unattributed`; it is `identity-ambiguous` only when none remain. `measurement-report.ts` (`attributableMentionRate`) and `visibility-report-reader.ts` (`mentionRate`) must keep the same rule, and any other missing mention signal still withholds the rate.
Historical trends use the shared compact measurement signals. Reconstruct detailed answer/source evidence only for the selected run; preserve frozen-manifest validation, selectable older evidence, and immediate visibility of changed or deleted snapshots. Do not share request-specific summaries across callers or selections.
Groups select properties. Markets select frozen `reportingScopes` execution edges. Group breakdown rows use the same selected population as direct group summaries; navigation metadata alone never adds a market filter.
The optional `marketKey` intersects a project, group, or property selection with exact market edges before every report section and answer read. It participates in cursor identity. Explicit `reportingScopes.groupKey` links navigation; never infer it from overlapping properties.
Display-only revisions and additive reporting scopes use the comparable chain only when every existing market population and all other measurement semantics remain exact. Material changes read prior evidence through its own frozen plan.
Never infer a market from a group label or reuse the browser's global run drawer parameter.

### Declarative query replacement

`src/query-replace.ts`: `replaceProjectQueries` is the ONLY way to declaratively replace a project's tracked queries (used by `POST /apply`, `PUT /queries`, `PUT /keywords`).

- It diffs by `normalizeQueryText`: unchanged texts KEEP their existing rows (ids anchor every historical snapshot's `query_id` FK — delete-all + reinsert orphans the project's whole sweep history).
- Casing-only changes update text in place, incoming duplicates collapse, and only removed rows are deleted (after `preserveSnapshotQueryText`, also exported here, stamps their text onto referencing snapshots).
- Migration v98 relinks snapshots already orphaned by the pre-fix behavior.

### Portfolio summary aggregation

Prepare the filtered run once with `createMeasurementOverviewEvaluator` and reuse
its attribution indexes for the portfolio and every group. Each group aggregates
its unique answer slots; overlapping property memberships must not multiply the
denominator. Rank all eligible properties before applying `limit`, then calculate
recommendations only for the returned properties. The limit does not truncate
market rollups or change portfolio totals. Keep the evaluator request-local so
run, revision, provider, location, and query-class selections cannot share stale data.

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

The global error handler in `index.ts` catches `AppError` instances. **Never catch and manually reply.** Call `resolveProject(app.db, name)` directly — no try/catch, no `resolveProjectSafe` helper.

```typescript
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

// ✅ Correct — let the global handler serialize
const project = resolveProject(app.db, request.params.name) // throws notFound on miss
if (!body.queries?.length) throw validationError('"queries" must be non-empty')

// ❌ Wrong — duplicates global handler logic
try { resolveProject(app.db, name) } catch (e) { reply.status(e.statusCode).send(e.toJSON()) }
```

Always use the factory functions from `@ainyc/canonry-contracts` (`validationError()`, `notFound()`, `authRequired()`, `providerError()`, …); never hand-construct `{ error: { code, message } }`. A new error code goes in the `ErrorCode` union in `packages/contracts/src/errors.ts` with a factory.

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

### Probe runs

`src/helpers.ts`: `notProbeRun()` — Drizzle predicate every dashboard/analytics/report/timeline/intelligence read MUST AND-in to exclude probe runs — see root AGENTS.md "Probe runs" section.

### Request context and runtime logging

- `src/request-context.ts` holds the async request-local authenticated actor, credential id, request id, and bounded client/session correlation. Never use caller headers as identity. `writeAuditLog` enriches HTTP writes centrally; explicit background actors remain unchanged.
- `src/runtime-logger.ts` is the shared application logger and Fastify-compatible adapter. The contracts redactor runs before console output and capture. It is exported through the `./runtime-logger` package subpath so both execution hosts use it without importing provider SDKs.
- The log reader, `src/operational-logs.ts`, is covered under "Internal observability authority" below.

### Historical competitor landscapes

- Share of voice returns `basis`, `availability`, `reason`, and the uncapped
  `comparison` domain/count set. Pins are exclusive; observed direct identities
  are a fallback requiring 3 rivals with 3 answer mentions each in the selected
  scope. Empty sets never produce a percentage. Raw `observedNames` remain
  descriptive only. Stats and report shares call `readCompetitorLandscape` with
  their selected run population; Advanced readers retain frozen assignments.

- `GET /projects/:name/analytics/competitors` is a stored-evidence read. It
  must never start discovery, classify a domain live, call a provider, or write.
- Include only completed/partial answer-visibility snapshots; count excluded
  probes and non-terminal results in the response.
- A Simple pin reinterprets stored history at read time. An Advanced market
  reads the frozen plan revision for each contributing run. Project pins plus
  active and pending-draft competitors reinterpret the selected history.
  Historical-only identities and aliases match only their frozen run revisions.
- `scope=all-markets` recomputes from raw scoped evidence. Never average market
  percentages. Compare draft pins with active pins per group. Combine all
  market aliases when identities share a registrable domain.
- Advanced pinning is a revision-guarded draft mutation. It never publishes.
- Optional `groupBy=model` adds provider/requested-model groups to the same
  stored evidence. Trim IDs and retain null/empty IDs as unknown. Never infer
  requested identity from current settings or served models. Preserve raw
  served IDs and unknown served evidence separately. `model` requires `provider`
  and narrows totals and exclusions before grouping. Group only eligible
  observations. Absent models are unmeasured, not zero. Cap groups at 50 and
  ranked rows at 100 per group. Retain every pin and all frozen Advanced scopes.
  This is descriptive, not a matched-query comparison.
- Advanced query classes follow frozen execution nodes and scoped Target edges.
  Do not combine classes by question text or query ID.
- Generated domain labels use the shared minimum brand length. Do not convert
  them into explicit aliases. Preserve curated names and existing identities.

- Pooled share of voice (`visibility-stats --share-of-voice`) is project brand mentions / (project + tracked-competitor mentions), non-brand by default (root `AGENTS.md` → "Branded vs non-brand").

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
- `src/db-derived-dtos.ts` exports `projectRowSchema`, `runRowSchema`, `scheduleRowSchema`, and `notificationRowSchema` for the migrated tables. Per-column refinements narrow JSON columns and enum text columns to the typed Zod shapes the DB writes. Use them for runtime validation of rows read from these tables; the hand-rolled DTOs in `@ainyc/canonry-contracts` remain the SDK source.

### Deployment posture and key authority (Critical)

**Both `canonry serve` (local) and `apps/api` (Cloud Run) are single-tenant deployments.** They are designed to run with exactly one trust boundary per instance — one operator's projects on one local machine, OR one team's projects on one Cloud Run service. They are NOT designed to multiplex multiple unrelated tenants behind a single instance.

#### What this means in practice

- The `api_keys` table has no `owner_id` / `tenant_id` / `account_id` column. Every domain table (`projects`, `queries`, `runs`, `notifications`, `schedules`, `google_connections`, `bing_connections`, `ga_connections`, `traffic_sources`, `agent_sessions`, `agent_memory`, `discovery_sessions`, `audit_log`) is scoped to the project, not to a caller. `resolveProject(app.db, name)` is a global `SELECT … WHERE name = ?` with no caller filter, so a full-instance `cnry_…` bearer can read or write any project on the instance. The one exception is a **project-scoped key**: `api_keys.project_id` (nullable, opt-in via `canonry key create --project <name>` or `POST /keys {projectId}`) binds a key to a single project. Enforcement: the `authPlugin` gate 403s any other `/projects/<name>` route; `assertProjectScope` covers the id-addressed routes (`/runs/:id`, `/screenshots/:id`); the global aggregation reads (`GET /projects`, `GET /runs`, `GET /history`) are filtered to the one project; the global writes `POST /runs` (batch) and `POST /apply` are restricted to it; and `POST /keys` cannot mint a broader (unscoped or sibling) key. A NULL `project_id` (every historical key) keeps full-instance access. It is a project boundary, not a multi-tenant `owner_id` boundary — shared `google_connections` and the instance-level `/settings/*` config (provider keys) are unchanged, so a scoped key with write scopes can still touch instance-global settings; the embed read-only key cannot.
- `google_connections` and `bing_connections` are uniquely keyed on `(domain, connectionType)`, not on `(project_id, connectionType)`. Two projects on the same instance that track the same `canonicalDomain` share an OAuth connection by design — operators sharing infra get this for free, malicious tenants do not.
- `GET /api/v1/projects` returns every project on the instance.
- `PUT /api/v1/settings/providers/:name` and the other `/settings/*` routes rewrite the instance's global provider keys + OAuth client credentials. Default API keys have `scopes: ['*']` and there is no `admin` scope yet.

#### Operational guidance

- **Do not deploy `apps/api` as a multi-tenant SaaS.** One Cloud Run service per team. If you need to host multiple teams, deploy multiple isolated Cloud Run services with separate databases and OAuth clients.
- **Do not hand out `cnry_…` API keys outside the trust boundary you'd give a teammate.** A leaked key reads and writes every project on the instance.
- **API key management (`canonry key create` / `list` / `revoke`, `POST /keys`, `POST /keys/:id/revoke`) is gated by the `keys.write` scope.** The default `*` key written by `canonry init` satisfies it; narrower delegate keys must declare `keys.write` explicitly. Listing keys is ungated but returns SAFE metadata only (id, name, prefix, scopes, timestamps, and the scoped project's id and name) — never the stored hash or the plaintext token. The raw `cnry_…` token is returned exactly once, at creation. Revoke sets `revokedAt` (it does not delete the row) and takes effect on the next request; you cannot revoke the key you are currently authenticating with. `GET /keys/self` (CLI `canonry key whoami`) returns the SAFE metadata of the key the request authenticated with, including the derived `readOnly` flag.
- **Read-only keys (`canonry key create --read-only`, scopes `['read']`).** A key is read-only when it carries `read` or a named `*.read` scope and no explicit write grant — see `isReadOnlyKey` in `@ainyc/canonry-contracts`. In particular, `['logs.read']` is a read-only observer without requiring another marker. The auth plugin's global `onRequest` gate denies mutating HTTP methods (POST/PUT/PATCH/DELETE) with `403 FORBIDDEN`; GET/HEAD/OPTIONS remain subject to their route permissions. POST-based preview/dry-run routes are unavailable to read-only keys by design; MCP transport envelopes allow reads but never bypass per-operation authorization. Wildcard and explicit write grants retain their existing route gates. Empty or unrecognized legacy scope lists are unchanged. One benign exception: `GET .../bing/coverage` upserts a derived daily snapshot under a read method (idempotent, no user-meaningful state) — left allowed. `canonry-mcp` probes `GET /keys/self` at startup and auto-restricts the catalog to read tools when its configured key is read-only.
- **A GET that SPENDS is gated separately from one that reads (`requirePaidReadScope`).** A few GETs return no stored data at all: they resolve the operator's OpenAI Ads credential and call the provider on demand, spending on the ad account and disclosing account identity and conversion configuration. The method-based read-only gate cannot see this — a billed GET looks exactly like a free one — so those routes carry their own ALLOW-list gate (`*`, `ads.write`, `ads.approve`, `ads.activate`) plus `requireAdminSession`, refusing a read-only key, a key scoped to something unrelated, and a view-only account. Covered today: `GET .../ads/live-delivery`, `.../ads/account`, `.../ads/geo/search`, `.../ads/conversions/pixels`, `.../ads/conversions/event-settings`. **Any new route that calls a provider live on the caller's behalf must be added to this gate** — leaving it on the read/write split means every narrow credential on the install can spend the operator's budget.
- **If a multi-tenant story becomes a requirement,** the work is substantial — add `owner_id` to every domain table, attach `apiKey.ownerId` to `request` in `authPlugin`, AND-in `eq(table.ownerId, request.apiKey.ownerId)` on every read/write, rekey `google_connections` / `bing_connections` to include `project_id`, and gate `/settings/*` on a real `admin` scope. The trade-off is real — a schema migration that touches ~15 tables and every route file. Plan accordingly.

#### Internal observability authority

- **Internal observability is operator-only.** Runtime logs and server telemetry
  reads/updates require a direct bearer ID in host-only `CANONRY_OPERATOR_KEY_IDS`.
  Unset denies all; `*`, customer admin roles, OAuth/delegated keys, browser cookies,
  and project-scoped keys never substitute for this trust grant. Normal route scopes
  still apply. Never approve a shared customer/proxy key. `/keys/self` reports
  `operator`; MCP discovery fails closed when it is missing/false. Ordinary audit
  history excludes internal telemetry state. Do not add an API that self-grants this
  host authority.
- `src/operational-logs.ts`: `GET /operations/logs` is the host-provided bounded runtime log reader, guarded by instance-wide `logs.read` and user admin role. Project-scoped keys are refused. A strict shared DTO prevents accidental payload widening; unwired hosts return 501.

#### Auth plugin gates (`src/auth.ts`)

- The auth plugin does API key and session validation. It exports `hashApiKey()` (sha256 of a raw `cnry_…` token → `api_keys.key_hash`) and `requireScope()`; both are reused by `keys.ts`.
- The `onRequest` hook also enforces the **global read-only gate**: a read-only key (`isReadOnlyKey(scopes)` from contracts — has `read`, no `*`/`*.write`) is rejected on every mutating HTTP method (POST/PUT/PATCH/DELETE) with `403`; GET/HEAD/OPTIONS pass. Method-based, so a new write route is read-only-protected automatically — see "Deployment posture and key authority" above (the read-only keys bullet in "Operational guidance").
- It also exports `requirePaidReadScope()`, the gate for GETs that SPEND (they call a provider live on the caller's behalf rather than returning stored data): an ALLOW list of `*` / `ads.write` / `ads.approve` / `ads.activate`, so a read-only key, a key scoped to something unrelated, and an empty scope list are all refused. Pair it with `requireAdminSession()` — the scope gate returns early for a signed-in person, so alone it would let a viewer spend.
- `requireInstanceAdministrator()` gates an ADMINISTRATOR SURFACE, and asks two questions where the others ask one: the caller must not be a signed-in viewer, AND must not be a credential narrower than the install (one confined to a project, or carrying anything less than the wildcard). `requireAdminSession()` alone answers only the first, because it reads a role and an API key carries none, so every key passes it. Use this wherever a narrow key reaching the route would be wrong rather than merely unusual: every `/projects/:name/agent/*` route carries it, since Aero's tools execute with the install root key and its transcript is the operator's own conversation. `isInstanceAdministrator()` is the non-throwing form, for a read that stays available but discloses less (the `config.agent-providers` doctor check consults it).
- `requireResearchGrant()` is the sibling paid-write gate: administrators and wildcard keys pass; viewers require the deployment opt-in; every other key is refused. Its `paidRead` route marker only bypasses the blanket viewer-method check and is never authority by itself. See also "Narrow research authority" at the end of this file.

#### Key management routes (`src/keys.ts`)

API key management:

- `GET /keys` (ungated list, SAFE metadata only: id/name/prefix/scopes/timestamps + `projectId`/`projectName` + derived `readOnly`, never the hash or plaintext).
- `GET /keys/self` (introspect the CURRENT request's key — ungated read, returns the same SAFE DTO incl. `readOnly`; powers `canonry key whoami` + the MCP read-only auto-detection).
- `POST /keys` (mint a `cnry_…` token, returns the plaintext ONCE; gated by the `KEYS_WRITE_SCOPE` = `keys.write`).
- `POST /keys/:id/revoke` (sets `revokedAt`, idempotent, refuses to revoke the currently-authenticating key; gated by `keys.write`).
- The derived `readOnly` flag comes from `isReadOnlyKey(scopes)` in `toApiKeyDto`.
- Audit-logs `api-key.created` / `api-key.revoked` (prefix + scopes only, never key material).

### Request parameters: identity vs tuning (Critical)

Any operation that can SKIP or REUSE work has an identity key: in-flight consolidation (discover-run), dedup keys, response caches, idempotency guards. Every new request parameter on such an operation MUST be classified explicitly, in the PR, as one of:

1. **Identity** — the parameter changes what the operation PRODUCES (its output semantics). It must join the reuse key, be persisted on the row for auditability, and ship a test asserting that two requests differing only in this parameter never share a result. Examples: `buyerDescription` on discover-run changes the seed prompt's semantics, and `locations` changes both the seed geo-constraint and the probe geo context, so both are part of the consolidation identity — same ICP with a different (or no) buyer, or a different service-area subset, never consolidates onto another session.
2. **Tuning** — the parameter only changes HOW the work runs (cost / speed / quality knobs). It may be dropped when an in-flight operation is reused, but the drop must be documented at the route and in the endpoint description. Examples: `dedupThreshold`, `maxProbes`, `probeConcurrency` on discover-run.

The failure mode this prevents: a new semantics-bearing parameter is wired parse → forward → consumer while an existing reuse branch between parse and forward silently returns another request's result (a caller gets probes seeded for a different buyer, with `200 consolidated: true` and no error). When touching such a route, read the ENTIRE handler between request parse and operation kickoff — hunting for early-return, reuse, and cache branches — not just the lines the diff touches.

### Config-as-code apply

Projects are managed via `canonry.yaml` files with Kubernetes-style structure:

```yaml
apiVersion: canonry/v1
kind: Project
metadata:
  name: my-project
spec:
  displayName: My Project
  canonicalDomain: example.com
  country: US
  language: en
  queries:
    - query one
  competitors:
    - competitor.com
  providers:
    - gemini
    - openai
```

Locations are project-scoped via `spec.locations` and `spec.defaultLocation`. Runs choose the default location, an explicit location, all configured locations, or no location. Do not model locations as query-owned state.

`spec.queries` (and its legacy `keywords` alias) is declarative WHEN PRESENT: the tracked basket is replaced to match it, and an explicit empty list clears it. A spec that OMITS the field leaves the tracked basket untouched, so a config converge that only manages providers/locations/metadata cannot wipe live queries (that wipe hit a control plane's boot-time re-apply mid-sweep, 2026-08-29).

Multiple projects can be defined in one file using `---` document separators. Apply with `canonry apply <file...>` (accepts multiple files) or `POST /api/v1/apply`. Applied project YAML is declarative input; runtime project/run data lives in the DB, while local authentication credentials live in `~/.canonry/config.yaml`.

### Schedules

One row per (project, kind), where kind ∈ {answer-visibility, traffic-sync, gbp-sync, data-refresh, backlinks-sync, site-audit, ads-sync, doctor}. `--every-days` / `--start-date` schedules are a calendar recurrence, anchored to the local date/time.

### Measurement plan property reads

- `measurement-plan property` returns one Property out of the scoped overview: mention/citation coverage plus the per-answer-engine split. A class with no assigned query reads "not measured", never 0%.
- `measurement-plan property-evidence` returns one Property's evidence, cursor-paged, for v2 revisions only (use `measurement-plan report` for a v1 revision). `--shape answers` gives one row per measured ANSWER with its cited URLs nested and both signals on the row — the only shape that shows the answers a Property was NOT cited in, since those have no URL to hang a source row on.

### Measurement property evidence

`src/measurement-property-evidence.ts`: `GET /projects/:name/measurement-property-evidence` returns cursor-paged evidence for exactly ONE Property out of one revision-pinned run, optionally narrowed by question class, provider, or location.

- It exists beside `/measurement-report` rather than as a filter on it: the report reconstructs a whole revision (every group, every Target, unpaginated) for a revision the caller names, its `groups`/`targets`/`diagnostics` are run-level and would have to start meaning something narrower whenever a filter was present, and the Branded/Non-brand class lives on a v2 assignment that the v1 revisions `/measurement-report` also serves do not record.
- Run selection, revision-mismatch refusal, and the plan lookup are the overview's (`activeMeasurementPlan` / `latestMeasurementRun` / `runRevisionMismatch` / `displayedState`), so the two surfaces can never display different runs.
- Rows come from `buildMeasurementEvidence` — the same `prepareReport` pass the report uses, minus the roll-ups — and are filtered to the usage edges the Property owns, so a sibling's citation is never credited here.
- `shape` chooses what a ROW is. `sources` (the default, so an existing caller is untouched byte for byte) is one row per cited URL under `evidence`; `answers` is one row per measured answer under `answers`, with the cited URLs nested and both signals on the row.
- The answer shape is what explains a GAP: an answer that mentioned the Property without linking it, or that named nobody, has no URL to hang a source row on and is absent from the flat shape entirely, so counting source rows understates what was measured.
- Exactly one page key is returned and the other is ABSENT rather than empty — empty is a statement about the measurement, absent is a statement about which reading was asked for.
- The two are two readings of one selection, not two computations: `buildMeasurementEvidence` derives the per-URL rows from the answer rows in one pass and the same edge/provider/location predicate narrows both.
- Paging keys per shape — `[expectedSlotId, usageEdgeId, sourceUrl]` for sources, `[expectedSlotId, usageEdgeId]` for answers, each the exact tuple the kernel sorted by, so an answer's own cited URLs can never straddle a page boundary.
- The cursor pins the active revision, displayed run, evidence fingerprint, filters, and the SHAPE it was issued for (refused by name on the other); it omits the shape field for the default, so a cursor minted before the parameter existed still walks.
- A v1 active revision is refused with `validationError` rather than answered with an invented class.
- An empty page under `measurement.state = not_measured` is the absence of a measurement, NOT a measured zero.

### Visibility analytics

- `src/analytics.ts` (analytics and visibility score endpoints): model attribution is historical evidence, never project configuration: bucket membership follows `runs.createdAt` (the logical sweep time), not asynchronous snapshot persistence. For each provider and sweep, classify all tracked snapshots as `known`, `unknown`, or `mixed`; `null`/empty model evidence is preserved, and a provider absent from a sweep is not `unknown`. Bounded windows load only the latest prior provider sweep as an unreturned anchor, so the first in-window state can emit a truthful transition.
- `src/visibility-stats.ts`: `GET /projects/:name/visibility-stats` returns aggregated per-query mention/citation counts with a sample size, pooled across many answer-visibility runs (probe-excluded, completed/partial), with an optional per-provider breakdown.
  - It reads the RAW tri-state `answerMentioned` column (`checked` = non-null) so `null` ("not checked") is never coerced to not-mentioned — `mentionRate = mentioned/checked`, `citedRate = cited/total`.
  - Window via `since`/`until` (ISO), `lastRuns`, or `month=YYYY-MM` (mutually exclusive).
  - `shareOfVoice=1` adds pooled project-vs-tracked-competitor brand-mention share via `buildMentionShare` (opt-in — answer text is loaded only on that path).
  - Pure, testable `computeVisibilityStats` + the route.
  - It also hosts `GET /projects/:name/visibility-compare?from=YYYY-MM&to=YYYY-MM` — statistically honest month-over-month AEO comparison (share-of-voice-led + drift-robust, per-snapshot K-invariant rates, common query+provider basket, Wilson intervals, CI-overlap `verdict`, `modelChanges` diff of the configured model id); the calc is the pure `computeVisibilityCompare` in `src/visibility-compare.ts`.
- `src/visibility-compare.ts`: pure `computeVisibilityCompare` (no DB/clock; the `gbp-summary.ts` precedent) — the month-over-month engine behind `GET /visibility-compare`.
  - It restricts to the query+provider basket present in BOTH months, pools per-snapshot rates (K-invariant), and computes named + cited share of voice (SoV cancels engine drift so it carries the directional call).
  - It attaches Wilson intervals (`wilsonInterval` from contracts) and a CI-overlap `verdict` (`within-noise`/`moved`/`insufficient-data`).
  - It diffs the configured `model` id per provider into `modelChanges` (a config change is visible; a silent upstream version bump is not).
  - It reuses the exported `buildQueryAttribution`/`resolveCurrentQuery` from `visibility-stats.ts`.
  - `readVisibilityCompare(db, project, query)` is the shared monthly reader for REST and readiness. The four legacy unfiltered project metrics and their frame remain unchanged. Additive class rates use tri-state signal denominators and explicit `classification-unavailable` periods.
  - Advanced class rates use frozen report definitions, exact Property/group/market edges, execution location, provider, and assignment classes. Deduplicate shared answers per class. Match only comparable definition chains; material revisions cannot share a cohort. `classComparison` carries this cohort separately on unfiltered requests; scoped requests use the top-level frame. Schema-v1 history preserves legacy output and makes class metrics unavailable.
- `src/visibility-attribution.ts`: `buildQueryAttribution` + `resolveCurrentQuery` — historical query attribution by stable `queryId` then snapshot `queryText` fallback.

### Report bundle

- `src/report.ts`: `GET /projects/:name/report` (JSON DTO) and `GET /projects/:name/report.html` (standalone downloadable HTML) — aggregated client-facing AEO report bundle (13 sections). It uses `visibility-attribution` for historical query resolution.
- `src/report-renderer.ts`: `renderReportHtml(report)` — server-side HTML renderer with inline SVG charts and inline CSS, re-exported from `@ainyc/canonry-api-routes` for the CLI.

### Results export

`src/results-export.ts`: `GET /projects/:name/results/export` — bulk download of every persisted answer-visibility query × provider observation as a versioned JSON artifact (`canonry.results-export/v1`) or spreadsheet-safe CSV attachment.

- Probe runs excluded by default (`notProbeRun()`, opt-in `includeProbes`); `kind = answer-visibility` only; inclusive `since`/`until` on run creation.
- Citation and mention exported independently (tri-state `answerMentioned` preserved, `mentionState` derived); `query` = snapshot-time text with FK fallback so removed queries keep history.
- Grounding evidence is extracted from the `rawResponse` envelope; the raw provider payload (`apiResponse`) is never exported.
- CSV cells neutralize leading `=+-@` (spreadsheet injection).
- Loads the full result set in memory — no pagination (fine single-tenant; revisit past ~100k snapshots).
- MCP: `excluded-protocol` (bulk attachment).

### Search Console totals (Critical)

The dimensioned search-data table is valid for RANKING and invalid for TOTALS. Read any clicks/impressions total from the property-level daily figures; summing per-query / per-page rows under-counts clicks (Google withholds rare queries) and over-counts impressions (one impression fans out per ranking page). `canonry google top-pages`: pages ranked by summed clicks, aggregated in SQL; the `totals` block is sourced from the property-level daily table (`totalsSource: "property-daily"`) and is null when no property figure covers the window.

`src/google.ts` (GSC):

- GSC routes: OAuth connect/callback, property selection, sync, coverage, plus `GET /gsc/top-pages` (one row per page, `GROUP BY page` + `SUM(clicks)` in SQL so the response is bounded by distinct pages, not by the dimensioned rows behind them).
- **The dimensioned `gsc_search_data` table is valid for RANKING and invalid for TOTALS**: Google withholds rare/anonymised queries so its sum under-counts clicks, and one impression fans out across every query x page x country x device combination so its sum over-counts impressions (792 vs 1,142 clicks and 45,266 vs 34,916 impressions on one real property-month).
- `top-pages` therefore sources `totals` from the un-dimensioned `gsc_daily_totals` table, labels it `totalsSource: 'property-daily'`, and returns `null` when no property figure covers the window rather than falling back to the sum; `/gsc/performance/daily` reads the same table through `readGscDailyTotals`.
- Guarded by `test/gsc-top-pages.test.ts`, whose fixture makes the two sources deliberately disagree.

### GSC period comparison

`src/gsc-period-comparison.ts` is the pure period-vs-prior-equal-period comparison behind the GSC performance tiles (no DB/clock/I/O; the `gbp-summary.ts` precedent).

- It replaced a percentage taken off the fitted trend line's own START value, which is not a baseline: the fit is unconstrained, so it predicted **-13.98** impressions on day one for a real property and the tile printed nothing on a metric that had grown six-fold, and where it did print it described the LINE rather than the data (average position read as a 45.8% improvement across a window in which the property's real position got WORSE).
- It splits the SPAN THE CALLER HANDS IN, and the route chooses that span — this is the `basis` on the response.
  - `prior-window` (the default the dashboard gets) passes TWICE the selected window, so the halves land on that window against the equal-length period immediately before it; the route reaches back one window in the same read and then scopes `daily` / `totals` / `trends` / `window` to the selection, so the prior period is evidence for the percentage and never extra days of chart.
  - `split-window` passes the selection itself and its own two halves come out — used when there is nothing COMPARABLE before the window: `window=all` has no lower bound; a prior period the sync never reached would count its unsynced days as zero, halve its own baseline, and print a rise that never happened (`readEarliestGscDataDate` is the floor that refuses it — the mirror of the trailing frontier, and read only when there is a prior period to validate); and a prior period that reaches back only into dimensioned-only history is invalid for property totals, so the prior-window comparison returns not comparable and the route FALLS BACK to the split rather than blank the tile — the comparison's own `comparable` verdict is the arbiter, because that observed-data floor spans the dimensioned table too and so cannot see the prior period's source.
- `days` is the length of ONE period, so it equals the selected window under `prior-window` and HALF of it under `split-window`: a tile printing "vs prior {days}d" for the second names a shorter period than the control the reader pressed, which is why `basis` travels with the figure and both renderers name the two date ranges.
- `basis` is OPTIONAL on the wire — a server older than the field omits it, and neither renderer may assert a basis nobody sent.
- It splits over the CALENDAR, not the sparse row endpoints or row array, because Search Analytics omits zero-data days; a quiet half inside the project's monotonic observed-data frontier is an explicit `empty` period, while a range extending beyond that frontier has no comparison because the absent days are ambiguous, not proven zero.
- The split is boundary arithmetic rather than a per-day allocation, so an extremely wide custom range stays bounded.
- Any `dimensioned` evidence makes comparison unavailable because `SUM(gsc_search_data)` is invalid for property totals even on both sides.
- An odd span drops its OLDEST day so both periods are equal (a `prior-window` span is even by construction and never loses a day).
- CTR is each period's own `clicks / impressions` and position is impression-weighted, both matching the window totals: neither is additive, and a mean of daily ratios lets a one-impression day count as much as a thousand-impression one.
- `change` stays null when the prior period is zero or unmeasured, since growth from nothing has no percentage.
- Sign is mathematical, so a POSITIVE `position` means a worse rank and the renderer owns the arrow.

### Google Business Profile

`src/google.ts` (GBP):

- OAuth connect/callback (shares the Google OAuth client; `gbp` connectionType).
- `GET /gbp/accounts` (accounts the OAuth user can access — account selection is **per project**).
- `POST /gbp/locations/discover` (resolves the account: explicit `accountName` > the account the project already tracks > first visible; re-pointing a project at a different account is destructive and requires `switchAccount: true`, which clears the old account's footprint via the shared `clearGbpProjectData` helper) + select/deselect.
- `POST /gbp/sync` (creates the `gbp-sync` run, fires `onGbpSyncRequested`).
- The read endpoints `GET /gbp/locations`, `/gbp/metrics`, `/gbp/keywords`, `/gbp/place-actions`, `/gbp/lodging` (collapses to the latest snapshot per location), and `/gbp/summary` (scopes to the project's SELECTED locations — deselected/stale rows never pollute the aggregate, and `locationCount` matches the data covered — passes the server `asOfDate` to `buildGbpSummary`, which derives the complete-day anchor + freshness + daily timeseries from the data).
- `DELETE /gbp/connection` clears the project's whole GBP footprint (locations + all synced surfaces), not just the connection.

`src/gbp-summary.ts` — pure GBP summary calculation module (no DB, no I/O):

- `computeMetricTotals`.
- `computeWindowDelta` (recent-7d vs prior-7d per metric, both windows backfilled with the union of metrics as explicit `0`s; `deltaPct` is `null` when the prior window is `0` to avoid divide-by-zero).
- `computeFreshness` (reporting-lag detection: `dataThroughDate` = last non-zero day, `latestStoredDate`, `pendingDays` vs the `asOfDate` — only TRAILING zeros count, #658).
- `buildTimeseries` (per-day pivot over the most recent ~30 days, each day flagged `pending` when it falls in the lag tail).
- `computeKeywordCoverage` (total + thresholded count/pct), `summarizePlaceActions` (CTA-type presence flags), `summarizeLodging` (lodging / populated / empty counts).
- `buildGbpSummary`, which composes them — it anchors the recent/prior windows to the **last complete day** (not the lagging tail) so a reporting-lag artifact is never shown as a real decline.
- Takes an injected `asOfDate` (never reads the clock) so it's deterministic and unit-testable. Tested exhaustively in `test/gbp-summary.test.ts`.

### GA4 traffic window

`src/ga.ts` (Google Analytics 4 routes): **ONE WINDOW PER RESPONSE.**

- `/ga/traffic` resolves a single `measuredRange` before it builds any query, and the snapshot, AI-referral, and social-referral predicates all derive from it; `windowStart` / `windowEnd` / `windowDays` report it, and `periodStart` / `periodEnd` are retained aliases.
- Exact 7d/30d/90d reads may use the matching precomputed summary for the denominator and deduplicated users.
- `all` and an omitted window mean full retained history: totals and sibling history routes stay unbounded.
- The latest sync summary may supply deduplicated users only when its dates cover every retained detail row; otherwise `totalUsers` is null. Never use that summary to narrow `all`.
- Any new figure added to `/ga/traffic`, and any new route whose numbers are read beside it, must use the same resolved range.

### OpenAI ads writes (Critical)

Activation manifest entity caps: the manifest SCHEMA enforces a fixed absolute ceiling of 1,000 entities (campaign + ad groups + ads). It participates in canonical manifest hashing and validates stored manifests, so it is never configurable and never tightens. Separately, the two entry points that accept a caller-assembled manifest (activation-grant creation and a NEW activate-tree execution) enforce an OPERATIONAL cap, default 100, tunable per deployment via CANONRY_ADS_ACTIVATION_MAX_ENTITIES (unset/empty = the default; any SET value must be a whole number between 1 and 1000 — anything else FAILS CLOSED, refusing new grant creations and activate-tree executions until the env is fixed, because silently substituting a cap nobody chose on a paid-mutation path is worse than refusing). Stored receipts are never re-capped: replay, resume-activation, and reconciliation of an existing operation ignore the operational cap.

Campaign-tree lifecycle writes are API routes (POST .../ads/campaigns|ad-groups|ads[/{id}[/pause|/archive]]), all gated on `ads.write`. Creates are always paused, status is never accepted on update, and an update requires the entity to be paused plus an expectedUpdatedAt that matches the live upstream revision.

ARCHIVE (POST .../ads/campaigns/{id}/archive, .../ad-groups/{id}/archive, .../ads/{id}/archive) is supported and IRREVERSIBLE, so it carries every guard pause carries and three more: the entity must already be paused (an active one is refused and told to pause first), the caller MUST pin the reviewed revision with expectedUpdatedAt (a stale value is refused), and there is deliberately NO status remediation — an unconfirmed archived state leaves the receipt `unknown` with `ADS_ARCHIVED_POSTCONDITION_FAILED` for reconciliation instead of a second irreversible write. Archive is intentionally NOT exposed as an MCP tool (classified `deferred`): it stays a human API surface.

The upstream `/archive` path and its `archived` status transition were VERIFIED LIVE on 2026-09-02 against a Canonry-owned test advertiser account. That run also proved the provider's LIST endpoints are eventually consistent: a campaign the direct single-entity read already reported `archived` was still reported `paused` by the campaigns list. An archive is therefore confirmed only by the archive response itself and, on reconciliation, by a direct GET by id — never by a list read.

`canonry ads live-delivery` is a LIVE provider read (status + metrics as the provider gave them) plus the stored-snapshot delta; read-only, bounded, at most one per project per minute. It sits behind `requirePaidReadScope` like the other live ads reads.

`src/ads.ts` holds the OpenAI ads (ChatGPT ads) routes: connection/status/sync + nested snapshot/insight/summary reads, and `ads.write`-gated image/campaign/ad-group/ad lifecycle mutations.

- Creates are forced paused; updates require the entity already be paused plus exact synced `upstreamUpdatedAt`.
- `landingPageQueryStringTemplate` (upstream `landing_page_configuration.query_string_template`) sets the tracking parameters the provider appends to click URLs, on a campaign, ad group, or ad. Creates take a template; updates take `null` to clear it and omit it to leave it alone. It is validated as a bare query string (unique keys, no leading `?`, no whitespace) that may carry only the documented macros, and it is NEVER expanded here — upstream does that. It joins a create's reconcile fingerprint ONLY when the caller supplied one, so receipts written before this field existed still match on recovery.
- Activation is exposed only through a separate `ads.activate` scope and a short-lived, human-issued `ads.approve` grant bound to the exact entity tree, advertiser account, and executor key; its bodyless resume route recovers only the existing operation under that exact executor, while generic reconcile rejects activation receipts.
- Every mutation inserts a durable `(project, operationKey)` receipt before I/O, replays identical requests, blocks hash conflicts, records ambiguous outcomes as `unknown`, and verifies/remediates its lifecycle postcondition.
- Manual generic recovery cannot claim a fresh pending receipt; the shared reconciler uses leases, exponential backoff, a five-attempt quarantine, exact parent/fingerprint checks, and a short-lived credential-fingerprint/account verification cache.
- Unresolved reads use opaque keyset cursors so permanent rows cannot wedge the first page.
- Provider credentials stay in config.yaml.

### OpenAI ads reads and live delivery

- `src/ads.ts`: the four LIVE planning reads (`/ads/account`, `/ads/geo/search`, `/ads/conversions/pixels`, `/ads/conversions/event-settings`) carry the same `requireAdminSession` + `requirePaidReadScope` pair as `/ads/live-delivery`, applied BEFORE the credential is resolved so a refused caller never reaches the provider: they are provider calls that spend on the ad account (the two conversions lists auto-paginate up to `OPENAI_ADS_MAX_PAGES`), not reads of stored data.
- The stored-rollup reads (`/ads/insights`, `/ads/summary`, `/ads/delivery-diagnostics`) now disclose the partial day the sync stores: each insight row carries `inProgress`, and each rollup window carries `inProgressDate`, both derived from the ACCOUNT's local date via `adsAccountToday` (a UTC-derived "today" names a different day for an account far enough east or west and would let a running total read as a closed one).

#### Live delivery read (`src/ads.ts`)

`src/ads.ts` also hosts `GET /projects/:name/ads/live-delivery`, a read-only LIVE passthrough that calls the provider on demand (no sync run, no snapshot tables) through the list/insight-only `AdsLiveDeliveryReader` seam and returns the provider's current status and metrics unaggregated, the matching stored values, and an explicit per-entity delta.

- It verifies account identity first (the key can have moved), bounds the walk with per-level caps AND a total READER-CALL budget, suppresses stored-only rows whenever the walk truncated or a sub-read failed (unwalked is not absent), and admits reads under TWO separate rules (`429` either way, `error.details.reason` says which).
- SINGLE-FLIGHT: a per-project in-flight marker, claimed synchronously before any `await` and cleared in a `finally` however the walk ends, refuses a concurrent read for as long as the first walk actually runs — a walk is unbounded in time (about 4040 upstream requests), so expressing exclusion as a duration let the claim expire mid-walk and put two walks on one account.
- MINIMUM INTERVAL: one read per project per minute between walks, counted from the last attempt that reached provider I/O — a failure after the first provider call holds the interval exactly like a success, because re-arming on failure would turn a provider outage into a retry storm, while a failure BEFORE the provider was touched writes nothing and can be retried at once (no compensating release exists, or is needed: the clock is only ever written where the provider is about to be asked something).
- `retryAfterMs` is present whenever the interval itself still blocks and absent on a concurrency refusal that has outlived it, since the running walk's remaining time is not knowable.
- The attempt Map is swept whenever an attempt is recorded so it cannot grow per-project forever; the in-flight Set needs no sweep because the `finally` bounds it to the requests actually running.
- `bounds` reports two different units on purpose: `maxReaderCalls` (40) counts logical list/insight reads, while each such read auto-paginates up to `maxPagesPerReaderCall` (`OPENAI_ADS_MAX_PAGES`, 100) and an insight read adds one more single-page request for the day in progress, so `maxUpstreamHttpRequests` (about 4040) is the honest upstream ceiling; the HTTP figure is a documented bound, since pagination happens below the reader seam.
- Every provider failure is reduced to a fixed surface label plus the numeric upstream status, never the upstream message, body, or code, so no credential material can ride an error into a response or a log.

#### Live-vs-stored comparison (`src/ads-live-delivery.ts`)

Pure live-vs-stored comparison engine (no DB/clock/network; the `gbp-summary.ts` precedent) behind `GET /ads/live-delivery`:

- `buildFieldDeltas` (status / reviewStatus / name; nothing when one side is absent, since `presence` already says it).
- `buildMetricDeltas` (per-date union of provider rows and in-window stored rollups; the provider's disjoint buckets for one date are summed, because impressions/clicks/spend/conversions are additive while the ratio metrics ctr/cpc/cpm are NOT and survive only verbatim in `liveMetrics`, and spend is converted from the insights API's decimal units to stored micros so both sides are commensurable).
- `liveComparisonWindow` (the compared date range, dated in the AD ACCOUNT's timezone via `formatIsoDateInTimeZone` because that is the zone the provider buckets by and the zone ads-sync stamps rollup dates with; deriving it in UTC drops the account's current local day for any account east of UTC and admits an unasked-for day at the other end, both of which report as drift that is not real — and the lookback is stepped by `isoDateDaysBeforeInTimeZone`, i.e. in CALENDAR days of that same zone, because a local day is 23 hours when a zone springs forward and 25 when it falls back, so a fixed 24-hour step moves the first day of the window and silently adds or omits a metric date).
- `buildLiveEntityComparison` and `summarizeLiveDrift`.
- The window's `startDate` is ALSO the date the provider range is asked to start at, from the start of that account-local day (`AdsLiveInsightsRequest.startDate`, resolved by the host through `startOfDayHourInTimeZone`, which is hour 00 except on the one day a year a zone that springs forward at midnight has no hour 00), so the first day of the window is a whole day on both sides: when the provider range instead began at the read instant's local hour, that day was a mid-day slice upstream against a full-day rollup and the diff manufactured drift on it on every read.
- The window's `endDate` is the account's CURRENT local day, and the provider range's UPPER edge is the START of that day (`startOfDayHourInTimeZone`), so the range covers the window's CLOSED days and stops. It cannot reach further: the provider refuses an `until` in the future with `400: time_ranges.end cannot be in the future`, failing the whole read, and it reports a daily bucket only when the range fully covers its boundaries, so no accepted edge returns the open day either.
- The host therefore reads that day from a SECOND, unranged provider call and merges it in (`readInsightDays` in the host's ads-sync); without it the live side omitted today while the stored side held it, and every read reported a stored-only day.
- Today is in progress on BOTH sides (live to the read instant, stored to the last ads-sync), so a difference there is snapshot staleness and is reported as the drift it is, while identical partial readings correctly report no drift.

### Traffic ingestion

`src/traffic.ts` holds the server-side traffic ingestion routes.

- Connect: `POST /traffic/connect/cloud-run`, `POST /traffic/connect/wordpress`, `POST /traffic/connect/vercel`.
  - Vercel connect seeds `lastSyncedAt = NOW` so the first scheduled sync uses a tight window — leaving it null would fall back to `DEFAULT_SYNC_WINDOW_MINUTES = 30 days`, which exceeds Vercel `request-logs` retention (~14d) and would make every first sync throw a retention error.
  - Vercel connect also **auto-creates the project's `traffic-sync` schedule** (`*/30 * * * *`, idempotent via the unique `(project, kind)` index, registered with the live scheduler through `onScheduleUpdated`) in the same transaction as the source upsert, so the source actually keeps syncing without a manual `schedule set` step: seeding `lastSyncedAt = NOW` only keeps the FIRST window tight, and the schedule is what stops the watermark drifting into an unbounded — wedging — pull on a later trigger.
- `POST /traffic/sources/:id/sync` — see "Sync dispatcher" below.
- `POST /traffic/sources/:id/backfill` is async — returns `{ runId, status: "running" }` immediately; the background task replaces rollup buckets + sample slice in the window inside one transaction, days clamped to `MAX_BACKFILL_DAYS=30` to match Cloud Logging `_Default` retention, and `lastSyncedAt` only advances forward so backfill never undoes incremental progress; supports `cloud-run`, `wordpress`, and `vercel` source types.
- `POST /traffic/sources/:id/reset` is operator recovery: requires `{ advanceToNow: true }` — advances `lastSyncedAt` to NOW, sets `status` back to `connected`, clears `last_error`; used when an idle source has aged past the upstream retention boundary and every sync now throws.
- Reads: `GET /traffic/sources` (list non-archived), `GET /traffic/status` (composite of detail-per-source — single call powering `canonry traffic status`), `GET /traffic/sources/:id` (detail + last-24h totals + latest run, run filtered by `runs.source_id` so multi-source is correct), `GET /traffic/events` (windowed crawler / ai-referral rollups, defaults to last 24h, totals reflect the full window even when `limit` truncates).
- Credentials are resolved through injected stores (`cloudRunCredentialStore`, `wordpressTrafficCredentialStore`, `vercelTrafficCredentialStore`); the per-adapter pull functions and access-token resolver are also injectable for tests.
- Upstream/auth failures throw `providerError()` (502) so CLI exit codes signal system errors.

#### Sync dispatcher

The sync route resolves the source row, sets up the run + shared error path, then branches by `sourceType`.

- Cloud Run uses a clamped time window (`startTime`/`endTime` + `lastSyncedAt` clamp).
- WordPress pages through the plugin's opaque `next_cursor` driven by the response's `hasMore` flag, persisting the final cursor to `traffic_sources.last_cursor` inside the same transaction as the rollup writes (see also "WordPress incremental traffic invariant" below).
- Vercel uses a clamped time window like Cloud Run but the `request-logs` endpoint paginates by page number with no resumable cursor, so the window is drained in adaptive time sub-windows (`drainVercelTrafficEvents`, `DEFAULT_VERCEL_MAX_PAGES=50` per sub-window). Two bounds keep a dense or drifted window from wedging the synchronous sync:
  - **(1)** the start is capped to at most `VERCEL_MAX_SYNC_WINDOW_MS=24h` before the sync instant — a watermark that drifted further is clamped forward and the skipped span is surfaced via `warn` (a backfill recovers it);
  - **(2)** the drain runs under a wall-clock budget (`DEFAULT_VERCEL_SYNC_DEADLINE_MS=4m`, override `vercelSyncDeadlineMs`) — on the budget it stops and the route commits the partial window and advances `lastSyncedAt` **only to where it drained** (the additive rollup makes a partial window safe), so the next sync resumes from there instead of one sync grinding for many minutes; if nothing drained before the budget the run **fails (visible)** rather than orphaning a `running` row.
- Retention is still enforced: if the drain can only serve a clamped tail it fails so `lastSyncedAt` never advances across missing history.
- Dedupe + rollup + telemetry are shared across all three branches.

#### Backfill dispatcher

The backfill route mirrors the same shape — `runBackfillTask` is adapter-agnostic and takes an injected `pullForBackfill: () => Promise<NormalizedTrafficRequest[]>` closure plus a `pullErrorPrefix` string so error attribution stays specific. The route handler validates credentials per `sourceType` up-front, then builds the closure:

- Cloud Run pulls a single `[startTime, endTime]` window via the Cloud Logging API.
- WordPress pages through the plugin's `[since, until)` window via opaque cursor.
- Vercel pulls the `[windowStart, windowEnd]` window with the large `BACKFILL_MAX_PAGES` budget — replace mode, so a budget exhaustion (`hasMore` still true) fails the run loudly rather than wiping the window's rollups and leaving a partial set.
- All reuse the shared replace-mode rollup transaction and the `lastSyncedAt`-never-rewinds invariant.

#### Cross-sync dedupe

- For Cloud Run and Vercel, `lastSyncedAt` clamps the fetch window forward to avoid wholesale re-pulls; the boundary second is then deduped via `traffic_sources.last_event_ids` (bounded ring buffer of `MAX_TRACKED_EVENT_IDS=1000` normalized event IDs from prior syncs, persisted inside the same transaction as the rollup writes).
- New sync IDs are prepended to retained previous IDs so a dup that re-appears across multiple subsequent syncs stays deduped.
- WordPress reuses the same ring-buffer logic for plugin-side cursor-boundary re-emissions.

### AI referral counts

`src/ai-referral-status.ts` holds the shared conditions for `ai_referral_events_hourly` reads:

- `referralLandedCondition()`: rows not answered with a proven Location redirect — 301/302/303/307/308 only, since a 304 is a served cache view, and status 0 = unobserved counts as landed on benefit of the doubt.
- `nonSubresourceReferralPathCondition()`.
- `countableReferralCondition()` composes both — the ONE condition for any figure presented as visits/sessions/arrivals.
- The redirect complement is always DERIVED as `total - landed`, never queried through a second hand-written condition.
- Status semantics come from `isLocationRedirectStatus` in contracts.

### Cloudflare traffic doctor boundary

Doctor behavior must branch on the persisted `configJson.deliveryMode`, not
only `sourceType = cloudflare`. Legacy rows with no mode are direct push.
Only `direct-push` skips pull-watermark lag; `queue-pull` sources use the
ordinary pull checks and a durable source-scoped lease. Queue messages are
acknowledged only after the receipt + rollup transaction commits; a post-commit
ACK failure relies on receipt dedupe for safe redelivery.
`traffic.source.worker-version` applies to both `direct-push` and `queue-pull`.
It compares the last-observed, ingest-recorded `lastWorkerVersion` with the shared
`CURRENT_CLOUDFLARE_WORKER_VERSION`, not the persisted
`configJson.workerVersion`, so a package upgrade detects a stale deployment
before the source is reconnected. This is latest-batch evidence, not proof that
every deployment or queued message runs one version. When `lastWorkerVersion` is null, it warns with
`traffic.worker-version.waiting-for-first-event`. A mismatch warns with
`traffic.worker-version.stale` and requires regeneration and redeployment using
the source's existing delivery mode.

### WordPress incremental traffic invariant

WordPress incremental pulls always send the plugin a half-open `[since, until)`
window. `lastCursor` is only a keyset-pagination continuation inside that
bounded query; never send it without the time bounds. Reserve a fresh window
before provider I/O by persisting its lower bound in `lastSyncedAt` and its
fixed upper bound in `wordpressPendingUntil`; failures and capped drains retry
the exact same interval. A terminal page clears both continuation fields and
advances the watermark to that upper boundary. A legacy non-null `lastCursor`
without `wordpressPendingUntil` is ambiguous old-route state and must fail
closed until an explicit reset clears it. If the plugin claims more data but
supplies no new cursor, fail before the rollup transaction. Replace-mode
WordPress backfill is forbidden while either continuation field is set.

### Backlinks

`src/backlinks.ts` (Common Crawl sync + per-project extract):

- Summary/domains/history default to `source=commoncrawl`; the source discriminator remains readable for inert historical rows from older versions.
- `GET /projects/:name/backlinks/sources` reports Common Crawl readiness plus retained-source data availability.

### Technical AEO crawl (Site Health)

- Powered by the `site-audit` run kind and `@canonry/aeo-audit`'s `runSiteCrawl`. A run crawls the sitemap plus internal-link discoveries. Defaults: 1,000 pages; edges derived by the engine from the page count (pages × 50, floor 100,000) unless `--max-edges` is set. Hard limits: 50,000 pages / 1,000,000 edges. Dead-link analysis is off unless requested.
- Progress reports the exact durable phase and raw pages found / checked / failed counters — never a synthesized percentage.
- Dead-link reports are disabled unless the run used `--check-dead-links`. A listed dead link ALWAYS has a real 4xx/5xx status: an internal target the crawler could not fetch at all (timeout, reset connection, throttling under crawl concurrency) is counted separately as `unverified` and is never listed, because a failed fetch is a fact about the crawl and not about the link. `found` and `checked` both exclude unverified targets, so "0 found, 6 unverified" reads as "nothing broken, six we could not check" rather than as a clean bill of health.

#### Routes (`src/technical-aeo.ts`)

- `POST /technical-aeo/runs` persists normalized request identity before queueing: only identical effective options reuse an active run; a sitemap, budget, depth, or dead-link difference returns `409`.
- `GET /technical-aeo/runs` is the Site Health scan history: every non-probe site-audit run newest-first, each with `hasCrawlData`.
- A `runId` naming a real surfaceable run that published no crawl (a legacy score-only scan) gets that route's own no-crawl shape, NOT a 404; only an unknown or foreign `runId` still 404s.
- Default graph reads select the latest complete non-probe crawl; explicit `runId` may inspect a partial terminal snapshot.
- The graph read carries `rootNodeKey` so the home page is identified by the server rather than guessed from a path or a depth.
- The dashboard graph reads only the persisted 20k-node / 50k-edge projection; agent reads traverse canonical page/edge rows without layout coordinates and return bounded/truncated states.
- Every link-bearing read tags each edge `isTemplate` (nav, header, or footer chrome) plus `templateSource` and `placementOccurrences` (which rule decided it and the DOM evidence behind it), accepts a `linkKind` filter (`all` by default, so an existing caller's counts do not move), and reports `templateDetection`, so an empty content-only list can never be mistaken for a real zero and no count silently mixes the placement and ubiquity rules.
- `templateSource` is derived at read time from the row plus ITS OWN scan's detection state, which is why `mapCrawlEdge` takes the detection: a scan that never recorded placement cannot report `placement`. It also reads the stored `templateRatio`, so an edge the fallback could not measure (a redirect, a canonical, an unresolved target) reports `unmeasured` instead of being credited to a rule that produced no number.
- `isTemplate` is a strict boolean on every classified row, so `linkKind=content` returns the same set on the graph read, the link list, and the neighbour read.
- The graph read adds `totalTemplateEdges` / `totalContentEdges` beside the unchanged `totalEdges`, and its ready layout says whether template links were excluded from the physics.

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

### Saved-result cleanup

`POST /projects/:name/results/clear` previews exact visibility/research run IDs by default.
Confirmation deletes saved answers and derived run evidence in one transaction. Reject active
visibility/research work, sibling-project IDs, and any other run kind. Keep queries, plans,
schedules, audit history, Site Health, backlinks, and usage accounting. Require an administrator
session or `runs.write` key. `GET research/runs` also returns safe configured API model choices;
never include credentials, quotas, or provider connection settings in that catalog.
History reads use `getCachedProviderModels` or bundled choices, never the live
`getProviderModels` callback. Cold or expired caches must not trigger discovery.

### Narrow research authority

`research.run` grants only bounded research creation, never tracking, sweeps,
settings, or credential writes. Match named capabilities to route `writeScope`
metadata; keep the shared scope helpers in contracts. Research history exposes
server-derived `access.canRun` and `access.dailyRunLimit`, separately from safe
provider metadata. Limited keys and viewer accounts share the same project/day
cap and idempotent receipts. Both `/research/runs` and `/research/batches` declare
`writeScope: research.run`; batches count each destination against the shared
cap and reject the whole batch before persistence or dispatch when over budget.
Count legacy viewer rows as well as rows with `initiatedBy.limited`. Admission
and project authorization still apply to idempotent retries. OAuth consent is intersected with the current role
and viewer opt-in. MCP's internal `delegatedUserId` retains user attribution and
viewer-only restrictions but must not change the principal's API-key kind:
paid-read and broad-instance credential gates must still run. Clients cannot
set that identity through key creation or forge it through a key name.

### Aero conversation history

`agent-conversations.ts` registers through the native host's authenticated scope,
using injected runtime hooks. All five operations require instance-administrator
authority before project lookup. New/resume snapshot pending work, atomically
archive/swap rows with the audit entry, then invalidate the runtime cache. Busy
turns cannot switch. Create `id` is identity (UUID, reused on retry); history
`offset`/`limit` are read pagination. Summaries omit message payloads. Deleting a
conversation deletes only its own compaction summaries, retaining shared notes.
