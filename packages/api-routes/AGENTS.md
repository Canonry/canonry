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
| `src/projects.ts` / `src/runs.ts` | Project CRUD routes (largest route file); run trigger, status, and list routes |
| `src/query-replace.ts` | `replaceProjectQueries`, the declarative tracked-query replace (see "Declarative query replacement") |
| `src/competitor-writes.ts` | The one path that adds competitors or changes their curated aliases: `planCompetitorSet` / `syncCompetitorSet` (see "Competitor aliases") |
| `src/competitor-auto-aliases.ts` | Answer-derived competitor aliases over stored answers: the bounded scan, dry run and apply (see "Competitor aliases") |
| `src/market-pin-writes.ts` | What a market pin write does to answer-derived names: `beginMarketPinWrite` drops the tracked auto names the write's pins claim and reports whether the answer identity or the pins moved; `notifyMarketPinWrite` fires the hooks (see "Competitor aliases") |
| `src/snapshot-competitor-refresh.ts` | `backfillProjectAnswerMentions` / `backfillProjectAnswerMentionsInChunks`: rescores stored answer-visibility snapshots from their stored answer text, cited domains and grounding sources (`competitorFieldsOnly` for a competitor names change, `runId` for one run, `dryRun` for a preview; the chunked form yields between chunks, and each of its chunks re-reads the identity, `readAnswerIdentity` in `src/answer-identity.ts`, starting over when it changed; the one-call form reads it once). Shared by local serve, Cloud, the job runner and `canonry backfill answer-mentions`. |
| `src/results-export.ts` | `GET /projects/:name/results/export` bulk observation export (JSON or CSV) |
| `src/analytics.ts` | Analytics and visibility score endpoints |
| `src/visibility-stats.ts` / `src/visibility-compare.ts` | `GET /visibility-stats` and `GET /visibility-compare`; pure `computeVisibilityCompare` |
| `src/visibility-attribution.ts` | `buildQueryAttribution` + `resolveCurrentQuery`: historical query attribution |
| `src/google.ts` | Google Search Console and Google Business Profile (GBP) routes |
| `src/gsc-period-comparison.ts` / `src/gbp-summary.ts` | Pure calculations behind the GSC performance tiles and `/gbp/summary` |
| `src/ga.ts` | Google Analytics 4 routes |
| `src/ga-source-mover.ts` | Pure biggest-mover calculation behind `/ga/social-referral-trend` and `/ga/attribution-trend` (see "GA4 trend movers") |
| `src/ads.ts` / `src/ads-live-delivery.ts` | OpenAI ads (ChatGPT ads) routes; pure live-vs-stored comparison engine |
| `src/traffic.ts` / `src/ai-referral-status.ts` | Server-side traffic ingestion routes; shared `ai_referral_events_hourly` read conditions |
| `src/traffic-analytics.ts` | Full-window stored crawler, user-fetch and referral aggregates, exposed through `/traffic/analytics`; detail-row caps do not limit totals, operator/path/product breakdowns or history. `period` is read-selection identity, not execution tuning. |
| `src/referral-assessment.ts` | DB-only project/source burst diagnostic. Raw headlines unchanged; grouped candidate counts and separate adjusted estimate, with GA quotient coverage limits. |
| `src/technical-aeo.ts` | Site Health / Technical AEO routes |
| `src/measurement-property-evidence.ts` | `GET /projects/:name/measurement-property-evidence`: one Property's cursor-paged evidence |
| `src/discovery/routes.ts` / `src/discovery/orchestrate.ts` | Tracked-basket discovery routes; `executeDiscovery` orchestration (rules: `src/discovery/AGENTS.md`) |
| `src/doctor.ts` / `src/doctor/registry.ts` / `src/doctor/runner.ts` | `GET /doctor`, `GET /projects/:name/doctor` → `DoctorReport`; `ALL_CHECKS`; `runChecks()`, `matchesCheckId()` |
| `src/doctor/checks/*.ts` | Individual `CheckDefinition`s (rules: `src/doctor/AGENTS.md`) |
| `src/bing.ts` / `src/wordpress.ts` / `src/intelligence.ts` / `src/backlinks.ts` | Bing Webmaster Tools, WordPress, intelligence insight + health snapshot, and Common Crawl backlinks routes |
| `src/visibility-report.ts` | Stored-evidence `GET /projects/:name/visibility-report`. `previousEligibleVisibilityRun` uses `notProbeRun()` and ignores the date window and pinned run. An unreadable predecessor omits `comparison`. |
| `src/measurement-scope-options.ts` | `planScopeOptions` is the single scope-option builder. The visibility report calls it with `marketLinks: true`; the query-tracking workspace calls it with `marketLinks: false`. |
| `src/provider-batches.ts` | Reads over `provider_batches`: the run detail's `providerBatches`, `runHadProviderBatch` (fill age), `hasOutstandingProviderBatch` (scheduler `batch-pending`). Writes belong to the job runner and the poller. |
| `src/snapshot-evidence-fingerprint.ts` | The one evidence fingerprint measurement cursors pin. It excludes the dispatch provenance columns so their addition never invalidates a cursor. |
| `src/guarded-fetch.ts` | `createGuardedFetch`, the one `fetch` for a URL this instance did not choose (an operator's WordPress site, a traffic plugin endpoint, a sitemap). Each request and each redirect hop is checked with `resolveWebhookTarget` and dialed only at the checked addresses, falling back from one to the next (pinned undici `connect.lookup`; Host, SNI and the certificate keep the hostname); redirects follow the fetch rules for methods and drop Authorization, Cookie and Proxy-Authorization across origins. A refusal throws `EgressRefusedError`; the WordPress routes map it to `VALIDATION_ERROR`. Pass it on every call (`fetchImpl` on the WordPress connection and the traffic pull), never only at connect: a check followed by global `fetch` is undone by DNS rebinding and by redirects. It uses undici's own `fetch`, so a `globalThis.fetch` stub (and the test network guard) does not see its requests; test against a real local server. |
| `src/egress-policy.ts` | The one outbound address policy: `blockedAddressReason` and `isLoopbackAddress`, both decided by the address bytes. `resolveWebhookTarget` (`src/webhooks.ts`) and `resolvePublicHttpTarget` (`resolveMeasurementSitemapTarget`) classify every resolved address with it, so add or remove a range here, never in a gate. `allowLoopback` admits loopback by its bytes only. Both gates are tested against `test/egress-address-fixture.ts`. `resolveWebhookTarget` answers `localhost` and `*.localhost` with 127.0.0.1 and ::1 without asking DNS (RFC 6761), because its `dns.resolve4`/`resolve6` queries never read the hosts file. |

## Patterns

### Run admission

Visibility admission is locked by `(projectId, kind)` in `queueRunIfProjectIdle`
and the all-locations transaction. Unrelated run kinds may overlap. A location
fan-out remains one atomic admission; a second visibility sweep is refused until
all its active siblings finish. `RUN_IN_PROGRESS` includes the kind and blocking
run ID. Keep existing per-kind deduplication and shared provider limits.

Both admission points (the queue helper and the all-locations fan-out) decide
a visibility run's providers through one function, `providerAccountAdmission`
(`src/run-queue.ts`), over `heldProviderAccounts`: a provider the new run would
call (`providersARunWouldCall`: its roster less what this host cannot run) is
held back when it has a stored `code` of `PROVIDER_AUTH` / `PROVIDER_BILLING` in
each of its last `PROVIDER_ACCOUNT_FAILURE_STREAK` runs that called it. When
every provider is held, the run is refused with `PROVIDERS_FAILING` (422).
Otherwise the held ones are skipped: frozen on the run as `skipped_providers`
(`RunDto.skippedProviders`, each with its streak), never dispatched by the job
runner, and stored in its error with `skipped: true` and their account code, so
the run ends partial. The frozen simple definition and the plan manifest still
list them, so their slots read as missing and no series breaks.

Streaks are per provider over the project's newest runs (probes included,
ordered `createdAt, id`): a run that lists the provider with another code, or
in which it answered (a snapshot exists), ends its streak; a run that does not
list it and in which it did not answer did not call it and is skipped. A
`skipped: true` entry is not a call either, but its run's `skipped_providers`
streak vouches for the streak then, so the walk stops there instead of paging
back through every skipped run (a fill that later calls the provider replaces
that entry with its real outcome). It is a backoff, not a block:
`PROVIDER_ACCOUNT_RETRY_HOURS` after a provider's newest failure finished
(`finishedAt`, else `createdAt`) it is called again, so out-of-band fixes
(console top-ups, config.yaml edits) recover on their own; a refusal's
`retryAfter` is the earliest provider's. A `provider.created` audit row, or a
`provider.updated` one whose diff shows a new key (`apiKeyRotated`), model,
endpoint or configured state, after the oldest run of that provider's streak
releases it at once; a quota-only edit does not. Probes are never held back.
`force: true` skips the check and calls every provider; it is admission only,
never identity, never stored. The dashboard deliberately has no force control:
it shows the refusal, and the retry interval or a settings change recovers.

