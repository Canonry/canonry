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
3. **Web UI** — important but lower priority. Never block a release on it.

### When adding a new feature
1. **Required:** Add the API endpoint in `packages/api-routes/`.
2. **Required:** Add the CLI command in `packages/canonry/src/commands/`.
3. **Ideal:** Add the UI interaction in `apps/web/`.

### Agent & automation design principles
- Every operation must be scriptable via CLI or API without human interaction.
- CLI output must be machine-parseable (support `--format json` on all commands that produce output).
- API responses must be self-describing and stable — external agents and scripts depend on them.
- Prefer config-as-code (`canonry apply`) over interactive wizards.
- Error messages must be actionable from a terminal — include the failed command, the reason, and a suggested fix.

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

1. **Throw `AppError` — never catch and manually reply.** Call `resolveProject(app.db, name)` directly. If the project doesn't exist it throws `notFound()`, which the global handler catches.
2. **Always use factory functions from `@ainyc/canonry-contracts`.** Never hand-construct `{ error: { code: '...', message: '...' } }`. Use `validationError()`, `notFound()`, `authRequired()`, `providerError()`, etc.
3. **New error codes** must be added to the `ErrorCode` union in `packages/contracts/src/errors.ts` with a corresponding factory function.

```typescript
// ✅ Correct — let the global handler serialize
const project = resolveProject(app.db, request.params.name) // throws notFound on miss
if (!body.keywords?.length) throw validationError('"keywords" must be non-empty')

// ❌ Wrong — never catch and manually reply, never hand-construct error JSON
```

## JSON Column Parsing (Critical)

Many SQLite text columns store JSON. Always use the typed helper from `@ainyc/canonry-db` — never call `JSON.parse` directly on DB column values.

```typescript
import { parseJsonColumn } from '@ainyc/canonry-db'

// ✅ Correct
const locations = parseJsonColumn<LocationContext[]>(project.locations, [])

// ❌ Wrong — fragile, missing fallback = crash
const locations = JSON.parse(project.locations || '[]') as LocationContext[]
```

`JSON.parse` is fine for HTTP request bodies, config files, and other non-DB sources.

## ApiClient Type Safety

All `ApiClient` methods in `packages/canonry/src/client.ts` must return typed DTOs from `@ainyc/canonry-contracts`. CLI commands must not cast API responses with `as Record<string, unknown>` or `as { ... }`.

## Transaction Boundaries

Multi-table writes must be wrapped in a single `db.transaction()` call to ensure atomicity.

1. **Do all async I/O before entering the transaction.** SQLite transactions must be synchronous (better-sqlite3 requirement).
2. **Include audit log writes inside the transaction** — `writeAuditLog()` accepts transaction context.
3. **Fire callbacks after the transaction commits**, not inside it.

## Atomic Counters

Use `INSERT ... ON CONFLICT DO UPDATE` for counter increments. Never use read-then-write patterns, which lose counts under concurrent requests.

## Database Schema Changes (Critical)

**Every new `sqliteTable(...)` in `packages/db/src/schema.ts` MUST have a corresponding migration in `packages/db/src/migrate.ts`.**

1. **New table** → add `CREATE TABLE IF NOT EXISTS ...` to the `MIGRATIONS` array in `migrate.ts`. Include all indexes.
2. **New column** → add `ALTER TABLE ... ADD COLUMN ...` to `MIGRATIONS`.
3. **Never edit MIGRATION_SQL** (the initial block). All incremental changes go in the `MIGRATIONS` array only.

## Authentication Storage

- `~/.canonry/config.yaml` is the source of truth for authentication credentials.
- Store provider API keys, OAuth credentials, and tokens in the local config file.
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

Multiple projects can be defined in one file using `---` document separators. Apply with `canonry apply <file...>` or `POST /api/v1/apply`.

## API Surface

All endpoints under `/api/v1/`. Auth via `Authorization: Bearer cnry_...`. Key endpoints:

- `PUT /api/v1/projects/{name}` — create/update project
- `POST /api/v1/projects/{name}/runs` — trigger visibility sweep
- `GET /api/v1/projects/{name}/timeline` — per-keyword citation history
- `GET /api/v1/projects/{name}/snapshots/diff` — compare two runs
- `POST /api/v1/apply` — config-as-code apply
- `GET /api/v1/openapi.json` — OpenAPI spec (no auth)

## Base Path Awareness (Critical)

Canonry supports running behind a reverse proxy with a sub-path prefix (e.g. `/canonry/`). All code that constructs URLs or registers routes **must** respect `basePath`. Failing to do so causes silent 404s in production.

- **CLI commands**: Always use `createApiClient()` — never instantiate `ApiClient` directly.
- **Server routes**: Use `routePrefix` from plugin registration — never hardcode `/api/v1`.
- **Web UI**: Use `window.__CANONRY_CONFIG__.basePath` — never hardcode `/api/v1`.

## API Stability

**Never change existing API endpoint paths or HTTP methods.** The CLI, UI, and external integrations depend on the published routes. Additive changes (new endpoints, new optional fields) are fine. Changing a path or method is a breaking change.

## Versioning

**Every non-documentation change must include a version bump.** Root `package.json` and `packages/canonry/package.json` versions must always be in sync. Use semver: patch for fixes, minor for features, major for breaking changes.

## Testing

**Every non-trivial change must include tests.**

- Use **Vitest** as the test runner. Configured via `vitest.workspace.ts` at the root.
- Tests live in `test/` directories colocated with the package.
- Test the public API of each module, not internal implementation details.
- Cover both the happy path and meaningful edge cases.
- Run `pnpm run test` to verify before committing.

## CI Guidance

- Validation CI: `typecheck`, `test`, `lint` across the full workspace on PRs.
- Keep explicit job permissions.

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
