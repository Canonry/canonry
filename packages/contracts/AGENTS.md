# contracts

## Purpose

Shared DTOs, enums, Zod schemas, error codes, and config validation — the type backbone of the monorepo. Every package imports from here. Never define shared types in consuming packages.

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
| `src/analytics.ts` | Analytics response DTOs |
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

### Error factory functions

Always use factory functions — never hand-construct error JSON:

```typescript
// ✅ Correct
throw validationError('"keywords" must be non-empty')
throw notFound(`Project "${name}" not found`)

// ❌ Wrong
return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: '...' } })
```

Available factories: `validationError()`, `notFound()`, `alreadyExists()`, `authRequired()`, `forbidden()`, `providerError()`, `quotaExceeded()`, `configError()`, `internalError()`.

## Common Mistakes

- **Hand-constructing error JSON** — always use factory functions from `errors.ts`.
- **Defining shared types in consuming packages** — types used across packages belong here.
- **Forgetting to re-export from `index.ts`** — consumers import from `@ainyc/canonry-contracts`.
- **Creating Zod schema without corresponding TypeScript type** — keep them paired.

## See Also

- `packages/api-routes/` — consumes DTOs for request/response validation
- `packages/canonry/src/client.ts` — uses DTOs for typed API client methods
