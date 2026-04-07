# AGENTS.md

## Project Overview

`canonry` is an open-source **agent-first** AEO monitoring platform that tracks how AI answer engines cite a domain for tracked keywords. Published as `@ainyc/canonry` on npm. The CLI and API are the primary interfaces — the web dashboard is supplementary.

## Workspace Map

```text
apps/api/                        Cloud API entry point (imports packages/api-routes)
apps/worker/                     Cloud worker entry point
apps/web/                        Vite SPA source (bundled into packages/canonry/assets/)
packages/canonry/                Publishable npm package (CLI + server + bundled SPA)
packages/api-routes/             Shared Fastify route plugins
packages/contracts/              DTOs, enums, config-schema, error codes
packages/config/                 Typed environment parsing
packages/db/                     Drizzle ORM schema, migrations, client (SQLite/Postgres)
packages/provider-gemini/        Gemini adapter
packages/provider-openai/        OpenAI adapter
packages/provider-claude/        Claude/Anthropic adapter
packages/provider-local/         Local LLM adapter (OpenAI-compatible API)
packages/provider-perplexity/    Perplexity adapter
packages/provider-cdp/           Chrome DevTools Protocol adapter
packages/integration-google/     Google Search Console integration
packages/integration-google-analytics/  Google Analytics 4 integration
packages/integration-bing/       Bing Webmaster Tools integration
packages/integration-wordpress/  WordPress integration
docs/                            Architecture, roadmap, testing, ADRs
```

Start with `docs/README.md` when you need the current doc map, active plans, ADR index, or canonical roadmap.

## Commands

```bash
# One-command dev setup: install deps, build all packages, install canonry globally
./canonry-install.sh

pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run dev:web

# CLI
canonry init
canonry serve
canonry project create <name> --domain <domain> --country US --language en
canonry keyword add <project> <keyword>...
canonry run <project>
canonry run <project> --provider gemini          # single-provider run
canonry status <project>
canonry apply <file...>                          # multi-doc YAML + multiple files
canonry export <project>
```

## Dependency Boundary

- `packages/api-routes/` must not import from `apps/*`.
- `packages/canonry/` is the only publishable artifact. Internal packages are bundled via tsup.
- All internal packages use `@ainyc/canonry-*` naming convention.

## Surface Priority

THIS IS AN **AGENT-FIRST** PLATFORM. The CLI and API are the primary interfaces. The web UI is a nice-to-have — it must never block or delay CLI/API work.

### Priority order
1. **API** — the shared backbone. Every capability must be exposed here first.
2. **CLI** — the primary user-facing surface. Must feel complete and polished.
3. **Web UI** — important but lower priority. Ideally all features have a UI, but never block a release on it.

### When adding a new feature
1. **Required:** Add the API endpoint in `packages/api-routes/`.
2. **Required:** Add the CLI command in `packages/canonry/src/commands/`.
3. **Ideal:** Add the UI interaction in `apps/web/` — aim to include it, but never block a release waiting for UI work.

### Agent & automation design principles

The CLI and API **are** the agent interface. No MCP layer, no virtual filesystem, no special agent SDK. If an AI agent can't do something with `canonry <command> --format json` or an HTTP call, it's a bug.

#### Rules

1. **No interactive prompts.** Every CLI command must be fully operable via flags and environment variables. Never import `node:readline` in command files — ESLint enforces this. If a value is sensitive (API keys, passwords), accept it via `--flag`, env var, or `config.yaml`. Prompts are allowed only in `canonry init` as a convenience; all init values must also be passable via flags.
2. **JSON everywhere.** Every command that produces output must support `--format json`. JSON output goes to stdout. Errors go to stderr as `{ "error": { "code": "...", "message": "..." } }`. Human-readable text is the default; JSON is the machine contract.
3. **Idempotent writes.** `canonry apply` is the model — running it twice with the same input produces the same state. New write commands must follow this pattern. `POST` endpoints that create resources (like runs) are exempt, but must return a stable identifier and handle conflicts gracefully (e.g., `runInProgress` error with the existing run ID).
4. **Single-call reads.** If an agent needs two API calls to answer a common question, add a composite endpoint. Examples: `/projects/:name/runs/latest` (don't make agents list-then-filter), `/projects/:name/search?q=term` (don't make agents fetch all snapshots to grep). The test: can an agent get what it needs in one `curl` call?
5. **Meaningful exit codes.** `0` = success, `1` = user error (bad input, not found, validation), `2` = system error (network, provider failure, internal). Agents use exit codes to decide whether to retry.
6. **Stable output contracts.** JSON field names, endpoint paths, and error codes are public API. Renaming a JSON field is a breaking change. Add fields freely; never remove or rename without a version bump.

#### Checklist for any new command or endpoint