The queue helper returns `{ refused }` after the schedule claim, so a refused
calendar slot is spent, not retried every tick; `POST /runs` turns it into that
project's error row. With `auditRefusal` (the scheduler passes it) the first
refused slot after the newest failure writes one `run.refused` audit row and
returns `refusalRecorded`; later slots of the same refusal write nothing. An
all-locations fan-out counts each location as a run and freezes one decision on
every sibling. `runAdmissionState` is the read side, from the same streaks for
a sweep as the scheduler starts it: `admission` on `GET /projects/:name/runs/latest`
and on the overview's `latestRun`, and alone on `GET /projects/:name/run-admission`
(the dashboard notice). Those reads default to the scheduled roster;
`manualAdmission` beside `admission` on latest-run/overview reads and
`run-admission?selection=manual` describe an unfiltered manual launch using
the project's providers instead of a schedule override. `selection` is
read-selection identity, not tuning. Both selections use the active v2 plan's
frozen providers. Codes come from `buildProviderRunError`, which
classifies the raw provider message: never re-classify a stored `message`,
which has lost markers such as Gemini's `RESOURCE_EXHAUSTED`. Tests:
`test/run-provider-account-guard.test.ts`.

Fill expiry belongs to native HTTP completeness/admission tests for both
portfolio kinds. Control the real Date clock, including the exact 24-hour edge,
batch finish-time anchor and fallback; do not add a test-only now parameter.
Queue timestamps and real batch-gap fills must use that same clock.

### Batch dispatch (queue time)

After account holds remove providers, an explicit batch request still needs
at least one called provider that can batch. `dispatchAfterProviderAdmission`
checks this in the queue and the bulk pre-pass, so a held sole batch provider
cannot silently turn an explicit batch request into an entirely synchronous
run. `details.skippedProviders` explains those holds alongside
`details.ineligible`; a fully held roster keeps its `PROVIDERS_FAILING`
refusal. The bulk pre-pass passes `force` and the queue timestamp too.

`queueRunIfProjectIdle` freezes which providers batch into `runs.provider_dispatch_modes` inside the queue transaction, after the stamp. The rules are `resolveRunDispatchModes` in contracts; do not re-derive them. A scheduled run reads the project's `providerDispatchModes`. A manual or API run batches only on `dispatchMode: 'batch'`, and a batch request no provider can honour is a 400 whose `details.ineligible` names each reason. `POST /runs` runs the same check in its pre-pass, so one project's refusal is its own error row. `dispatchMode` is TUNING, not identity: it stays out of `measurementExecutionIdentity`, and the trigger routes never reuse an in-flight run. `providerDispatchModes` on project writes follows `providerModels` (key validation, pruning), except that `pruneProviderDispatchModes` also keeps the engines an Advanced project's active v2 revision measures (`activeRevisionProviders`): its runs measure those whatever `providers` lists, so simple and custom portfolios both keep a preference for every engine their runs measure. An omitted value leaves the stored preference untouched on PUT and apply. Fill age counts from `finishedAt` for a run with any `provider_batches` row (`runFillAgeAnchor`). The run detail's `usage` comes from `summarizeRunUsage`. `DELETE /projects/:name` awaits `cancelRunProviderBatches` for each run with a `submitted`/`ended` batch FIRST, before `onProjectDeleting` and its transaction, because the cascade removes the only rows holding the provider's batch id. It is best effort and never blocks the delete. Those awaits are the handler's only suspension point, so it re-reads the project by id after them: when a concurrent DELETE committed meanwhile, it answers the missing-project 404 without calling `onProjectDeleting`, writing an audit row or running a rollback (test: `test/project-delete-provider-batches.test.ts`). Keep every other side effect after that re-read, with no await before the commit. See `docs/batch-mode.md`.

### Simple measurement provenance

`captureSimpleMeasurementDefinition` stores resolved inputs before a simple run calls providers.
Capture requires a running, planless `answer-visibility` run and project-owned query IDs.
First capture is refused if the run already has stored answers.
Probe and advanced runs do not receive this definition.
Identical capture is idempotent. Changed capture fails before provider work, except `identity.qualifiedAliases`, which replay keeps from the first capture (it changes only what sentiment tells its evaluator, never provider execution). A captured list must equal `resolveProjectQualifiedAliases` over the captured aliases and competitors.
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
Citation coverage excludes saved answers whose source capture was incomplete from both numerator and denominator, even when a positive was captured, and reports them as `unchecked`; it is `evidence-incomplete` only when none are checked, and a missing answer (an expected slot with no observation) still withholds the rate. `measurement-report.ts` (`indexedScopeCitationRate`, `coverageRate`) and `visibility-report-reader.ts` (`citationRate`, competitor rows included) must keep the same rule, both through contracts `rateOverChecked`. Simple runs read citation state from stored cited domains, so they are never unchecked.
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

