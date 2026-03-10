# CLAUDE.md

## Project Overview

`canonry` is an open-source AEO monitoring tool that tracks how AI answer engines cite a domain for tracked keywords. Built on the published `@ainyc/aeo-audit` npm package.

## Current Phase

**Phase 2** — building the publishable `@ainyc/canonry` npm package with CLI, local server, SQLite, and multi-provider visibility runs (Gemini, OpenAI, Claude). See `docs/phase-2-design.md` for the full architecture plan.

**In scope:** Visibility runs, CLI, config-as-code, API, bundled SPA, SQLite, auth, audit log, usage counters.
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
packages/provider-openai/ OpenAI adapter
packages/provider-claude/ Claude/Anthropic adapter
docs/                     Architecture, product plan, testing, ADRs
```

## Commands

```bash
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
canonry apply <canonry.yaml>
canonry export <project>
```

## Dependency Boundary

- Use `@ainyc/aeo-audit` as an external dependency.
- Do not copy source files out of the audit package repo into this repo.
- Any use of the audit engine should go through explicit adapters in `apps/worker`.
- `packages/api-routes/` must not import from `apps/*`.
- `packages/canonry/` is the only publishable artifact.

## Surface Parity

**Every feature must be equally accessible through CLI, API, and UI.** No surface is privileged — if a user can do something from the terminal, they must be able to do the same from the web dashboard and vice versa. The API is the shared backbone; both CLI and UI are clients of it.

When adding a new feature:
1. Add the API endpoint in `packages/api-routes/`.
2. Add the CLI command in `packages/canonry/src/commands/`.
3. Add the UI interaction in `apps/web/`.
4. All three must ship together — do not defer one surface to a later phase.

## Maintenance Guidance

- Keep shared shapes in `packages/contracts`.
- Keep environment parsing in `packages/config`.
- Keep provider logic in `packages/provider-*/`.
- Keep API route plugins in `packages/api-routes` (no app-level concerns).
- Keep API handlers thin.
- Keep the monitoring app independent from the audit package repo except for the published npm dependency.
- Raw observation snapshots only (`cited`/`not-cited`); transitions computed at query time.

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

Apply with `canonry apply <file>` or `POST /api/v1/apply`. DB is authoritative; config files are input.

## API Surface

All endpoints under `/api/v1/`. Auth via `Authorization: Bearer cnry_...`. Key endpoints:

- `PUT /api/v1/projects/{name}` — create/update project
- `POST /api/v1/projects/{name}/runs` — trigger visibility sweep
- `GET /api/v1/projects/{name}/timeline` — per-keyword citation history
- `GET /api/v1/projects/{name}/snapshots/diff` — compare two runs
- `POST /api/v1/apply` — config-as-code apply
- `GET /api/v1/openapi.json` — OpenAPI spec (no auth)

See `docs/phase-2-design.md` section 6 for the complete API table.

## UI Design System

The web dashboard follows a dark, professional analytics aesthetic designed to rival tools like Semrush, Ahrefs, and Profound. Follow these conventions for all UI work:

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

## Improvement Order (Phase 2)

1. Database schema and contracts foundation
2. API route plugins (`packages/api-routes/`)
3. Provider execution (Gemini, OpenAI, Claude) and job runner
4. Publishable package (`packages/canonry/`)
5. Wire web dashboard to real API

## CI Guidance

- Validation CI: `typecheck`, `test`, `lint` across the full workspace on PRs.
- Keep explicit job permissions.
- Publish workflow will be added when `packages/canonry/` is ready for npm.