- [ ] Fully operable without interactive input (no readline, no prompts)
- [ ] `--format json` supported, outputs to stdout
- [ ] Errors output structured JSON to stderr with a code from `CliError`
- [ ] Write operations are idempotent (or return conflict details)
- [ ] Common read patterns achievable in a single API call
- [ ] Exit code follows 0/1/2 convention

## Maintenance Guidance

- Keep shared shapes in `packages/contracts`.
- Keep environment parsing in `packages/config`.
- Keep provider logic in `packages/provider-*/`.
- Keep API route plugins in `packages/api-routes` (no app-level concerns).
- Keep API handlers thin.
- Keep the monitoring app independent from the audit package repo except for the published npm dependency.
- Raw observation snapshots only (`cited`/`not-cited`); transitions computed at query time.

## Error Handling in API Routes (Critical)

The global error handler in `packages/api-routes/src/index.ts` catches `AppError` instances and serializes them with the correct status code and JSON envelope. Route handlers must leverage this — never duplicate the serialization logic.

### Rules

1. **Throw `AppError` — never catch and manually reply.** Call `resolveProject(app.db, name)` directly. If the project doesn't exist it throws `notFound()`, which the global handler catches. Do not wrap in try-catch or use a `resolveProjectSafe` helper.
2. **Always use factory functions from `@ainyc/canonry-contracts`.** Never hand-construct `{ error: { code: '...', message: '...' } }`. Use `validationError()`, `notFound()`, `authRequired()`, `providerError()`, etc. This guarantees typed error codes and a consistent envelope.
3. **New error codes** must be added to the `ErrorCode` union in `packages/contracts/src/errors.ts` with a corresponding factory function.

### Pattern

```typescript
// ✅ Correct — let the global handler serialize
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

const project = resolveProject(app.db, request.params.name) // throws notFound on miss
if (!body.keywords?.length) throw validationError('"keywords" must be non-empty')

// ❌ Wrong — duplicates global handler logic
try {
  const project = resolveProject(app.db, name)
} catch (e) {
  reply.status(e.statusCode).send(e.toJSON()) // never do this
}
return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: '...' } }) // never do this
```

## JSON Column Parsing (Critical)

Many SQLite text columns store JSON (`projects.locations`, `providers`, `tags`, `labels`, `citedDomains`, etc.). Always use the typed helper from `@ainyc/canonry-db` — never call `JSON.parse` directly on DB column values.

### Rules

1. **Use `parseJsonColumn(value, fallback)` from `@ainyc/canonry-db`.** It handles null, empty strings, and invalid JSON safely.
2. **Never write `JSON.parse(row.field || '[]') as SomeType[]`** — this pattern is fragile (missing fallback = crash, wrong cast = silent corruption).
3. `JSON.parse` is fine for HTTP request bodies, config files, and other non-DB sources.

### Pattern

```typescript
import { parseJsonColumn } from '@ainyc/canonry-db'

// ✅ Correct
const locations = parseJsonColumn<LocationContext[]>(project.locations, [])
const labels = parseJsonColumn<Record<string, string>>(project.labels, {})

// ❌ Wrong
const locations = JSON.parse(project.locations || '[]') as LocationContext[]
```

## ApiClient Type Safety

All `ApiClient` methods in `packages/canonry/src/client.ts` must return typed DTOs from `@ainyc/canonry-contracts`. CLI commands must not cast API responses with `as Record<string, unknown>` or `as { ... }`.

- Define response interfaces in `packages/contracts/` when they don't already exist.
- The `request<T>()` method is already generic — specify the correct type parameter.
- When adding a new API endpoint, add the corresponding client method with a typed return value.

## Transaction Boundaries

Multi-table writes must be wrapped in a single `db.transaction()` call to ensure atomicity.

### Rules

1. **Do all async I/O (HTTP calls, DNS lookups, validation) before entering the transaction.** SQLite transactions must be synchronous (better-sqlite3 requirement).
2. **Include audit log writes inside the transaction** — `writeAuditLog()` accepts transaction context via its `Pick<DatabaseClient, 'insert'>` parameter.
3. **Fire callbacks (e.g., `onScheduleUpdated`) after the transaction commits**, not inside it.

### Pattern

```typescript
// Validate async work first
const urlCheck = await resolveWebhookTarget(url)
if (!urlCheck.ok) throw validationError(urlCheck.message)

// Then do all writes atomically
app.db.transaction((tx) => {
  tx.update(projects).set({ ... }).where(...).run()
  tx.delete(keywords).where(...).run()
  for (const kw of newKeywords) {
    tx.insert(keywords).values({ ... }).run()
  }
  writeAuditLog(tx, { ... })
})

// Fire callbacks after commit
opts.onScheduleUpdated?.('upsert', projectId)
```

## Atomic Counters