`compact=true` on measurement overview and portfolio summary keeps formatted
tool responses below the page budget, dropping whole rows with resumable cursors.
Portfolio cursors advance only `pageList` (default `weakest-properties`); the first
default page carries bounded top-four summaries of other lists and later pages
omit their rows. `list` selects exactly one complete ranking/market/evidence list
and suppresses sibling row bodies; it is cursor identity, while `limit` is tuning.
Cursors bind revision, run, filters and stored evidence. Compact pages auto-size
up to 50 whole rows when limit is omitted, under the formatted 18k budget using
logarithmic sizing. Omissions are named in `detailsOmitted`. An indivisible row
returns a validation error rather than an empty repeating page. Raw
`compact=false` retains detail fields and uncapped market behavior.

Compact portfolio reads retain the bounded `weakestAnswerSources` summary so an
agent can answer source questions directly. Its explicit basis covers the initial
weakest Property selection plus the complete zero-signal tie; the cursor preserves
that selection when later page limits change.

Compact portfolio reads without `groupKey` expose `weakestMarkets`: at most five
top-level markets ranked over their full run/filter/class populations before
paging, by mention rate, citation rate, then label/key. Both rates must be
available; eligible and excluded counts cover every top-level market. Nested
markets never participate. `tiedAtWeakest.byMetro` groups zero-signal Properties
and never supplies a metro's aggregate rate.

`answers=not-mentioned` filters portfolio evidence and competitor landscapes by
answers where none of the answer's frozen target Properties was named, including
a sibling outside the requested group; unknown identity or missing answer text
cannot establish absence. Simple landscapes apply the same rule to their project
brand. The response exposes the original population, selected answers and unknown
answers. `propertiesNeverMentioned` is independent of citations; `tiedAtWeakest`
requires both signals to be zero. Aliasless withheld never-mentioned counts use
`not_applicable`, not identity ambiguity. Mention-conditioned landscapes retain
counts but withhold competitive shares with reason `answer-selection`.
Cited-domain lists aggregate registrable domains,
deduplicated once per answer, after filtering provider infrastructure hosts.

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

### Competitor aliases

`src/competitor-writes.ts` is the only path that inserts competitors or changes their curated `aliases`: `PUT`/`POST /competitors`, `PUT /competitors/{domain}/aliases`, apply, discovery promote (rows keep `provenance = discovery:<sessionId>`), and a project PUT whose identity now claims a competitor alias. The two `DELETE /competitors` routes remove rows directly (removing a competitor cannot break another's alias) and record the discarded aliases as `deletedAliases` on the audit row. Every write plans through `planCompetitorAliases` (contracts). A 400 rejects the write when a stated alias fails (too short, too long, more than 10, or an overlap with a project brand name or written project host, or with another competitor's alias, gated domain label or written host), when a newly added domain's name overlaps another competitor's stored alias (`claimed-by-alias`: the operator removes or restates that alias first, so an add never silently strips curated work, whatever order the stored rows come in), and when a newly added domain is the project's own site, a subdomain of it or a parent of an owned domain (`competitorDomainProjectClaim`, details `ownSiteCompetitors`). An overlap is one brand key containing the other: the readers match a key as complete adjacent words under any word split of the answer, so "Tune" overlaps "Tune Spoke", "TuneSpoke" and the label `tunespoke` alike, and joined-word lookalikes ("Tune", "Tuner") are refused deliberately. The rejection names the other name as `conflictingName`. Not checked: names that only share a part ("Tune Spoke", "Spoke Works") and an alias equal to a subdomain label of another competitor's host. Two competitors' domains are never compared with each other. A stored alias is dropped and audited only when nothing in the write states it: the project's identity now claims it, or stored lists already overlap. A domain-only replace keeps rows for retained domains. Writes store `normalizeCompetitorDomain` and match stored rows in that form, and so do the by-domain routes (alias PUT, batch DELETE, the Advanced pin's alias seed), so a row an older discovery promote stored as a subdomain stays reachable without a migration. A competitor stored as several rows fails any write that must change one of them (`duplicateCompetitorRowsError`, which names the rows and the aliases to restate after `competitor remove` and `competitor add`) instead of picking one; batch DELETE removes every row of it. Alias changes audit as `competitors.aliases-updated` (alias route, including drops of other competitors' aliases) or as `aliasChanges` / `droppedCompetitorAliases` on the competitor, discovery and project audit rows, and fire `onCompetitorAliasesChanged` after commit. Both hosts answer it with the competitor-fields-only backfill, `backfillProjectAnswerMentions(db, projectId, { competitorFieldsOnly: true })` from `src/snapshot-competitor-refresh.ts` (`competitor_overlap`, `recommended_competitors`; `answer_mentioned` and snapshots without stored answer text are left alone), and answer `onAliasesChanged` (a project alias change, which also fires alone when it drops a competitor alias the new project alias claims) with the full rescore. Local serve runs them after the response, both through one per-project queue in yielding chunks that re-read the identity between chunks (`backfillProjectAnswerMentionsInChunks`, packages/canonry `createAnswerFieldRecomputeQueue`); Cloud (`apps/api`) runs them inside the request, because Cloud Run may throttle an instance once the response is sent. Both log a failed refresh and never fail the committed write. Competitor aliases are competitor names for the qualified-alias collision check (`liveCompetitorNames`, `competitorNames`).

