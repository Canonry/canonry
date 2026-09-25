# contracts

## Purpose

Shared DTOs, enums, Zod schemas, error codes, config validation, and **generic utilities** — the type and helper backbone of the monorepo. Every package imports from here. Never define shared types or generic helpers in consuming packages — see the "Shared Utilities" section in the root `AGENTS.md`.

## Key Files

| File | Role |
|------|------|
| `src/errors.ts` | `AppError` class, `ErrorCode` union (27 codes), factory functions, and `describeError` — the shared way to render a caught `unknown` as text. Prefer it over `err instanceof Error ? err.message : String(err)` everywhere: that `String()` branch renders a thrown plain object as `[object Object]`, and `@typescript-eslint/no-base-to-string` only catches it where the value is typed `unknown`. `describeError` keeps the Error and string paths identical, reports null/undefined as `'unknown error'`, JSON-serializes anything else, and never throws. Note the one place it must NOT be used: `integration-cloudflare-worker`'s generated Worker source is a template literal, so a call there would compile to a reference the edge bundle cannot resolve. |
| `src/log-redaction.ts` | Pure bounded redaction for structured runtime values and diagnostic strings. Shared by console/Fastify logging and durable storage; masks full cookie headers, URL keys and spaced secret labels, drops opaque escaped secret assignments, and avoids unsafe object getters and request/body graphs. A `provider` field keeps its name string (which engine failed) but an object under it is dropped like `providerBody` / `providerResponse`. |
| `src/operational-logs.ts` | Strict runtime-event, query, and page DTOs. Identity and time filters, sanitized messages, retention policy, and loss counters are the same across REST, CLI, and MCP. Runtime logs are not business audit history. The strict DTOs are the server's redaction boundary (only known context keys are saved or returned). Clients read pages with `operationalLogListReadSchema`, which drops unknown keys instead of rejecting the page. A context field added after a strict reader shipped (today `provider`) goes in `OPERATIONAL_LOG_OPT_IN_CONTEXT_FIELDS` and is returned only when named in the `x-canonry-log-fields` request header, so older adapters never see it. Use a header, not a query parameter: `logQuerySchema` is strict, so older servers would 400 a new parameter. Older readers are just as strict about every other level of the page, and only context fields have an opt-in path. So a new entry, page or `retentionPolicy` key, a new `level` or `retention` value, or a looser bound needs its own opt-in path (or a coordinated adapter upgrade) first. `test/operational-logs.test.ts` fails on any such change by comparing the strict page with the shipped contract in `test/fixtures/operational-logs-v1.ts`. Never edit that fixture to make the test pass. |
| `src/telemetry.ts` | Telemetry DTOs and `normalizeTelemetryStatus`: shared legacy-response normalization and anonymous-ID masking for API hosts, ApiClient/MCP, and CLI output. |
| `src/provider.ts` | `ProviderName`, `ProviderConfig`, `ProviderAdapter` interface |
| `src/project.ts` | Project DTOs and Zod schemas |
| `src/run.ts` | Run and grounding source types |
| `src/simple-measurement-definition.ts` | Frozen inputs for simple runs: identity, exact queries, query classes, location, and requested models. The builder uses the shared classifier. Unknown classification stays null. Canonical serialization preserves exact values and sorts set-like collections. |
| `src/snapshot.ts` | Snapshot DTOs and diff types |
| `src/research.ts` | Research DTOs and shared helpers for exact-text deduplication and declared template bindings/expansion. |
| `src/scopes.ts` | Shared read-only classification (`read` or named `*.read`, unless explicitly write-granted), restricted write grants (`research.run` and Ads), and delegated-consent intersection. Adding an action grant must keep API gates and MCP catalogs aligned. |
| `src/query-tracking.ts` | Shared workspace, assignment preview, and commit DTOs. Tokens bind the exact mutation and workspace. Workload counts belong to the API. |
| `src/visibility-report.ts` | Frozen result selection, independent query-class populations, rates, trends, paginated answers, and competitor provenance. Plain request schema supports MCP JSON Schema. `populations[].comparison`: change since the previous eligible whole-project sweep, with the delta invariant enforced in the response refine. `visibilityReportScopeErrorDetailsSchema` / `parseVisibilityReportScopeErrorDetails`: typed retired-scope details; `retired-market` always pairs with kind `market`. |
| `src/config-schema.ts` | Config file Zod validation |
| `src/models.ts` | Shared model types |
| `src/model-pointers.ts` | Hand-maintained record of dates on which a provider changed the model behind a moving id (`chat-latest` and friends), plus `evaluateModelPointerExposure` (did a change land while the project was running that id?) and `buildModelChangeNotice` (the plain-language caveat both the dashboard and the CLI render — the ONLY wording of it; the DTO carries facts, never prose). Add a new dated entry to `MODEL_POINTER_EVENTS` whenever the provider's changelog announces one, AND move `MODEL_POINTER_REGISTRY_CHECKED_THROUGH` to the day you re-read the sources — every disclosure states that date, so a stale one reads as knowledge we do not have. |
| `src/analytics.ts` | Analytics response DTOs, plus the shared query-window resolvers. `parseWindow` REJECTS an unrecognised window (it used to fall back to `all`, so `--window 60d` returned every row ever stored under the label the caller asked for, a wrong number with no signal attached). `resolveDateRange({ startDate, endDate, window })` folds explicit inclusive `YYYY-MM-DD` bounds and the rolling window into one range: explicit dates win, the window only supplies a cutoff when no `startDate` was given, both boundaries are validated as real calendar dates (a TEXT `date` column would compare `2026-02-30` without complaint), and `explicitDates` tells a caller whether a precomputed per-window rollup can answer the request. |
| `src/formatting.ts` | Generic formatters: `formatRatio`, `formatNumber`, `formatDate`, `formatIsoDate`, `formatIsoDateInTimeZone` (`YYYY-MM-DD` as observed in a named zone, for dates that must line up with a third party that buckets by ITS local day; degrades to the UTC date on a bad zone), `startOfDayHourInTimeZone` (`YYYY-MM-DDTHH` for where a calendar day STARTS on a named zone's wall clock: hour 00 except on the one day a year a zone that springs forward at midnight skips it, so a range boundary never names a wall-clock hour the zone never had; degrades to hour 00), `startOfNextDayHourInTimeZone` (`YYYY-MM-DDTHH` for where the NEXT calendar day starts, i.e. the EXCLUSIVE upper edge that contains the whole of a given day: use it to say where a local day ENDS, such as whether a bucket falls wholly inside a window; NOT as the upper edge of a live request over the day in progress, which is by definition in the future and which a third party may refuse outright rather than clamp, as the OpenAI Ads insights API does with `400: time_ranges.end cannot be in the future`; a calendar step, not +24h, so the 23-hour and 25-hour local days land right), `isoDateDaysBeforeInTimeZone` (the calendar date N CALENDAR days before the date an instant falls on in a named zone — use it for EVERY "N days back" boundary that is a calendar date, because subtracting N × 24h from the instant is not calendar arithmetic: a spring-forward local day is 23 hours and a fall-back one is 25, so the fixed step lands a day off around a transition and the window gains or loses a date), `inclusiveDayCount` (calendar days a `YYYY-MM-DD` range covers counting BOTH ends, on UTC midnights so no daylight-saving transition can move it — the unit a window is LABELLED in, so an off-by-one turns a "30 days" label into a claim the numbers do not support; `null` for a malformed or inverted range, since a `0` would read as a real, empty window), `formatDateRange` |
| `src/index-coverage.ts` | `deriveIndexCoverage` — per-page index state from search-analytics impressions, falling back to URL Inspection. Impressions prove indexing for free at any site size; their absence proves nothing, so an unmeasured page is `unknown` rather than `not-indexed`. |
| `src/url-normalize.ts` | Canonical host extraction, Public Suffix List-aware domain identity, exact-or-subdomain matching, and prose-domain extraction |
| `src/brand-matching.ts` | Unicode-aware exact matching for approved brand aliases across case, spacing, and punctuation presentation variants; never fuzzy metric attribution |
| `src/report-dedup.ts` | Report action / opportunity dedup utilities |
| `src/retry.ts` | Generic retry helpers: `backoffDelayMs`, `withRetry`, `isRetryableHttpError`, `isRateLimitError`, `retryAfterDelayMs`. Used by every API provider, GA4, GBP, and Bing — domain-specific code only supplies the `isRetryable` predicate; the math (jittered exponential backoff per Google's documented formula) lives here. **Rate limiting is detected semantically, not by status code**: a service may report a throttle on a 4xx (Bing answers `400` with `ErrorCode 5 ThrottleHost`), so `isRateLimitError` checks `Retry-After`, then 429, then documented throttle markers in the message. A new integration whose throttle signal is a private numeric code must surface that code's meaning in the error message or set `retryAfter`, or the shared predicate cannot see it. |
| `src/concurrency.ts` | `mapWithConcurrency` — generic order-preserving bounded worker pool (fail-fast on the first rejection, in-flight tasks settle cleanly). Used by the discovery probe phase. |
| `src/http-status.ts` | `LOCATION_REDIRECT_STATUSES` / `isLocationRedirectStatus` — the five statuses that mean "fetch a different URL" (301/302/303/307/308). Deliberately NOT all of 3xx: a 304 is a served page view from cache, so classing it as a redirect drops real visits. Shared by the AI-referral landed/hop split and the sitemap fetcher. |
| `src/index.ts` | Barrel re-export of all modules |

## Patterns

### Adding a new error code

1. Add the code to the `ErrorCode` union in `src/errors.ts`.
2. Create a factory function that returns a new `AppError` with the correct status code:
   ```typescript
   export function myNewError(message: string) {
     return new AppError('MY_NEW_ERROR', message, 422)
   }
   ```
3. The global error handler in `packages/api-routes` will serialize it automatically.

### Adding a new DTO

1. Define the TypeScript interface and optional Zod schema in the appropriate domain file.
2. Re-export from `src/index.ts` (barrel export).
3. Use the DTO in both API routes (request/response validation) and the ApiClient (typed returns).

### Adding a generic utility

1. Pick the right home: `formatting.ts` for formatters, `url-normalize.ts` for URL helpers, `report-dedup.ts` for dedup logic. Create a new topic file (e.g. `parsing.ts`, `time.ts`) when no existing file fits.
2. Keep it pure — no side effects, no I/O, no logging, no DB. Take values, return values.
3. Re-export from `src/index.ts`.
4. Add a test file in `test/<topic>.test.ts` with happy path + edge cases (empty input, invalid input, boundary values).
5. Migrate any inline duplicates you discover in the same change — don't leave duplication for "later."

#### Where utilities live

| Concern | File |
|---------|------|
| Date / number / ratio formatting | `packages/contracts/src/formatting.ts` |
| URL / domain identity | `packages/contracts/src/url-normalize.ts` (`hostOf`, PSL-aware `registrableDomain` / `brandLabelFromDomain`, exact-or-subdomain matching, prose domain extraction) |
| Brand identity matching | `packages/contracts/src/brand-matching.ts` (exact approved aliases across case/spacing/punctuation variants; never fuzzy/edit-distance matching for metrics) |
| Tracked-query text normalization | `packages/contracts/src/query-normalize.ts` (`normalizeQueryText` — trim + lowercase for dedup / FK-null text matching) |
| Report action / opportunity dedup | `packages/contracts/src/report-dedup.ts` |
| Error factories, and rendering a caught `unknown` | `packages/contracts/src/errors.ts` (`describeError` — the one way to turn a `catch` binding into text; never hand-write `err instanceof Error ? err.message : String(err)`, whose `String()` branch prints `[object Object]` for a thrown object) |
| SQL `LIKE` wildcard escaping | `packages/contracts/src/sql-like.ts` (`escapeLikePattern` — caller adds `ESCAPE '\\'`) |
| Retry / exponential backoff | `packages/contracts/src/retry.ts` (`withRetry`, `backoffDelayMs`, `isRetryableHttpError`) |
| Statistics over a series | `packages/contracts/src/statistics.ts` (`wilsonInterval` for a proportion; `linearTrend` for the least-squares fit of any evenly-spaced series, returning slope-per-step plus the two endpoints a chart draws between). Fit trends server-side and put them in the DTO — a regression computed in a chart component is invisible to the CLI and breaks UI/CLI parity. |
| Bounded async concurrency | `packages/contracts/src/concurrency.ts` (`mapWithConcurrency` — order-preserving worker pool, fail-fast with clean settle) |
| Telemetry funnel classification | `packages/contracts/src/telemetry.ts` (`isGhostTelemetryEvent` — shared by the CLI client drop + the cloud collector backstop) |
| JSON column parsing (DB-only) | `packages/db` (`parseJsonColumn`) |

Add new utility files to `packages/contracts/src/` and re-export them from `index.ts`. Keep modules small and focused — a `formatting.ts` for formatters, a separate file for the next category. One file per concern.

#### Anti-patterns

```typescript
// ❌ Wrong — defining a generic helper inline in a domain file
// packages/api-routes/src/report-renderer.ts
function formatNumber(value: number): string {
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('en-US')
}

// ✅ Correct — single source of truth, imported everywhere
// packages/contracts/src/formatting.ts
export function formatNumber(value: number): string { /* ... */ }

// packages/api-routes/src/report-renderer.ts
import { formatNumber } from '@ainyc/canonry-contracts'
```

```typescript
// ❌ Wrong — three packages each define their own formatDate
// packages/canonry/src/gsc-sync.ts: function formatDate(d: Date) { ... }
// packages/integration-google-analytics/src/ga4-client.ts: function formatDate(d: Date) { ... }
// packages/api-routes/src/report-renderer.ts: function formatDate(iso: string) { ... }

// ✅ Correct — one shared helper, imported by all three
// packages/contracts/src/formatting.ts: export function formatIsoDate(iso: string) { ... }
```

### Enum constants

| Constant | Type | Values |
|----------|------|--------|
| `RunKinds` | `RunKind` | `RunKinds['answer-visibility']`, `RunKinds['gsc-sync']`, etc. |
| `RunStatuses` | `RunStatus` | `RunStatuses.completed`, `RunStatuses.failed`, etc. |
| `RunTriggers` | `RunTrigger` | `RunTriggers.manual`, `RunTriggers.scheduled`, `RunTriggers.probe`, etc. |
| `CitationStates` | `CitationState` | `CitationStates.cited`, `CitationStates['not-cited']` |
| `VisibilityStates` | `VisibilityState` | `VisibilityStates.visible`, `VisibilityStates['not-visible']` |
| `ComputedTransitions` | `ComputedTransition` | `ComputedTransitions.lost`, `ComputedTransitions.emerging`, etc. |

```typescript
import type { RunKind } from '@ainyc/canonry-contracts'
import { RunKinds, RunStatuses } from '@ainyc/canonry-contracts'

// ✅ Correct — enum constant + typed parameter + exhaustive switch
function kindLabel(kind: RunKind): string {
  switch (kind) {
    case RunKinds['answer-visibility']: return 'Answer visibility sweep'
    case RunKinds['gsc-sync']: return 'GSC sync'
    case RunKinds['inspect-sitemap']: return 'Sitemap inspection'
    case RunKinds['site-audit']: return 'Site audit'
  }
}

// ❌ Wrong — raw string literals, untyped parameter
function kindLabel(kind: string): string {
  switch (kind) {
    case 'answer-visibility': return 'Answer visibility sweep'
    default: return kind
  }
}
```

### Third-party HTTP calls

**Every integration that talks to a third party over HTTP must back off when that service pushes back.** Wrap the package's HTTP layer in `withRetry` from `@ainyc/canonry-contracts` — one private `fetchOnce`, one exported wrapper — so retry is the default rather than something each call site remembers. `packages/integration-bing/src/bing-client.ts` is the reference shape.

#### Rules

1. **Retry is a property of the client, not the caller.** If a call site can forget it, it will.
2. **Do not write a status-code check by hand.** Use `isRetryableHttpError`, which retries rate limiting, 5xx, and network errors, and refuses auth/validation/not-found.
3. **Rate limiting is not always HTTP 429.** A service may report a throttle on a 4xx, or a 200, with the condition in the body — Bing answers `400` with `{"ErrorCode":5,"Message":"ERROR!!! ThrottleHost"}`. `isRateLimitError` therefore tests semantically: `Retry-After`, then 429, then documented throttle markers in the message. If a service signals throttling through a private numeric code, surface that code's meaning in the error message or set `retryAfter` on the error, or the shared predicate cannot see it (see `BingApiError`).
4. **Honour `Retry-After`.** Pass `computeDelayMs: (_a, err, defaultMs) => retryAfterDelayMs(err) ?? defaultMs`. Backing off 1s against a limiter asking for 60 just burns the remaining attempts.
5. **Tune the base delay to the service.** The 1s default is for one-off blips. A service that throttles a burst needs a base above the window it throttles over — Bing uses 2s doubling to a 30s ceiling.
6. **Test both directions.** A retry test that only proves "transient failure eventually succeeds" is half a test. Also assert that auth and validation failures are *not* retried — retrying a permanent failure multiplies load for nothing.

`packages/contracts/test/integration-retry-coverage.test.ts` enforces this: a new HTTP-calling integration without `withRetry` fails CI. Packages that predate the rule are listed there explicitly, and the list may only shrink.

### Market selection

`visibility-report` accepts `marketKey` as an exact refinement of project, group, or property scope. Market scope already selects a market and rejects an additional `marketKey`. Optional scope/query `marketKeys` and `selection.market` carry frozen memberships to consumers. A reporting market may declare `groupKey` only when that group contains every target in its usage edges.

### Competitor model comparisons

`competitorLandscapeQuerySchema` accepts optional `groupBy: model` and an exact
requested `model` filter. A model filter requires `provider`. The optional
`modelComparison` response groups stored evidence by provider and requested
model, with independent counts and denominators. Null model identity remains
unknown. `servedModels` carries separate upstream evidence. Never substitute
requested identity for missing served identity. Existing aggregate responses
remain valid without these optional fields. Pins remain project/market identities,
not model-specific records. The same contract covers Simple and Advanced scopes.

### Error factory functions

Always use factory functions — never hand-construct error JSON:

```typescript
// ✅ Correct
throw validationError('"queries" must be non-empty')
throw notFound(`Project "${name}" not found`)

// ❌ Wrong
return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: '...' } })
```

Available factories: `validationError()`, `notFound()`, `alreadyExists()`, `authRequired()`, `forbidden()`, `providerError()`, `quotaExceeded()`, `configError()`, `internalError()`.

## Common Mistakes

- **Hand-constructing error JSON** — always use factory functions from `errors.ts`.
- **Defining shared types in consuming packages** — types used across packages belong here.
- **Defining generic helpers (formatters, parsers, normalizers) inline in consumer files** — they belong in this package. See "Shared Utilities" in the root `AGENTS.md`.
- **Forgetting to re-export from `index.ts`** — consumers import from `@ainyc/canonry-contracts`.
- **Creating Zod schema without corresponding TypeScript type** — keep them paired.

## See Also

- `packages/api-routes/` — consumes DTOs for request/response validation
- `packages/canonry/src/client.ts` — uses DTOs for typed API client methods