Use `INSERT ... ON CONFLICT DO UPDATE` for counter increments. Never use read-then-write patterns, which lose counts under concurrent requests.

### Pattern

```typescript
import { sql } from 'drizzle-orm'

db.insert(usageCounters).values({
  id: crypto.randomUUID(), scope, period, metric, count: 1, updatedAt: now,
}).onConflictDoUpdate({
  target: [usageCounters.scope, usageCounters.period, usageCounters.metric],
  set: { count: sql`${usageCounters.count} + 1`, updatedAt: now },
}).run()
```

## Database Schema Changes (Critical)

**Every new `sqliteTable(...)` in `packages/db/src/schema.ts` MUST have a corresponding migration in `packages/db/src/migrate.ts`.**

This is not optional. If you add a table to the schema but omit the migration, the table will never be created in any existing or new database, and every query against it will throw `no such table` at runtime.

### Rules

1. **New table** → add `CREATE TABLE IF NOT EXISTS ...` to the `MIGRATIONS` array in `migrate.ts`. Include all indexes from the schema definition.
2. **New column** → add `ALTER TABLE ... ADD COLUMN ...` to `MIGRATIONS`. SQLite ignores duplicate `ADD COLUMN` attempts, so these are safe to re-run.
3. **Removed column or table** → SQLite does not support DROP COLUMN on older versions; document the intent and leave the migration as a no-op comment if needed.
4. **Never edit MIGRATION_SQL** (the initial block at the top). That block bootstraps brand-new installs. All incremental changes go in the `MIGRATIONS` array only.
5. **Check the last version number** in the `MIGRATIONS` array before adding a new entry. Comments use `// vN:` prefixes — find the highest N and increment by 1. Duplicate or out-of-order version numbers cause confusion and have led to bugs.

### Pattern

