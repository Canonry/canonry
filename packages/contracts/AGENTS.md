# contracts

## Purpose

Shared DTOs, enums, Zod schemas, error codes, config validation, and **generic utilities** — the type and helper backbone of the monorepo. Every package imports from here. Never define shared types or generic helpers in consuming packages — see the "Shared Utilities" section in the root `AGENTS.md`.

## Key Files

| File | Role |
|------|------|
| `src/errors.ts` | `AppError` class, `ErrorCode` union (27 codes), factory functions, and `describeError` — the shared way to render a caught `unknown` as text. Prefer it over `err instanceof Error ? err.message : String(err)` everywhere: that `String()` branch renders a thrown plain object as `[object Object]`, and `@typescript-eslint/no-base-to-string` only catches it where the value is typed `unknown`. `describeError` keeps the Error and string paths identical, reports null/undefined as `'unknown error'`, JSON-serializes anything else, and never throws. Note the one place it must NOT be used: `integration-cloudflare-worker`'s generated Worker source is a template literal, so a call there would compile to a reference the edge bundle cannot resolve. |
| `src/provider.ts` | `ProviderName`, `ProviderConfig`, `ProviderAdapter` interface |
| `src/project.ts` | Project DTOs and Zod schemas |
| `src/run.ts` | Run and grounding source types |
| `src/simple-measurement-definition.ts` | Frozen inputs for simple runs: identity, exact queries, query classes, location, and requested models. The builder uses the shared classifier. Unknown classification stays null. Canonical serialization preserves exact values and sorts set-like collections. |
| `src/snapshot.ts` | Snapshot DTOs and diff types |
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
