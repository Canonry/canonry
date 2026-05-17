# web

## Purpose

Vite SPA (React 19 + TanStack Router/Query + Tailwind CSS 4) for the analytics dashboard. Built and bundled into `packages/canonry/assets/` for distribution. This is the lowest-priority surface — never block a release on UI work.

## Key Files

| File | Role |
|------|------|
| `src/api.ts` | `apiFetch<T>()` wrapper, `ApiError` class, all API call functions |
| `src/router/routes.tsx` | TanStack Router route tree |
| `src/pages/` | One file per page (ProjectPage is largest at 1,600 LOC) |
| `src/components/shared/ChartPrimitives.tsx` | Recharts wrapper — chart components and styling constants |
| `src/components/shared/ToneBadge.tsx` | Status indicator component with tone colors |
| `src/components/project/` | Project page section components (GscSection, TrafficSection, etc.) |
| `src/queries/` | TanStack Query hooks for data fetching |
| `src/view-models.ts` | Data transformation from API DTOs to display format |

## Patterns

### API calls

Two paths into the API, choose based on what you're building:

**1. New TanStack Query hooks (preferred for new code)** — use the generated
`<op>Options(...)` / `<op>QueryKey(...)` / `<op>Mutation(...)` helpers from
`@ainyc/canonry-api-client/react-query`, passing the exported `heyClient`
from `src/api.ts`:

```typescript
import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameOptions } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../api.js'

function useProject(name: string) {
  return useQuery(getApiV1ProjectsByNameOptions({ client: heyClient, path: { name } }))
}
```

- Cache keys are derived from path + query params — no hand-curated
  `query-keys.ts` entry needed.
- Auth-expiry (401/403) still fires `handleAuthExpired()` via the response
  interceptor wired on `heyClient` in `src/api.ts`.
- Generated types come from the spec; consumer types stay in sync with the
  server automatically.

**2. Existing fetchers in `src/api.ts` (for composites and pre-migration sites)** —
the typed `fetchX()` wrappers still work and feed every existing hook in
`src/queries/`. They go through `invokeWeb()` which handles `ApiError`
mapping + 204 No Content + base-path resolution. Use them when you need
composite orchestration (parallel fan-out, multi-endpoint queryFn) that
the generated `<op>Options(...)` helpers can't express in a single call.

```typescript
const projects = await fetchProjects()  // returns ApiProject[]
```

Base path comes from `window.__CANONRY_CONFIG__.basePath`. Never hardcode `/api/v1`.

### DTO types — generated vs hand-typed

`src/api.ts` re-exports the generated `RunDto`, `QueryDto`, `CompetitorDto`
as `ApiRun`, `ApiQuery`, `ApiCompetitor`. Use the `Api*` names — they're
the same shape but the alias makes it clear the source is the spec.

A few `Api*` interfaces remain hand-defined (`ApiProject`, `ApiSnapshot`,
`ApiRunDetail`, etc.) because the generated shape would cascade
`displayName: string | undefined` / `createdAt: string | undefined` drift
through every consumer that assumes those fields are always present.
Migrating each requires consumer-side review; track as separate follow-up
PRs rather than rolling into tooling work.

### Charting

**Recharts only, via ChartPrimitives.tsx.** Never import `recharts` directly. ESLint enforces this.

```typescript
import { CHART_TOOLTIP_STYLE, CHART_AXIS_TICK, CHART_SERIES_COLORS } from '../shared/ChartPrimitives'
```

### Component organization

- Don't create new component files unless the component is reused across 3+ pages.
- Section components live in `src/components/project/` for the project page.
- Shared components live in `src/components/shared/`.

### Data display

- Use **data tables** for lists of 3+ structured items (evidence, findings, competitors).
- Use **cards** only for insights/interpretations where narrative matters.
- Use **ToneBadge** for all status indicators. Map tones through helper functions.

## Common Mistakes

- **Importing `recharts` directly** — use `ChartPrimitives.tsx` exports.
- **Adding alternative charting libraries** (Chart.js, D3, Highcharts) — Recharts is the only allowed library.
- **Hardcoding `/api/v1`** — use the base path from `window.__CANONRY_CONFIG__`.
- **Using card grids for tabular data** — analysts prefer tables for scanability.
- **Adding decorative gradients or glow effects** — the design system is clean and flat.

## See Also

- Root `CLAUDE.md` — full UI design system (colors, layout, accessibility, sidebar)
- `packages/contracts/` — DTOs returned by the API
- `packages/api-routes/` — backend endpoints the UI calls
