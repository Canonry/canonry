# CLAUDE.md

## Project Overview

`canonry` is an open-source **agent-first** AEO monitoring platform that tracks how AI answer engines cite a domain for tracked keywords. Published as `@ainyc/canonry` on npm. The CLI and API are the primary interfaces — the web dashboard is supplementary.

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
packages/provider-openai/ OpenAI adapter
packages/provider-claude/ Claude/Anthropic adapter
packages/provider-local/  Local LLM adapter (OpenAI-compatible API)
docs/                     Architecture, roadmap, testing, ADRs
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

# CLI (after Phase 2 implementation)
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

## Database Schema Changes (Critical)

**Every new `sqliteTable(...)` in `packages/db/src/schema.ts` MUST have a corresponding migration in `packages/db/src/migrate.ts`.**

This is not optional. If you add a table to the schema but omit the migration, the table will never be created in any existing or new database, and every query against it will throw `no such table` at runtime.

### Rules

1. **New table** → add `CREATE TABLE IF NOT EXISTS ...` to the `MIGRATIONS` array in `migrate.ts`. Include all indexes from the schema definition.
2. **New column** → add `ALTER TABLE ... ADD COLUMN ...` to `MIGRATIONS`. SQLite ignores duplicate `ADD COLUMN` attempts, so these are safe to re-run.
3. **Removed column or table** → SQLite does not support DROP COLUMN on older versions; document the intent and leave the migration as a no-op comment if needed.
4. **Never edit MIGRATION_SQL** (the initial block at the top). That block bootstraps brand-new installs. All incremental changes go in the `MIGRATIONS` array only.

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

## UI Design System

The web dashboard follows a dark, professional analytics aesthetic inspired by **Vercel's design system** — clean, minimal, high-contrast, and information-dense. Rival tools like Semrush, Ahrefs, and Profound for data richness, but match Vercel for polish: generous whitespace, sharp typography, subtle borders, no visual noise. Follow these conventions for all UI work:

### Layout
- **Sidebar navigation** (persistent left, `w-56`, hidden on mobile with full-screen overlay fallback).
- **Compact topbar** with breadcrumb, health pills, and primary action button.
- **Page container** (`max-w-6xl`, centered) for all page content.
- Pages use a `page-header` (title + subtitle + optional actions) followed by sections separated by `page-section-divider`.

### Color & Theme
- Background: `bg-zinc-950`. Cards/surfaces: `bg-zinc-900/30` with `border-zinc-800/60`.
- Font: **Manrope** (400–800 weights), `text-zinc-50` primary, `text-zinc-400` secondary, `text-zinc-500`/`text-zinc-600` for labels.
- Tone colors: **positive** = emerald, **caution** = amber, **negative** = rose, **neutral** = zinc.
- No decorative background gradients. Keep it clean and flat.

### Components & Patterns
- **Score gauges** (`ScoreGauge`): SVG radial progress rings for numeric and text metrics. Use on project pages instead of flat metric cards.
- **Data tables** for evidence, findings, and competitors (not card grids). Tables are more scanable for analysts.
- **Insight cards** with left-border accent color based on tone (`insight-card-positive`, `insight-card-caution`, `insight-card-negative`).
- **Sparklines** for inline trend visualization in overview project rows.
- **ToneBadge** for all status/state indicators. Map tones through helper functions (`toneFromRunStatus`, `toneFromCitationState`, etc.).
- **Filter chips** use `rounded-full` pill style.
- **Health pills** in topbar use `rounded-full` with tone-colored borders.

### Sidebar
- Main nav items use Lucide icons (`LayoutDashboard`, `Globe`, `Play`, `Settings`).
- Projects section shows each project with a colored dot indicating visibility health tone.
- Resources section at bottom with `Rocket` icon for Setup.
- Doc links in sidebar footer.

### Data Density
- Prioritize information density. Analysts want to scan, not scroll through cards.
- Use tables for any list of 3+ structured items (evidence, findings, competitors).
- Use cards only for insights/interpretations where narrative matters.
- Keep eyebrow labels (`text-[10px]`, uppercase, tracking-wide) for section context.

### Accessibility
- Skip-to-content link.
- `aria-current="page"` on active nav items.
- `aria-label` on nav landmarks.
- Focus-visible rings on interactive elements.
- Screen-reader-only labels (`.sr-only`) where needed.

### Don'ts
- Don't use hero grids with large descriptive text blocks on the project page. Keep headers compact.
- Don't put evidence or findings in card grids. Use tables.
- Don't add decorative background gradients or glow effects.
- Don't create new component files unless the component is reused across 3+ pages.

## Roadmap

See `docs/roadmap.md` for the full feature roadmap including competitive analysis, priority matrix, and phased implementation order.

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

## Skills Maintenance

The `skills/canonry-setup/` directory contains an OpenClaw/Claude skill that documents how to install, configure, and operate canonry. **Keep this skill in sync with the codebase.**

### When to update skills

- **New CLI command** → add it to `skills/canonry-setup/references/canonry-cli.md`
- **New provider** → update the provider list in `SKILL.md` and `canonry-cli.md`
- **New integration** (Google/Bing/CDP feature) → update the relevant reference file in `skills/canonry-setup/references/`
- **Changed troubleshooting patterns** → update the troubleshooting table in `SKILL.md`
- **New analytics feature** → update `references/aeo-analysis.md`

### What NOT to put in skills

- Internal implementation details, file paths, or architecture
- Anything that changes every release (version numbers, changelog)
- Dev-only workflows (testing, CI, building from source beyond basic install)

## CI Guidance

- Validation CI: `typecheck`, `test`, `lint` across the full workspace on PRs.
- Keep explicit job permissions.
- Publish workflow will be added when `packages/canonry/` is ready for npm.
