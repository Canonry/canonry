# CLAUDE.md

## Project Overview

`canonry` is the monitoring application that sits on top of the published `@ainyc/aeo-audit` npm package. This repo owns the product surface, not the audit package itself.

## Workspace Map

```text
apps/api/             Fastify API
apps/worker/          Background worker and audit/provider adapters
apps/web/             Vite dashboard
packages/contracts/   Shared DTOs and enums
packages/config/      Typed environment parsing
packages/db/          Database placeholder
packages/provider-gemini/ Gemini adapter placeholder
docs/                 Architecture, testing, self-hosting, ADRs
```

## Commands

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run dev:api
pnpm run dev:worker
pnpm run dev:web
pnpm run docker:up
```

## Dependency Boundary

- Use `@ainyc/aeo-audit` as an external dependency.
- Do not copy source files out of the audit package repo into this repo.
- Any use of the audit engine should go through explicit adapters in `apps/worker`.

## Maintenance Guidance

- Keep shared shapes in `packages/contracts`.
- Keep environment parsing in `packages/config`.
- Keep provider logic in `packages/provider-gemini`.
- Keep API handlers thin.
- Keep the monitoring app independent from the audit package repo except for the published npm dependency.

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

## Improvement Order

1. Shared contracts and docs
2. Backend services and worker logic
3. Provider execution and persistence
4. UI expansion

## CI Guidance

- This repo has validation CI only; there is no publish workflow here.
- Keep explicit job permissions.
- Run `typecheck`, `test`, and `lint` across the full workspace on PRs.
