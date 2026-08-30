# web

## Purpose

Vite SPA (React 19 + TanStack Router/Query + Tailwind CSS 4) for the analytics dashboard. Built and bundled into `packages/canonry/assets/` for distribution. This is the lowest-priority surface — never block a release on UI work.

## Product and design context

Read the repository-root `PRODUCT.md` and `DESIGN.md` before UI work. They are
the durable product and interaction contract. This file owns implementation
constraints; `DESIGN.md` owns hierarchy, copy, typography, and control choices.

## Key Files

| File | Role |
|------|------|
| `src/styles.css` | Tailwind v4 entrypoint, global component classes, semantic color/chart tokens |
| `src/api.ts` | `apiFetch<T>()` wrapper, `ApiError` class, all API call functions, `getEmbedConfig()` (#716 — reads `window.__CANONRY_CONFIG__.embed`, returns the block when enabled else `null`; `typeof window` guarded for SSR) |
| `src/embed.ts` | Read-only embed mode (#716) presentational helpers: `embedViewIdForPath(pathname)` (coarse route→view-id map for the route allowlist), `isEmbedProjectTabAllowed(tab, allow)` / `resolveEmbedProjectTab(requested, allow)` (the project-TAB allowlist — `embed.projectTabs` — used by `ProjectPage` to filter the subnav + fall a hidden tab back to a visible one; finer than the coarse view allowlist), and `embedThemeStyle(theme)` (allowlisted `--canonry-embed-*` CSS custom properties with per-value strict color-regex sanitization — CSS-injection guard) |
| `src/router/routes.tsx` | TanStack Router route tree |
| `src/pages/` | One file per page (ProjectPage is largest at 1,600 LOC) |
| `src/components/shared/ChartPrimitives.tsx` | Recharts wrapper — chart components and styling constants |
| `src/components/shared/ToneBadge.tsx` | Status indicator component with tone colors |
| `src/components/project/` | Project page section components (GscSection, TrafficSection, `SiteHealthSection`, etc.) |
| `src/components/project/SiteGraphSigma.tsx` / `site-graph-sigma.ts` | Site Health WebGL map and its Graphology adapter; consumes server-published coordinates only. The map defaults to content links and hides nav/header/footer links; the toggle changes only which edges are DRAWN, never the positions, which the server laid out without them. When `isTemplateDetectionApplied(templateDetection)` is false the toggle is disabled with plain-word copy and nothing is hidden, because the per-link flag proves nothing then. The header strip is ONE line of numbers (`site-map-link-counts`, built by `siteMapLinkCountsLabel`); why the split is worth having, which rule produced it, and any stale-layout warning live in an `InfoTooltip` beside it (`siteMapLinkRuleHelp`), always, in every state, because `applied` means the weaker ubiquity rule that cannot see an editorial link whose wording matches the menu. CUSTOMER-FACING COPY SAYS "links in your page text" and "menu and footer links", never "content link", "template link", "nav", or "chrome": those are our words, and the reader's distinction is WHERE the link was written. The wire vocabulary is unchanged and must stay (`linkKind=content|template|all`, `isTemplate`, `templateDetection`); this split is copy only. Short visible label, detail in a tooltip is the rule across this surface: an InfoTooltip is placed as a SIBLING of a heading, never a child, or its help text joins the heading's accessible name and any `aria-labelledby` landmark that points at it. The copy constants (`TEMPLATE_DETECTION_COPY`, `SITE_MAP_HELP`, `PAGE_INTERNAL_LINKS_HELP`, `SITE_MAP_STALE_LAYOUT_COPY`, `SITE_HEALTH_VIEW_DESCRIPTIONS`) are exported so tests assert the SHIPPED string rather than a substring of it. |
| `src/components/project/PageAuditEvidence.tsx` | Site Health "Findings and fixes": the per-factor technical checks. Every check starts COLLAPSED so the page opens scannable; the `<summary>` row carries factor name, score, and pass/partial/fail, which is everything needed to decide what to open. Native `<details>` is the disclosure primitive here, so the toggle is a real button with browser-managed expanded state and closed content stays out of the tab order. Critical defects render in their OWN always-visible section above the checks, so collapsing hides nothing that demands attention. |
| `src/queries/` | TanStack Query hooks for data fetching |
| `src/view-models.ts` | Data transformation from API DTOs to display format |

## Patterns

### API calls (Critical)

**Every web call into the canonry API MUST flow through the generated
`@ainyc/canonry-api-client` SDK.** Raw `fetch()` and `XMLHttpRequest` are
banned in `apps/web/src/` (ESLint-enforced) — the only exceptions are
`src/api.ts` and `src/api-aero.ts`, which are the SDK wrappers /
EventSource consumers respectively.

Why: the generated SDK is regenerated from the OpenAPI spec on every
`pnpm gen`, so types stay in lockstep with the server. Raw `fetch()`
also bypasses the `heyClient` response interceptor that handles 401/403
auth expiry — a missed-fetch login bug is silent until the user
notices their session died.

Two ways to call the API; pick by what you're building:

**1. TanStack Query hooks (preferred for cached reads + mutations)** —
generated `<op>Options(...)` / `<op>QueryKey(...)` / `<op>Mutation(...)`
helpers from `@ainyc/canonry-api-client/react-query`, passing the
exported `heyClient` from `src/api.ts`:

```typescript
import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameOptions } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../api.js'

function useProject(name: string) {
  return useQuery(getApiV1ProjectsByNameOptions({ client: heyClient, path: { name } }))
}
```

- Cache keys are derived from path + query params automatically.
- Auth-expiry (401/403) flows through the `heyClient` response interceptor.
- Generated types come from the spec; consumer types stay in sync.

**2. Typed wrappers in `src/api.ts` (for composites + imperative reads)** —
each wrapper is a thin shim over a generated SDK call that handles `ApiError`
mapping + 204 No Content + base-path resolution. Use them when you need
composite orchestration (parallel fan-out, multi-endpoint queryFn) that the
generated `<op>Options(...)` helpers can't express in a single call.

```typescript
const projects = await fetchProjects()  // returns ApiProject[]
```

If a wrapper you need doesn't exist, **add it to `src/api.ts` calling the
generated SDK function** — don't reach for `fetch()`. The pattern is:

```typescript
export function fetchMyNewThing(name: string): Promise<MyNewDto> {
  return invokeWeb<MyNewDto>(() =>
    getApiV1ProjectsByNameMyNewThing({ client: heyClient, path: { name } }),
  )
}
```

### Invalidation strategy

Pick by intent (documented at every call site in `mutations.ts` /
`run-invalidations.ts`):

- **Exact key** — `getApiV1<op>QueryKey({client: heyClient})`. Use for the
  literal top-level lists (`/projects`, `/runs`). Doesn't touch any
  per-project sub-endpoint.
- **Predicate by op-id prefix** — `query.queryKey[0]._id.startsWith('getApiV1ProjectsByNameBing')`.
  Use for whole-domain invalidations after integration mutations (Bing
  disconnect, GSC sync, GA sync, traffic source connect).

**Don't use `'getApiV1Projects'` as a prefix** — it greedily matches every
per-project sub-endpoint (Bing, GSC, GA, etc.) and churns unrelated caches.
For "the projects list" use the exact-key form.

### Spec gaps (loose-object endpoints)

A handful of endpoints (~41) still return `looseObjectSchema` in the spec —
the SDK types them as `Record<string, unknown>`. Two options when you hit
one:

1. **Add the schema (preferred):** define a Zod schema in
   `packages/contracts`, register it in `packages/api-routes/src/openapi-schemas.ts`,
   flip the route to `jsonResponse('...', 'YourDto')`, run `pnpm gen`. The
   `packages/api-routes/test/no-new-loose-routes.test.ts` count cap will go
   DOWN by one.
2. **Cast at the consumer (only if the schema work is genuinely deferred):**
   call the generated SDK helper and cast the response to the hand-typed
   `Api*` shape:
   ```typescript
   const data = (await queryClient.fetchQuery({
     ...getApiV1ProjectsByNameMyLooseEndpointOptions({ client: heyClient, path: { name } }),
   })) as unknown as ApiMyLooseShape
   ```
   Leave a TODO referencing the schema work.

**Do not add new `looseObjectSchema` routes.** The lock test
(`no-new-loose-routes.test.ts`) caps the current count; new endpoints must
ship with a registered Zod schema.

Base path comes from `window.__CANONRY_CONFIG__.basePath`. Never hardcode `/api/v1`.

### Read-only embed mode (#716)

When the server injects `window.__CANONRY_CONFIG__.embed` (via `canonry serve --embed`), `RootLayout` (`src/App.tsx`) takes a chromeless branch — placed AFTER every hook so Rules of Hooks hold on both paths — rendering only `<Outlet/>` inside a minimal `app-shell-embed` shell with NO sidebar / topbar / mobile nav / footer / drawers / `RunNotificationObserver` / `Toaster` / `AeroBarHost`. The optional `embed.views` allowlist gates the route via `embedViewIdForPath` (a non-allowlisted route renders a `embed-view-unavailable` state instead of the page, so surfaces like `/settings` are not reachable inside the iframe — a presentational gate, NOT a security boundary; the API key scope is the real boundary). The optional `embed.projectTabs` allowlist is a FINER gate that `ProjectPage` applies to the in-page tab subnav (Overview / Search Engines / Activity / Site Health / Local / Discovery / Backlinks / Report / Settings): it filters the rendered tabs to the allowlist and `resolveEmbedProjectTab` falls a direct-URL hit on a hidden tab back to Overview (or the first allowed tab). Site Health retains the stable `technical-aeo` allowlist token. This is what `embed.views` cannot do — every `/projects/*` collapses to the one `project` view id. Same posture as `views`: presentational, NOT a security boundary; unset = all tabs. The optional `embed.theme` supports `mode`, `bg`, `fg`, and `accent` through `embedThemeStyle` (sanitized, via the React `style` prop). Font overrides are unsupported. Every dashboard uses the bundled Geist files. With embed off, `getEmbedConfig()` returns `null` and the full chrome renders exactly as before.

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

### Charting and graph rendering

**Recharts only, via ChartPrimitives.tsx, for analytic charts.** Never import
`recharts` directly. ESLint enforces this.

```typescript
import { CHART_TOOLTIP_STYLE, CHART_AXIS_TICK, CHART_SERIES_COLORS } from '../shared/ChartPrimitives'
```

**Narrow Site Health exception:** the `/technical-aeo` route is labeled **Site
Health** and renders its site map with stable `sigma@3` through
`@react-sigma/core@5` and `graphology`. This is a WebGL graph renderer, not a
second charting system. Keep all Sigma/Graphology imports inside
`SiteGraphSigma.tsx` and `site-graph-sigma.ts`; every other visual stays on the
Recharts path above.

The browser must never run graph layout physics. It receives the immutable
coordinates published with the crawl snapshot (Graphology ForceAtlas2 runs in a
bounded Node worker during publication). The renderer may pan, zoom, focus,
dim, filter, and derive accessible controls from those positions, but must not
mutate or recompute them. A missing/failed/legacy layout is an explicit
unavailable state, not a client-side fallback layout.

### Design tokens

`src/styles.css` keeps font tokens in the existing `@theme inline` block, but
color and chart tokens live in a separate static, non-inline `@theme` block so
the full foundation is emitted while generated Tailwind utilities compile to
`var(--color-*)` and can be overridden at runtime.
New themeable UI code should use semantic utilities instead of literal palette
classes: `bg-bg`, `bg-surface`, `bg-surface-subtle`,
`bg-surface-hover`, `bg-surface-inset`, `bg-surface-inset-hover`,
`bg-surface-active`, `border-default`,
`border-subtle`, `border-base`, `border-strong`, `text-primary`,
`text-heading`, `text-strong`, `text-secondary`, `text-muted`,
`text-faint`, `text-link`, `text-on-inverse`, `text-on-emphasis`, plus tone
utilities such as `text-positive`, `border-positive`, `bg-positive-soft`, and
`fill-positive` (and the caution/negative/neutral variants).

For off-ladder shades that no role token names, use the raw scales rather than a
literal: neutral `mono-100/200/400/500/600/700/800/900/950` (= the matching
`zinc-*`) and the tone scales `positive-*` / `caution-*` / `negative-*` (=
`emerald-*` / `amber-*` / `rose-*`), plus the small `info-*` sky scale
(`100/200/300/400/500/800/950`) for info accents. Apply alpha with a Tailwind
opacity modifier on the scale token (`bg-mono-800/30`, `bg-caution-950/25`) —
this is exactly how `styles.css`'s one-off shades migrated with no visual
change. Effect colors live
as `--color-scrollbar-thumb`, `--color-shadow-drop`, `--color-shadow-panel`,
`--color-shadow-hairline`, `--color-shadow-tooltip`, `--color-overlay-hover`,
`--color-overlay-scrim`, and `--color-caution-glow`.

`styles.css` and the entire `apps/web/src` `.tsx` component tree are fully
tokenized (zero literal palette utilities / raw hex outside the `@theme` block) —
the Phase 3 migration is COMPLETE and enforced whole-tree by the ratchet below.
Do not add new literal palette utilities for themeable UI. The fixed provider
identity palettes in `ProviderBadge` (and `ChartPrimitives`' `var(--chart-*, #hex)`
fallbacks) remain literal because they encode engine identity, not semantic tone.

Two migration conventions (decided against the actual codebase, keep slices
consistent):

- **Off-ladder `zinc-900` alpha shades use `bg-bg-elevated/NN`**, not
  `bg-surface-hover` (they compute to the same color: `bg-elevated` is solid
  `zinc-900`, so the opacity modifier reproduces the literal exactly). The named
  `surface-*` role tokens (`bg-surface` = `/30`, `-subtle` = `/20`,
  `-hover` = `/40`) are reserved for the shades they name; the codebase uses
  `bg-bg-elevated/NN` everywhere else (`/40`, `/50`, `/60`, `/70`, `/80`).
- **Placeholder color uses the `placeholder-mono-NNN` shorthand**
  (e.g. `placeholder-mono-600`), not the `placeholder:text-*` variant form.

**Design-token ratchet (Phase 3, COMPLETE + enforced).** The
`design-tokens/no-literal-palette` ESLint rule (`eslint.config.js`) errors on any
raw Tailwind palette utility across the whole `apps/web/src` tree; only
`ProviderBadge` + `ChartPrimitives` are permanently excluded (engine identity /
chart hex fallbacks). The migration allowlist has been emptied and removed, so any
new literal palette utility now fails lint. `pnpm --filter @ainyc/canonry-web scan:colors`
reports per-file counts (now 0 — a progress view; the lint rule is the gate). New
themeable UI must use a semantic or scale token; if you ever introduce a run of
literals, migrate them in the same PR (class-only, no redesign) and keep these
checks green: `design-tokens.test.ts` + a `dashboard-class-baseline.test.tsx`
update if the baselined class lists move + typecheck + lint + build.

Token migration guardrails:

- `test/design-tokens.test.ts` compiles the stylesheet with Tailwind and proves
  semantic utilities reference CSS variables, including opacity modifiers like
  `bg-surface/50`, and that chart-only tokens are emitted before the chart
  bridge consumes them.
- `test/dashboard-class-baseline.test.tsx` SSR-renders representative routes and
  snapshots stable class lists for later migration PRs. jsdom cannot compute
  Tailwind v4 `@layer` / `@property` / `color-mix` output reliably, so the
  computed-style spot check is the Tailwind compiler-output assertion.

### Component organization

- Don't create new component files unless the component is reused across 3+ pages.
- Section components live in `src/components/project/` for the project page.
- Shared components live in `src/components/shared/`.

### Data display

- Use **data tables** for lists of 3+ structured items (evidence, findings, competitors).
- Use **cards** only for insights/interpretations where narrative matters.
- Use **ToneBadge** for all status indicators. Map tones through helper functions.
- Do not use radial/progress gauges for unbounded counts. They require a real
  bounded scale.
- Pills are status/tag indicators only. Use tabs, selects, segmented controls,
  checkboxes, or shared rectangular buttons for interactive choices.

### Query workspace

`DiscoverySection` owns the Tracked, Discover, and Test tabs. `ResearchQueriesSection`
owns the Test form, saved answers, and tracking preview.

- Use the server's `measurement-query-statuses` response for assignment scope and query class.
- Show missing catalog queries from `activePlanOrphans`. Their published assignments can still run.
- If scope is unavailable, disable catalog changes. Do not infer Simple mode from missing data.
- For assigned Advanced queries, open the draft editor instead of the generic query deletion route.
- Keep the current published plan active until the operator publishes the draft.
- Save query text with the guarded `replace-query` draft action. Preserve the exact assignment scope and execution settings.
- Use `measurementStep=queries` and `measurementQueryId` for the assignment-editor link. Preserve the separate `runId` drawer parameter.
- Select the existing assigned Properties on entry. Do not default an edit to the whole portfolio.
- Give unassigned saved queries an Assign Properties action. Start with no Properties selected.
- Keep test results separate from official measurements. Show the selected provider, model, location, and query count before the Run action.
- Preserve the context of saved test results when the operator changes the test form.
- Keep test history and model overrides behind disclosure. Keep loading and failure states visible.

## Common Mistakes

- **Importing `recharts` directly** — use `ChartPrimitives.tsx` exports.
- **Adding alternative charting libraries** (Chart.js, D3, Highcharts) — Recharts is the only chart library; the isolated Site Health Sigma/Graphology exception above is not a precedent for other views.
- **Hardcoding `/api/v1`** — use the base path from `window.__CANONRY_CONFIG__`.
- **Using card grids for tabular data** — analysts prefer tables for scanability.
- **Adding decorative gradients or glow effects** — the design system is clean and flat.

## See Also

- Root `CLAUDE.md` — full UI design system (colors, layout, accessibility, sidebar)
- `packages/contracts/` — DTOs returned by the API
- `packages/api-routes/` — backend endpoints the UI calls