Advanced market pins count as competitors too, because an Advanced read credits tracked competitors and the markets' pins together. `readMarketCompetitorPins` (`src/plan-competitors.ts`) reads the pins of the active revision and the pending draft (an unreadable one pins nothing), then those of every superseded revision whose answers are scored with them, marked `supersededRevision`: the landscape and the stored competitor columns score each run against its own frozen revision, so those runs still count those pins. A superseded revision counts while an answer-visibility run measured under it has stored an answer or is still queued or running; one no run used, or whose runs all failed or were cancelled before storing an answer, is not read, so it never blocks an alias or an add for good (a published revision cannot change, so a pin it holds can never be edited away). Every competitor write plans against them, the apply and project PUT previews included, so a preview checks the same names its transaction keeps. A stated alias that overlaps a pin of another registrable domain (its label, curated aliases, domain label or host) is rejected as `market-competitor`, with the pinning group keys in `markets`; a carried-over alias that overlaps one is dropped and audited as `droppedCompetitorAliases` (or on `competitors.aliases-updated`). A new domain whose name a pin's label or curated alias overlaps (not the pin's own domain name: two domains are never compared) is rejected as `claimed-by-alias` with `markets`, and discovery promote skips it (`claimedCompetitorAdds` takes the pins). `createRunCompetitorResolver` folds a pin on a tracked competitor's host, or under it, into that competitor, as the landscape merges by registrable domain, so the stored overlap counts it once. A pin on a parent or sibling host stays apart (a citation of `rival.example` is not one of `shop.rival.example`); only a tracked row an older discovery promote stored as a subdomain meets that case, and there an answer naming their shared label credits both rows in the stored overlap while the landscape counts one. Removing and re-adding that competitor (restating its aliases) stores the registrable domain and ends the split. The pin side is `requireMarketPinsClearOfCompetitorAliases` (`src/competitor-writes.ts`), run inside the transaction of every pin writer: the draft `pin-competitor` route, every `MEASUREMENT_DRAFT_ACTIONS` mutation (`upsert-competitor`, `upsert-group`), draft publish and the legacy v1 `PUT /measurement-plan`. A pin added to a market, or a new name given to an existing pin, that overlaps another tracked competitor's curated alias fails with a 400 (`claimed-by-alias`, `domain` the pin, `conflictsWith` the alias owner; "cannot be added" for a new pin, "cannot be pinned by that name" for a new name, which is checked alone), and so does one whose label or alias overlaps another tracked competitor's own domain label or host (`other-competitor`, `alias` the pin's name). `changedMarketPins` leaves unchanged pins and names out, so an overlap stored before the rule never blocks an unrelated edit. Draft create copies the active revision's pins and skips the guard; draft publish checks the pins it adds or renames relative to the active revision, which catches a draft pin held from before these checks or next to an alias an older build stored.

Answer-derived AUTO aliases (`competitors.auto_aliases`, with evidence) and operator BLOCKED names (`competitors.blocked_aliases`) sit beside curated ones. `src/competitor-auto-aliases.ts` is their only writer besides the shared writer's pruning and the block route's removal: `scanCompetitorAutoAliasEvidence` reads the newest 60 completed or partial non-probe answer-visibility runs and at most 6000 snapshots (each run's ids first, capped to what the pass may still read, then rows a page of 200 at a time with an event-loop yield between pages, so the cap holds inside a run and no run is loaded whole), passes each run's `createdAt` as its sweep key (one multi-location sweep is one sweep), scores candidates through contracts `competitor-auto-aliases.ts` with each competitor's curated aliases (a market competitor's plan label and aliases) as `AutoAliasCompetitorInput.aliases`, so an answer that writes a candidate only inside one of them does not count as naming it, and `applyCompetitorAutoAliases` re-reads the competitors inside one transaction, re-resolves (so a curated edit made during the scan wins), writes only changed rows and audits `competitors.auto-aliases-updated` (actor `system`) only when names change. Detection runs one pass per project at a time through `createProjectPassQueue` (`src/project-pass-queue.ts`): concurrent dry runs share the scan under way; an apply goes through the host's queue (`runCompetitorAutoAliasPass`, the one a storing post-run pass uses) or, without a host, a local one, and always returns a pass that started after the request. The project's `competitorAutoAliases` mode (`projects.competitor_auto_aliases`: `off`, `preview` (every project's default) or `apply`) decides what the host's unattended passes do (packages/canonry `server.ts`): `apply` stores, `preview` runs `previewCompetitorAutoAliases` and logs what it would add or remove, `off` runs nothing. `POST /competitor-auto-aliases` stores in every mode. Project create, `PUT` and apply set the mode when given and keep it when omitted (a new project starts in `preview`); export emits it only when it is not `preview`; a change is audited as `competitorAutoAliases: { before, after }` on the project audit row. Routes: `GET`/`POST /projects/{name}/competitor-auto-aliases` (dry run / apply now; a stored-evidence read, never a provider call; when the apply changed names, the route also audits `competitors.auto-aliases-apply-requested` with the request's principal beside the pass's `system` row, so a key-, MCP- or operator-started change is never mistaken for the post-sweep pass) and `POST /projects/{name}/competitors/{domain}/aliases/block` / `unblock` (by brand key; audits `competitors.aliases-blocked` / `-unblocked`). A curated alias cannot be blocked, and neither can a name the plan's own pin of that competitor carries (active revision or pending draft; 400 with `details: { domain, pinned, marketKeys }`), since the pin keeps counting it whatever detection stores. The block target is a project competitor, else a competitor the active plan pins without tracking it, else a domain with a `market_competitor_names` row (names learned for a pin a later revision dropped, or the blocks a removed competitor left); 404 otherwise. Blocked names survive the row: every removal (both `DELETE` routes, a replace or apply that drops the domain) keeps them on the domain's `market_competitor_names` row (`keepBlockedAliasesOfRemovedCompetitors`), and every new row (a re-add, a promoted market-only pin) starts with the blocked names stored there, so detection never re-applies a name the operator blocked. The path sits outside `/competitors/{id}` so UI telemetry route templates need no new fixed child. api-routes has no provider dependency, so provider citation structures arrive through the host's `competitorAnswerAnchors` option; without it only pairings written in the answer text count (`scan.providerCitations: false`). `planCompetitorSet` re-plans auto names after every curated plan (`planCompetitorAutoAliases`): an auto name a curated alias, a market pin, a project identity change or a newly added domain overlaps is dropped and audited (`autoAliasChanges`, `droppedAutoAliases`), never a reason to fail the write. `competitorIdentityChanged(plan)` (curated or auto), or a move in the learned market names (`marketNameChanges`), decides `onCompetitorAliasesChanged`; any add fires `onCompetitorAutoAliasRescan`. Every competitor list read orders by `domain`: SQLite's implicit order flipped from the unique `(project_id, domain)` index to insertion order once the row widened, so the order is now explicit. A competitor the ACTIVE Advanced plan pins without a project competitors row (a market-only pin, `readMarketCompetitors` in `src/market-competitor-names.ts`) is detected too, with its market boundary: its evidence counts only answers to its markets' questions (each answer's own revision and execution node, `createPlanPinLookup`), its plan label and aliases are its curated names, and its learned and blocked names are stored on `market_competitor_names` (never a competitors row, so it never starts counting in other markets). Published revisions are immutable, so the learned names are layered on at read time by every reader that scores a market answer against live identity (`readMarketCompetitorNames`, which re-runs `planCompetitorAutoAliases` against the current curated identity so a later curated edit wins): the run resolver (`createRunCompetitorResolver`'s third argument, so sweeps and recomputes store them, only where a run's own revision pins the domain) and the Advanced competitor landscape. A new pin of the domain in a draft copies none of them. `readMarketCompetitorNames` also returns the names of an untracked domain the active revision no longer pins, after the pinned ones, so publishing a revision that drops a pin never rewrites the runs that measured it. Detection, `readMarketCompetitorNames` and `planCompetitorSet` all pass `planCompetitorAutoAliases` the same pins the curated rules take (`readMarketCompetitorPins`: active revision, pending draft, and superseded revisions whose answers are scored with them), so no competitor learns or keeps a name a pin of another domain answers to. The names of a competitor's own active or draft pin count as already matching a new name it would learn (`already-matched`: the plan label already names it in every Advanced read), but never drop a tracked competitor's stored name (a market-only competitor's active pin names are its curated names and do), and a superseded revision's pin does not count. The pending draft belongs there because the Advanced landscape counts its pins against stored history too. A market pin write therefore moves answer-derived names on its own, and every pin writer goes through `src/market-pin-writes.ts` inside its transaction: the draft `pin-competitor` route, every draft action, draft publish (and its no-op form), discard, plan deactivation and the legacy v1 `PUT /measurement-plan` (writers that never change a pin, such as group membership, discovery commits and query-tracking publishes, are not wrapped). `beginMarketPinWrite` reads the answer identity (`readAnswerIdentity`) and the pins before the write; its `finish` drops every tracked competitor's stored auto name the post-write pins claim (`replanCompetitorAutoAliases` in `src/competitor-writes.ts`, the pruning `planCompetitorSet` does; curated aliases are refused by the pin guard instead, never rewritten), audits the drop as `autoAliasChanges` / `droppedAutoAliases` on the writer's own audit row, together with the learned market names the write claimed, released or dropped (`marketNameChanges`, from the two identity readings), and reports `identityChanged` (learned market names follow the pins at read time, so a discard, a dropped pin or a deactivation can release one) and `pinsChanged`. After commit `notifyMarketPinWrite` fires `onCompetitorAliasesChanged` (the competitor-fields recompute, so the stored columns match a fresh recompute) on an identity change and `onCompetitorAutoAliasRescan` on a pin change, since a released name may be learned again. A pin write that changes no draft or pointer touches nothing. The frozen measurement reports keep reading each revision's own names, as they do for a tracked competitor's later names. Block and unblock reach a market-only pin by domain and return a `CompetitorDto` with `marketKeys`; the detection DTO marks it with `marketKeys`. Plan answers still score tracked competitors' auto names in the stored columns (`createRunCompetitorResolver`). The Simple definition id (`stableSimpleDefinitionId` in `src/visibility-report.ts`) leaves competitor names out, so an auto name applied after a sweep never makes the next sweep `definition-changed`: the continuity it gates covers the project's own coverage, which no competitor name changes.

Every read-time competitor mention matcher builds identity from `competitorBrandAliases` / `competitorNameAliases` (contracts) over stored `{ domain, aliases, autoAliases, blockedAliases }` rows (select `competitorIdentityColumns`): mention share inputs, competitive signals (run detail, history, overview gaps, content), analytics gaps, the landscape's project pins. Curated aliases take the alias floor (3); derived domain labels keep the domain floor (4). Frozen identities stay frozen: a Simple run freezes `[label, ...competitorIdentityAliases]` (curated then auto, minus blocked) at dispatch (unchanged bytes when a competitor has none; an auto name moves the checksum only for runs dispatched after it was applied), research runs freeze named competitors, and Advanced revisions keep their plan names. An Advanced pin by domain alone (`pin-competitor` with no `aliases`) seeds a new draft competitor with the tracked competitor's curated aliases only (`trackedCompetitorAliases` in `src/measurement-draft.ts`): its auto-detected names, and the names learned for an untracked domain, would become curated plan names frozen into every revision that publishes them, where a later block or their decay out of detection could no longer take them back, so readers layer them onto the pin at read time instead.

Every read-time competitor reader scores stored answers with the names the project has now, so a names change restates every period it reads, months already reported included. The landscape reads tracked names, market pin names and learned market names; analytics mention share and project-frame `visibility-compare` share of voice read tracked competitors only (`mentionShareCompetitors`), so a pin or learned-name change leaves those figures as they were. `readCompetitorIdentityChangedAt` (`src/competitor-landscape.ts`) puts `competitorIdentityChangedAt` on the landscape, project-frame `visibility-compare` and analytics metrics responses (a scoped `visibility-compare`, a non-project `scope` or a `marketKey`, returns the frozen frame before it is read and carries none): the newest audit row that changed a curated, auto-detected or blocked name (`competitors.aliases-updated`, `competitors.auto-aliases-updated`, or a diff carrying `aliasChanges`, `autoAliasChanges`, `removedAutoAliases`, `marketNameChanges`, or a `project.updated` drop), or the publish of a v2 revision that renamed a pin the previous revision held in the same market, whichever is later; null when neither exists. Adding or removing a competitor or a pin, and a block or unblock, are names changes only when they move a stored or learned name. A write that claims, releases or drops a market-only competitor's learned name may change no stored row, so every writer that can move one compares `readMarketCompetitorNames` before and after inside its transaction and audits the difference as `marketNameChanges` (`src/market-competitor-names.ts`): a project `PUT` and apply directly; the competitor routes (`PUT`/`POST /competitors`, the alias set, block, unblock, both `DELETE`s) and discovery promote through `beginMarketNameWrite`; every market pin writer through `beginMarketPinWrite`. When names moved, each fires `onCompetitorAliasesChanged` (a pin writer through its `identityChanged`).

### Historical competitor landscapes

- Share of voice returns `basis`, `availability`, `reason`, and the uncapped
  `comparison` domain/count set. Pins are exclusive; observed direct identities
  are a fallback requiring 3 rivals with 3 answer mentions each in the selected
  scope. Empty sets never produce a percentage. Raw `observedNames` remain
  descriptive only. Visibility-stat shares call `readCompetitorLandscape` with
  their selected run population; Advanced readers retain frozen assignments.

- Historical landscape percentages require explicit `queryClass=non-brand` or
  `branded`. Omitted class and `all` return pooled counts with null shares.

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
- `src/operational-logs.ts`: `GET /operations/logs` is the host-provided bounded runtime log reader, guarded by instance-wide `logs.read` and user admin role. Project-scoped keys are refused. A strict shared DTO prevents accidental payload widening; unwired hosts return 501. Opt-in context fields (`provider`) are stripped from every entry unless the request names them in `x-canonry-log-fields` (comma list, unknown names ignored): an older stdio adapter validates the page with its strict schema and would reject the whole page on an unrecognized key. A new context field added to the strict DTO must join that opt-in list. The response sends `Vary: x-canonry-log-fields`, since the page depends on that header.

#### Auth plugin gates (`src/auth.ts`)

- The auth plugin does API key and session validation. It exports `hashApiKey()` (sha256 of a raw `cnry_…` token → `api_keys.key_hash`) and `requireScope()`; both are reused by `keys.ts`.
- Every path that renews a named-account session must reissue its browser cookie in the same response, including public session reads and native OAuth consent. A renewed database row alone leaves the browser dropping the cookie at its prior expiry. Use the host's cookie path and `cookieIsSecure` request/proxy fallback; preserve the existing idle and absolute lifetimes.
- The `onRequest` hook also enforces the **global read-only gate**: a read-only key (`isReadOnlyKey(scopes)` from contracts — has `read`, no `*`/`*.write`) is rejected on every mutating HTTP method (POST/PUT/PATCH/DELETE) with `403`; GET/HEAD/OPTIONS pass. Method-based, so a new write route is read-only-protected automatically — see "Deployment posture and key authority" above (the read-only keys bullet in "Operational guidance").
- It also exports `requirePaidReadScope()`, the gate for GETs that SPEND (they call a provider live on the caller's behalf rather than returning stored data): an ALLOW list of `*` / `ads.write` / `ads.approve` / `ads.activate`, so a read-only key, a key scoped to something unrelated, and an empty scope list are all refused. Pair it with `requireAdminSession()` — the scope gate returns early for a signed-in person, so alone it would let a viewer spend.
- `requireInstanceAdministrator()` gates an ADMINISTRATOR SURFACE, and asks two questions where the others ask one: the caller must not be a signed-in viewer, AND must not be a credential narrower than the install (one confined to a project, or carrying anything less than the wildcard). `requireAdminSession()` alone answers only the first, because it reads a role and an API key carries none, so every key passes it. Use this wherever a narrow key reaching the route would be wrong rather than merely unusual: every `/projects/:name/agent/*` route carries it, since Aero's tools execute with the install root key and its transcript is the operator's own conversation. `isInstanceAdministrator()` is the non-throwing form, for a read that stays available but discloses less (the `config.agent-providers` doctor check consults it).
- `requireResearchGrant()` is the sibling paid-write gate: administrators and wildcard keys pass; viewers require the deployment opt-in; every other key is refused. Its `paidRead` route marker only bypasses the blanket viewer-method check and is never authority by itself. See also "Narrow research authority" at the end of this file.

#### Key management routes (`src/keys.ts`)

API key management:

- `GET /keys` (ungated list, SAFE metadata only: id/name/prefix/scopes/timestamps + `projectId`/`projectName` + derived `readOnly`, never the hash or plaintext).
- `GET /keys/self` (introspect the CURRENT request's key — ungated read, returns the same SAFE DTO incl. `readOnly`; powers `canonry key whoami` + the MCP read-only auto-detection).
- `POST /keys` (mint a `cnry_…` token, returns the plaintext ONCE; gated by the `KEYS_WRITE_SCOPE` = `keys.write`).
- `POST /keys/:id/revoke` (sets `revokedAt` and deletes bound `dashboardSessions` in the same transaction, idempotent, refuses to revoke the currently-authenticating key; gated by `keys.write`). Key rotation and revocation writers must delete those sessions so restoring a key cannot revive old browser cookies.
- The derived `readOnly` flag comes from `isReadOnlyKey(scopes)` in `toApiKeyDto`.
- Audit-logs `api-key.created` / `api-key.revoked` (prefix + scopes only, never key material).

### Request parameters: identity vs tuning (Critical)

Any operation that can SKIP or REUSE work has an identity key: in-flight consolidation (discover-run), dedup keys, response caches, idempotency guards. Every new request parameter on such an operation MUST be classified explicitly, in the PR, as one of:

1. **Identity** — the parameter changes what the operation PRODUCES (its output semantics). It must join the reuse key, be persisted on the row for auditability, and ship a test asserting that two requests differing only in this parameter never share a result. Examples: `buyerDescription` on discover-run changes the seed prompt's semantics, and `locations` changes both the seed geo-constraint and the probe geo context, so both are part of the consolidation identity — same ICP with a different (or no) buyer, or a different service-area subset, never consolidates onto another session.
2. **Tuning** — the parameter only changes HOW the work runs (cost / speed / quality knobs). It may be dropped when an in-flight operation is reused, but the drop must be documented at the route and in the endpoint description. Examples: `dedupThreshold`, `maxProbes`, `probeConcurrency` on discover-run.

The failure mode this prevents: a new semantics-bearing parameter is wired parse → forward → consumer while an existing reuse branch between parse and forward silently returns another request's result (a caller gets probes seeded for a different buyer, with `200 consolidated: true` and no error). When touching such a route, read the ENTIRE handler between request parse and operation kickoff — hunting for early-return, reuse, and cache branches — not just the lines the diff touches.

A saved project setting that fills an omitted identity parameter joins identity as its RESOLVED value. Site Health: `POST /technical-aeo/runs` resolves an omitted `maxPages` to the project's `siteAuditMaxPages`, else the full site, in `normalizeSiteAuditRunRequest` BEFORE `siteAuditRequestIdentity`, and the scheduler resolves the same way, so a run records the budget it used. Changing the saved budget while a scan is active makes the next omitted-budget request a different identity: it gets `409 OPERATION_IN_PROGRESS`, not the running scan.

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
    - domain: spoketuneworks.example   # curated answer-text names
      aliases: [TuneSpoke]
  providers:
    - gemini
    - openai
```

Locations are project-scoped via `spec.locations` and `spec.defaultLocation`. Runs choose the default location, an explicit location, all configured locations, or no location. Do not model locations as query-owned state.

`spec.competitors` always replaces the competitor domain set, but rows for domains that stay are kept (id, provenance, aliases). An entry is a domain string or `{ domain, aliases }`: a string (or an object without `aliases`) keeps that competitor's stored aliases, an object with `aliases` sets them exactly (`[]` clears). Stated aliases that fail the shared rules fail the apply before any write; carried-over aliases that no longer qualify (the spec's project identity now claims the name) are dropped and audited as `droppedCompetitorAliases`. Export writes aliased competitors as objects so export then apply round-trips.

`spec.queries` (and its legacy `keywords` alias) is declarative WHEN PRESENT: the tracked basket is replaced to match it, and an explicit empty list clears it. A spec that OMITS the field leaves the tracked basket untouched, so a config converge that only manages providers/locations/metadata cannot wipe live queries (that wipe hit a control plane's boot-time re-apply mid-sweep, 2026-08-29).

`spec.siteAuditMaxPages` (the Site Health page budget for scans that set none, 1 to 50,000) follows the same rule: present sets it, `null` resets it to the full site, absent keeps the stored value. Project `PUT` keeps an omitted value too, because the dashboard and CLI resend the whole project. A new project (POST, PUT create, or apply) starts at the given value or `null`. Project reads and the apply response always carry it (`null` = full site); export emits it only when non-null.

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
  - `readVisibilityCompare(db, project, query)` is the shared monthly reader for REST, CLI and MCP; `readVisibilityContinuity(db, project, months)` returns only its continuity gates for readiness (the project frame, plus the frozen class frame when both months are schema-v2 history), without matching answer text. The four legacy unfiltered project metrics and their frame remain unchanged. Additive class rates use tri-state signal denominators and explicit `classification-unavailable` periods.
  - Advanced class rates use frozen report definitions, exact Property/group/market edges, execution location, provider, and assignment classes. Deduplicate shared answers per class. Match only comparable definition chains; material revisions cannot share a cohort. Runs of a display-only revision chain (relabels, an added market) read through the chain's newest definition, as the report does, so an added market compares across the revision. A scoped request leaves out runs whose definition lacks the scope and refuses only when no run in either month measured it. `classComparison` carries this cohort separately when no scope or marketKey is requested (provider/location narrow both frames with the reader's case-insensitive match); scoped requests use the frozen frame at the top level and refuse months with unreconstructable (schema-v1) runs rather than drop them. Frozen-frame answers with incomplete source capture leave every citation figure and are counted in `excludedUnknown`. Schema-v1 history preserves legacy output and makes class metrics unavailable.
- `src/visibility-attribution.ts`: `buildQueryAttribution` + `resolveCurrentQuery` — historical query attribution by stable `queryId` then snapshot `queryText` fallback.

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

- GSC routes: OAuth connect/callback, property selection, sync, coverage, plus `GET /gsc/top-pages` (one row per page, `GROUP BY page` + `SUM(clicks)` in SQL so the response is bounded by distinct pages, not by the dimensioned rows behind them), and `GET /gsc/query-totals` (one row per named query over a window, folded, ordered and paged in SQL by `readGscQueryTotalsPage`, which a parity test holds to `mergeGscQueryTotalsWithFallback` so paged and unpaged readers agree; a page reads only its own rows; read-only, no Google call). Its `window.earliestDataDate` comes from `readEarliestGscQueryDataDate`: the per-query tables only, never `gsc_daily_totals`, which can start before any per-query row was synced.
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
- Upstream Google 401 errors return `FORBIDDEN` (403) with `reason: gbp-reconnect` and `upstreamStatus: 401`; reconnect the Google connection without ending the caller's Canonry session. Canonry 401 is reserved for its own authentication failures.
- `GET /gbp/accounts` (accounts the OAuth user can access — account selection is **per project**).
- `POST /gbp/locations/discover` (resolves the account: explicit `accountName` > the account the project already tracks > first visible; re-pointing a project at a different account is destructive and requires `switchAccount: true`, which clears the old account's footprint via the shared `clearGbpProjectData` helper) + select/deselect.
- `POST /gbp/sync` (creates the `gbp-sync` run, fires `onGbpSyncRequested`).
- The read endpoints `GET /gbp/locations`, `/gbp/metrics`, `/gbp/keywords`, `/gbp/place-actions`, `/gbp/lodging` (collapses to the latest snapshot per location), and `/gbp/summary` (scopes to the project's SELECTED locations — deselected/stale rows never pollute the aggregate, and `locationCount` matches the data covered — passes the server `asOfDate` to `buildGbpSummary`, which derives the complete-day anchor + freshness + daily timeseries from the data).
- `GET /gbp/reviews` (stored reviews newest first, `locationName` / `negative` / `limit` filters, `total` counted before the limit; plus each selected location's v4 `reviewsAccess` and its latest rating from whichever origin was observed most recently). `negative` and `replied` are derived here, with the project's `negativeReviewMaxStars` (echoed as `negativeMaxStars`) through `isNegativeReviewRating` in contracts, so no client re-derives them.
- `DELETE /gbp/connection` clears the project's whole GBP footprint (locations + all synced surfaces, including reviews and rating history), not just the connection.

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
- Row shares are computed here, never in a surface: each `aiReferrals` / `socialReferrals` row's `share` comes from `breakdownShares`, so a table adds up to 1 (AI rows over their own sum, which can sit below `aiSessionsDeduped` because that total picks the winning lens per day), and each top page's `organicShare` from `shareOf`.

### GA4 trend movers

`src/ga-source-mover.ts`: `findBiggestMover` picks the source whose sessions changed most, in either direction, over the last 7 days against the 7 before.

- Every source seen in EITHER period is a candidate, so a source that stopped sending sessions is a -100% mover.
- `changePct` comes from `deltaPercent` and is null from a zero prior; `changeBasis` is then `new`. Never fall back to a number: growth from nothing is not +100%.
- Below `MIN_PCT_BASE` prior sessions `changeBasis` is `small-base`, and surfaces state `changeSessions`, not the percent.

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

- Powered by the `site-audit` run kind and `@canonry/aeo-audit`'s `runSiteCrawl`. A run crawls the sitemap plus internal-link discoveries. Page budget: the request's `maxPages`, else the project's saved `siteAuditMaxPages`, else the full site (the 50,000-page hard limit), for manual and scheduled scans alike; edges derived by the engine from the page count (pages × 50, floor 100,000) unless `--max-edges` is set. Hard limits: 50,000 pages / 1,000,000 edges. Dead-link analysis is off unless requested.
- Progress reports the exact durable phase and raw pages found / checked / failed counters — never a synthesized percentage.
- Dead-link reports are disabled unless the run used `--check-dead-links`. A listed dead link ALWAYS has a real 4xx/5xx status: an internal target the crawler could not fetch at all (timeout, reset connection, throttling under crawl concurrency) is counted separately as `unverified` and is never listed, because a failed fetch is a fact about the crawl and not about the link. `found` and `checked` both exclude unverified targets, so "0 found, 6 unverified" reads as "nothing broken, six we could not check" rather than as a clean bill of health.

#### Routes (`src/technical-aeo.ts`)

- `POST /technical-aeo/runs` persists normalized request identity, with the saved page budget already resolved, before queueing: only identical effective options reuse an active run; a sitemap, budget, depth, or dead-link difference returns `409`.
- `GET /technical-aeo/runs` is the Site Health scan history: every non-probe site-audit run newest-first, each with `hasCrawlData`. Its `preferredRunId` identifies the default persisted scan independently of the history page limit; the dashboard uses that choice unless a run was explicitly selected or onboarding is following active work.
- A `runId` naming a real surfaceable run that published no crawl (a legacy score-only scan) gets that route's own no-crawl shape, NOT a 404; only an unknown or foreign `runId` still 404s.
- Crawl-scoped reads without a `runId` (`resolveCrawl`) select from the latest UTC scan date: prefer a complete non-probe crawl, then the most fetched pages, then the newest scan. Scorecard/page reads (`resolveAudit`) pin that same crawl and reuse its selection metadata. When that crawl audited no page (a partial crawl stores no `site_audit_snapshots` row), a default read takes the preferred scored crawl by the same ranking (`resolveCrawl` with `scoredOnly`); an explicit `runId` stays pinned with `hasData: false`. The scorecard delta baseline is the scan a default read returned just before the selected scan was recorded. Only when no crawl exists do score reads fall back to legacy score-only snapshots using date, completeness, audited-page count and recency. `runSelection` exposes the reason, same-date total and up to ten candidates; explicit `runId` always pins the scan. A newer-day partial scan stays current: a `partial` crawl stopped at an operator-chosen budget, and a site larger than the page budget never produces anything else. Every crawl read carries `complete` / `termination` (`completenessOf`; `false` / null with no crawl), so an absent page or link from a capped scan is never read as site-wide, and the CLI prints the caveat. A scan with no crawl (scorecard-only, failed, cancelled, running) is never the default crawl. Only `changes` requires complete crawls; with only partial ones it answers `partial-not-comparable`.
- The scorecard's optional `affectedPageRanking` ranks recorded `pagesFailing + pagesPartial` by breadth over the audited-page population, then factor ID for ties; zero rows stay visible. `unavailableFactorIds` identifies missing counts, never estimated from averages. It leaves `factors` presentation order and worst-band severity unchanged. Factor populations overlap, so never sum the rows into a site total or infer visibility impact. No scored snapshot means no ranking.
- Crawl summary and page reads accept a UTC calendar `date` instead of `runId` (selection identity, mutually exclusive). A missing date echoes `requestedDate` with no crawl; it never falls back to latest. Dated no-data reads add `availableScanDates`: up to ten recent dates and ten matching month/day dates across years, each with its full distinct-date total. These are candidates for explicit selection, never automatic substitutions. Their `inventorySummary` counts the whole selected snapshot regardless of page filters/cursor. Page `healthReasonCounts` count the filtered set before paging. Both use bounded SQL state groups classified by `deriveSiteHealthReason`; unknown indexability never proves a canonical exclusion. New page cursors bind the selected run, attempt, date and effective filters; legacy offset cursors remain readable.
- The graph read carries `rootNodeKey` so the home page is identified by the server rather than guessed from a path or a depth.
- The dashboard graph reads only the persisted 20k-node / 50k-edge projection; agent reads traverse canonical page/edge rows without layout coordinates and return bounded/truncated states.
- Every link-bearing read tags each edge `isTemplate` (nav, header, or footer chrome) plus `templateSource` and `placementOccurrences` (which rule decided it and the DOM evidence behind it), accepts a `linkKind` filter (`all` by default, so an existing caller's counts do not move), and reports `templateDetection`, so an empty content-only list can never be mistaken for a real zero and no count silently mixes the placement and ubiquity rules.
- `templateSource` is derived at read time from the row plus ITS OWN scan's detection state, which is why `mapCrawlEdge` takes the detection: a scan that never recorded placement cannot report `placement`. It also reads the stored `templateRatio`, so an edge the fallback could not measure (a redirect, a canonical, an unresolved target) reports `unmeasured` instead of being credited to a rule that produced no number.
- Every audit factor on the score, pages, and page-audit reads carries `sharePct` (its share of the score, 0..100) beside its relative `weight`. Factor JSON stored before the field existed reads `sharePct: null` (`withRecordedShare`, and the schema default on the page-audit parse), never 0 and never the weight, and a complete evidence row without it stays `complete`.
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

### Sentiment (experimental, off by default)

`sentiment.ts` exposes stored settings, summary/evidence/comparison, explicit backfill preview/admission, and job receipts. `SentimentService` never calls TypeSafe. Install-administrator writes require an unscoped wildcard credential or administrator identity, including delegated role checks. `sentiment-source.ts` reconstructs Simple identity and query classes from the frozen sidecar and Advanced identity/classes/market edges from the frozen revision. A Simple subject's `qualifiedAliases` come only from the sidecar's `identity.qualifiedAliases` (absent is `[]`, so pre-feature subject hashes hold); the project setting is written through project PUT/POST and apply (explicit lists validated by `resolveProjectQualifiedAliases`, omitted keeps the stored list minus names that no longer qualify against the written aliases, display name and competitors) and never triggers the alias mention backfill. Competitor writes outside those paths (the competitors routes, discovery promote) drop a claimed name with `pruneQualifiedAliasesForCompetitors` and record it as `droppedQualifiedAliases` on their audit row, and export filters by the same rules, so an export always re-applies. It is sentiment identity (it reaches `subjectHash`) but not capture-replay identity. Deliberate parity exclusion: Advanced has no own-brand sentiment subject, and Properties keep their qualified-phrase `identityAliases`; the dashboard editor is deferred (the settings save omits the field, so the server keeps it). Both require complete provider slots and exclude probes. Model selection matches the served source model. Branded and non-brand summaries, queryId selections, and query/location breakdowns use only matching frozen usage edges and never share denominators. Read runIds groups must be explicit and mutually exclusive with runId; incompatible evaluators or subject/query identities return unavailable scores. Existing project overview aggregates its exact latest location-run group and exposes runIds provenance. Its explicit `overall` headline unions branded and non-brand answer-subject assessments and provider-slot identities without duplication, preserves incomplete/identity safeguards, and leaves class-specific scores unchanged; it stays for compatibility, and the dashboard and human CLI overview show `branded` instead; a project whose sentiment is off answers from settings alone, and a configured overview selects each run once per class (one `selectSentimentSources` result serves resolution, stored items and every aggregate). Summary query rows are per Advanced execution node (`executionNodeKey`, also an identity selector), sorted by query text and paged (`queryLimit`, signed `queryCursor` bound to the resolved selection). `include` (tuning) opts into per-engine `assessments` and per-location scores; a named `queryId` includes both. Breakdowns never repeat query rows. Branded summaries on an enabled project and install carry `criticizedProperties` (comparison periods omit it: they score matched units only, so their ranking would differ from the run's own summary) from `rankCriticizedProperties` over the property breakdowns: ranked by counts, never shares (mixed plus unfavorable, then unfavorable, then fewest favorable, then label and key), `keys` the first `SENTIMENT_CRITICIZED_PROPERTY_LIMIT` (5), `total` every Property with a mixed or unfavorable rating, and always empty with fewer than two property rows; non-brand reads omit it and unavailable reads drop it. Unadmitted outcomes are null and read paths never enqueue work. The jobs list returns job summaries with SQL-counted outcomes and `attemptCount`; the job read pages attempts newest first with a signed `nextAttemptCursor`. Disabled reads withhold outcomes, quotes, judged and completed-outcome counts, and compare refuses with `sentiment-disabled`. Compare treats a null returned model (a local abstention) as model-free and refuses `classifier-model-changed` only when two provider models appear. Settings report `invalid-config`, the install-wide `provider-authorization` pause (not ready) or `provider-rate-limit` pause, and `unsupported-evaluator-definition` for a definition frozen under an earlier template (`hasCurrentSentimentTemplate`). Advanced visibility engine rows expose exact `sourceSnapshotIds`, including an empty array for missing answers. Evidence-only `assessmentId` narrows already-authorized source/evaluator items; evidence-only `outcome` (page-selection identity, never scoring identity; repeated or comma-separated outcome codes, form/explode in OpenAPI) narrows the page to stored assessments with those outcomes and never changes how they were scored, and the page echoes it sorted as `selection.outcome`; evidence cursors bind both selectors, the resolved run group, every filter, and per-run evaluator fingerprint. Preview tokens bind frozen source hashes; idempotent receipt lookup precedes expiry and disablement checks. An Advanced run without language provenance is skipped as `legacy-missing-language`; answers left out only by query class are counted as `excluded-branded` / `excluded-non-brand`. A preview signs no token when nothing is eligible, and a date range with no runs freezes no runIds. Runtime I/O belongs to `SentimentWorker` in the host package.

`previous-rated` narrows history to runs with stored rated outcomes in the selected class and scope before loading
answers, checks at most 50 candidates, and returns separate reasons for changed
populations, incomplete/empty targets, and bounded searches. Select an older run
explicitly after a bounded-search refusal. Partial rated predecessors remain
eligible; evaluator and model changes remain comparison refusals.
