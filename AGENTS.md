# AGENTS.md

## Project Overview

`canonry` is an open-source AEO (Answer Engine Optimization) monitoring tool. It tracks how AI answer engines cite a domain for tracked keywords. Built on the published `@ainyc/aeo-audit` npm package.

## Current Phase

**Phase 2** — building the publishable `@ainyc/canonry` npm package. See `docs/phase-2-design.md` for the full plan.

**In scope:** Visibility runs, CLI, config-as-code, API, bundled SPA, SQLite, auth, audit log.
**Deferred:** Site audit (Phase 3), scheduling (Phase 3), cloud/Postgres (Phase 4).

## Workspace Map

```text
apps/api/                 Cloud API entry point (imports packages/api-routes)
apps/worker/              Cloud worker entry point
apps/web/                 Vite SPA source (bundled into packages/canonry/assets/)
packages/canonry/         Publishable npm package (CLI + server + bundled SPA)
packages/api-routes/      Shared Fastify route plugins
packages/contracts/       DTOs, enums, config-schema, error codes
packages/config/          Typed environment parsing
packages/db/              Drizzle ORM schema, migrations, client (SQLite/Postgres)
packages/provider-gemini/ Gemini adapter
docs/                     Architecture, product plan, testing, ADRs
```

## Commands

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run dev:web
```

## CLI Commands (Phase 2)

```bash
canonry init                                    # First-time setup (~/.canonry/)
canonry serve                                   # Start dashboard + API
canonry project create <name> --domain <d>      # Create project
canonry project list / show / delete
canonry keyword add <project> <keyword>...      # Add keywords
canonry keyword list / import
canonry competitor add <project> <domain>...    # Add competitors
canonry run <project>                           # Trigger visibility sweep
canonry status <project>                        # Summary
canonry evidence <project>                      # Keyword-level results
canonry history <project>                       # Audit trail
canonry export <project>                        # Export as canonry.yaml
canonry apply <canonry.yaml>                    # Declarative apply
```

## Config-as-Code (`canonry.yaml`)

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
```

Apply with `canonry apply <file>` or `POST /api/v1/apply`.

## API Endpoints (Phase 2)

All under `/api/v1/`. Auth: `Authorization: Bearer cnry_...`

| Method | Path | Purpose |
|--------|------|---------|
| `PUT` | `/projects/{name}` | Create/update project |
| `GET` | `/projects` | List projects |
| `GET` | `/projects/{name}` | Get project + visibility score |
| `PUT` | `/projects/{name}/keywords` | Replace keywords |
| `POST` | `/projects/{name}/keywords` | Append keywords |
| `PUT` | `/projects/{name}/competitors` | Replace competitors |
| `POST` | `/projects/{name}/runs` | Trigger visibility sweep |
| `GET` | `/projects/{name}/runs` | List runs |
| `GET` | `/projects/{name}/timeline` | Citation history |
| `GET` | `/projects/{name}/snapshots/diff` | Compare runs |
| `GET` | `/projects/{name}/history` | Audit log |
| `POST` | `/apply` | Config-as-code apply |
| `GET` | `/openapi.json` | OpenAPI spec (no auth) |
| `GET` | `/health` | Health (no auth, no prefix) |

## Dependency Boundary

- Use `@ainyc/aeo-audit` as an external dependency.
- Do not copy source files from the audit package repo.
- `packages/api-routes/` must not import from `apps/*`.
- `packages/canonry/` is the only publishable artifact.

## Key Architecture Decisions

- **Raw observation snapshots**: Store `cited`/`not-cited` only. Transitions (`lost`, `emerging`) computed at query time.
- **Same auth path**: Local `canonry init` auto-generates API key. Same code path as cloud.
- **Single process locally**: Fastify + job runner + static SPA. No Docker/Postgres/queue.
- **SQLite locally, Postgres for cloud**: Same Drizzle schema, different driver.

## Surface Parity

**Every feature must be equally accessible through CLI, API, and UI.** No surface is privileged. The API is the shared backbone; both CLI and UI are clients of it.

When adding a new feature:
1. Add the API endpoint in `packages/api-routes/`.
2. Add the CLI command in `packages/canonry/src/commands/`.
3. Add the UI interaction in `apps/web/`.
4. All three must ship together.

## Maintenance Guidance

- Keep shared shapes in `packages/contracts`.
- Keep environment parsing in `packages/config`.
- Keep provider logic in `packages/provider-gemini`.
- Keep API route plugins in `packages/api-routes`.
- Keep API handlers thin.

## Improvement Order (Phase 2)

1. Database schema and contracts foundation
2. API route plugins
3. Provider execution and job runner
4. Publishable package
5. Wire web dashboard to real API

## CI Guidance

- Validation CI: `typecheck`, `test`, `lint` across full workspace on PRs.
- Keep explicit job permissions.
