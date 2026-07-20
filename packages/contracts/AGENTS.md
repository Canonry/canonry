# contracts

## Purpose

Shared DTOs, enums, Zod schemas, error codes, config validation, and **generic utilities** — the type and helper backbone of the monorepo. Every package imports from here. Never define shared types or generic helpers in consuming packages — see the "Shared Utilities" section in the root `AGENTS.md`.

## Key Files

| File | Role |
|------|------|
| `src/errors.ts` | `AppError` class, `ErrorCode` union (15 codes), factory functions |
| `src/provider.ts` | `ProviderName`, `ProviderConfig`, `ProviderAdapter` interface |
| `src/project.ts` | Project DTOs and Zod schemas |
| `src/run.ts` | Run and grounding source types |
| `src/snapshot.ts` | Snapshot DTOs and diff types |
| `src/config-schema.ts` | Config file Zod validation |
| `src/models.ts` | Shared model types |
| `src/model-pointers.ts` | Hand-maintained record of dates on which a provider changed the model behind a moving id (`chat-latest` and friends), plus `evaluateModelPointerExposure` (did a change land while the project was running that id?) and `buildModelChangeNotice` (the plain-language caveat both the dashboard and the CLI render — the ONLY wording of it; the DTO carries facts, never prose). Add a new dated entry to `MODEL_POINTER_EVENTS` whenever the provider's changelog announces one, AND move `MODEL_POINTER_REGISTRY_CHECKED_THROUGH` to the day you re-read the sources — every disclosure states that date, so a stale one reads as knowledge we do not have. |
| `src/analytics.ts` | Analytics response DTOs |
| `src/formatting.ts` | Generic formatters: `formatRatio`, `formatNumber`, `formatDate`, `formatIsoDate`, `formatDateRange` |
| `src/url-normalize.ts` | Domain / URL normalization helpers |
| `src/report-dedup.ts` | Report action / opportunity dedup utilities |
| `src/retry.ts` | Generic retry helpers: `backoffDelayMs`, `withRetry`, `isRetryableHttpError`. Used by every API provider, GA4, and GBP — domain-specific code only supplies the `isRetryable` predicate; the math (jittered exponential backoff per Google's documented formula) lives here. |
| `src/concurrency.ts` | `mapWithConcurrency` — generic order-preserving bounded worker pool (fail-fast on the first rejection, in-flight tasks settle cleanly). Used by the discovery probe phase. |
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