```typescript
// In packages/db/src/migrate.ts — MIGRATIONS array:

// v12: My new feature — my_new_table
`CREATE TABLE IF NOT EXISTS my_new_table (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_my_new_table_project ON my_new_table(project_id)`,
```

### Checklist for any schema change

- [ ] Table/column added to `schema.ts`
- [ ] Matching migration added to `MIGRATIONS` in `migrate.ts`
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all pass before committing

## Authentication Storage

- The local config file at `~/.canonry/config.yaml` is the source of truth for authentication credentials.
- Store provider API keys, Google OAuth client credentials, and Google OAuth access/refresh tokens in the local config file.
- Do not treat the SQLite database as the authoritative store for authentication material.

## Config-as-Code

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
  keywords:
    - keyword one
  competitors:
    - competitor.com
  providers:
    - gemini
    - openai
```

Locations are project-scoped via `spec.locations` and `spec.defaultLocation`. Runs choose the default location, an explicit location, all configured locations, or no location. Do not model locations as keyword-owned state.

Multiple projects can be defined in one file using `---` document separators. Apply with `canonry apply <file...>` (accepts multiple files) or `POST /api/v1/apply`. Applied project YAML is declarative input; runtime project/run data lives in the DB, while local authentication credentials live in `~/.canonry/config.yaml`.

## API Surface

All endpoints under `/api/v1/`. Auth via `Authorization: Bearer cnry_...`. Key endpoints:

- `PUT /api/v1/projects/{name}` — create/update project
- `POST /api/v1/projects/{name}/runs` — trigger visibility sweep
- `GET /api/v1/projects/{name}/timeline` — per-keyword citation history
- `GET /api/v1/projects/{name}/snapshots/diff` — compare two runs
- `POST /api/v1/apply` — config-as-code apply
- `GET /api/v1/openapi.json` — OpenAPI spec (no auth)

See OpenAPI spec at `/api/v1/openapi.json` for the complete API surface.

## Base Path Awareness (Critical)

Canonry supports running behind a reverse proxy with a sub-path prefix (e.g. `/canonry/`). All code that constructs URLs or registers routes **must** respect `basePath`. Failing to do so causes silent 404s in production.

### CLI commands — always use `createApiClient()`

Never instantiate `ApiClient` directly with `loadConfig()` in command files. Use the centralized helper:

```typescript
import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}
```

`createApiClient()` (in `packages/canonry/src/client.ts`) calls `loadConfig()` which incorporates `basePath` from both `config.yaml` and the `CANONRY_BASE_PATH` env var into `apiUrl` before constructing the client.

### Server routes — use `apiPrefix`

All API routes in `packages/api-routes/` are registered via a Fastify plugin with a `routePrefix` that already includes `basePath`. Do not hardcode `/api/v1` in route handlers or redirects. Use the prefix passed to the plugin.

### Health endpoint

The `/health` endpoint exposes `basePath` in its response for auto-discovery:
```json
{ "status": "ok", "service": "canonry", "version": "1.26.1", "basePath": "/canonry" }
```
When `basePath` is not configured, the `basePath` field is omitted.

### Web UI — use `window.__CANONRY_CONFIG__.basePath`

The SPA receives `basePath` via an injected config object. Use it for all API fetch calls and router base paths. Do not hardcode `/api/v1`.

### Checklist for any new route or CLI command

- [ ] Server route registered via the plugin's `routePrefix` (not hardcoded `/api/v1`)
- [ ] CLI command uses `createApiClient()` (not `new ApiClient(loadConfig().apiUrl, ...)`)
- [ ] Any redirect URLs or OAuth callback URLs use `publicUrl` or `apiUrl` (which already include basePath)
- [ ] Frontend fetch calls prepend `window.__CANONRY_CONFIG__.basePath`

## API Stability

**Never change existing API endpoint paths or HTTP methods during revisions.** The CLI, UI, and any external integrations are hard-coded to the published routes. Changing a path or method is a breaking change regardless of the reason.

- Additive changes (new endpoints, new optional fields) are fine.
- Renaming or restructuring existing routes requires a versioned migration plan and explicit user approval.
- If a route is wrong, fix the underlying logic — not the URL.

## Versioning

**Every non-documentation change must include a version bump.** The root `package.json` and `packages/canonry/package.json` versions must always be kept in sync with each other and with the latest published version on npm (`@ainyc/canonry`).

- Documentation-only changes (README, docs/, CLAUDE.md) do not require a bump.
- All other changes — features, bug fixes, refactors, dependency updates, test additions that accompany code changes — require a semver bump in both `package.json` files.
- Use semver: patch for fixes, minor for features, major for breaking changes.

## Testing

**Every non-trivial change must include tests.** If you are adding a feature, fixing a bug, or refactoring logic, ship tests alongside the code. Trivial changes (typo fixes, comment updates, config-only changes) are exempt.

- Use **Vitest** as the test runner. Configured via `vitest.workspace.ts` at the root with per-package `vitest.config.ts` files.
- Import test utilities from `vitest`: `import { test, expect, describe, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'`.
- Use `expect()` for assertions (e.g. `expect(value).toBe(expected)`, `expect(obj).toEqual(expected)`, `expect(fn).toThrow()`).
- Tests live in `test/` directories colocated with the package (e.g. `packages/canonry/test/`).
- Test the public API of each module, not internal implementation details.
- Cover both the happy path and meaningful edge cases (invalid input, env var overrides, error handling).
- When testing CLI commands, capture stdout/stderr and assert on output rather than only checking side effects.
- Use temp directories (`os.tmpdir()`) for file-system tests; clean up in `afterEach`.
- Run `pnpm run test` to verify before committing.
- **Test default-value propagation end-to-end.** When a feature stores a default (e.g., `defaultLocation` on a project) that another feature consumes (e.g., run creation), write a test that exercises the full path with no explicit override. Don't just test that the default is stored and that the consumer accepts a value — test that they connect.

## Code Comments

- **Never use comments as a substitute for code.** A comment like `// else use project default` is not implementation — it's a wish. If a branch is described in a comment, the code for that branch must exist. ESLint's `no-warning-comments` rule flags `TODO`/`FIXME`/`HACK` as warnings to prevent deferred work from rotting.
- **No placeholder branches.** If an `if/else if` chain has a case that should do something, write the code. If it intentionally does nothing, add an explicit empty block with a comment explaining why it's a no-op (e.g., `// allLocations handled in the block below`).

## CI Guidance

- Validation CI: `typecheck`, `test`, `lint` across the full workspace on PRs.
- Keep explicit job permissions.
- Publish workflow will be added when `packages/canonry/` is ready for npm.

## Keeping Documentation Current

This repo uses per-package `AGENTS.md` files for local context. **These must stay in sync with the code.** Update the relevant documentation when making structural changes:

| When you... | Update... |
|-------------|-----------|
| Add a new package under `packages/` or `apps/` | Create `AGENTS.md` + `CLAUDE.md` (`@AGENTS.md`) in the new package |
| Add a new table or column in `packages/db/src/schema.ts` | Update `docs/data-model.md` (ER diagram + table groups) |
| Add a new API route file in `packages/api-routes/src/` | Update `packages/api-routes/AGENTS.md` key files table |
| Add a new CLI command | Update `packages/canonry/AGENTS.md` |
| Add a new provider package | Update `docs/providers/README.md` and create `docs/providers/<name>.md` |
| Add a new integration package | Create `packages/integration-<name>/AGENTS.md` |
| Change a critical pattern (error handling, DB access, auth) | Update the relevant package's AGENTS.md patterns section |
| Add a new dependency between packages | Update `docs/architecture.md` module dependency graph |

**Documentation-only changes do not require a version bump.**

## Roadmap

See `docs/roadmap.md` for the full feature roadmap including competitive analysis, priority matrix, and phased implementation order.
