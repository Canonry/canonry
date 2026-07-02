@AGENTS.md

## UI Design System

The web dashboard follows a dark, professional analytics aesthetic inspired by **Vercel's design system** — clean, minimal, high-contrast, and information-dense. Rival tools like Semrush, Ahrefs, and Profound for data richness, but match Vercel for polish: generous whitespace, sharp typography, subtle borders, no visual noise. Follow these conventions for all UI work:

### Layout
- **Sidebar navigation** (persistent left, `w-56`, hidden on mobile with full-screen overlay fallback).
- **Compact topbar** with breadcrumb, health pills, and primary action button.
- **Page container** (`max-w-6xl`, centered) for all page content.
- Pages use a `page-header` (title + subtitle + optional actions) followed by sections separated by `page-section-divider`.

### Color & Theme
- Use semantic color tokens for new dashboard code. `apps/web/src/styles.css`
  registers color/chart tokens in a static, non-inline `@theme` block so the
  full foundation is emitted and generated utilities still reference
  runtime-overridable CSS variables. The font tokens stay in the existing
  `@theme inline` block until the typography phase.
- Current dark defaults: `bg-bg` = `zinc-950`; `bg-surface` = `zinc-900/30`;
  `bg-surface-subtle` = `zinc-900/20`; `bg-surface-hover` = `zinc-900/40`;
  `bg-surface-inset` = `zinc-800/60`; `bg-surface-inset-hover` =
  `zinc-800/40`; `bg-surface-active` = `zinc-800/50`;
  `border-default` = `zinc-800/60`; `border-subtle` =
  `zinc-800/40`; `border-base` =
  `zinc-800`; `border-strong` = `zinc-700`; `text-primary` =
  `zinc-50`; `text-heading` = `zinc-100`; `text-strong` = `zinc-200`;
  `text-secondary` = `zinc-400`; `text-muted` = `zinc-500`;
  `text-faint` = `zinc-600`.
- Off-ladder shades resolve through raw scales, never new literals: the neutral
  `mono-*` scale (`mono-100/400/500/600/700/800`, each = the matching `zinc-*`)
  backs one-off dots, focus rings, tracks, dividers, and underlines; the tone
  scales (`positive-*` = `emerald-*`, `caution-*` = `amber-*`, `negative-*` =
  `rose-*`, at the ladder's levels) back insight cards, toasts, chips, gauges,
  and sparklines. Prefer the semantic role tokens above; reach for a scale token
  — with a Tailwind opacity modifier for alpha steps, e.g. `bg-caution-950/25`,
  `border-mono-800/30` — only for a shade the role tokens don't name. Effect
  colors cover the remaining raw hex: `--color-track`, `--color-scrollbar-thumb`,
  `--color-shadow-drop`, `--color-shadow-panel`, `--color-overlay-hover`,
  `--color-caution-glow` / `-glow-inset`.
- `apps/web/src/styles.css` is fully tokenized — zero literal palette utilities
  and zero raw hex/rgba outside the `@theme` block (guarded by
  `design-tokens.test.ts`). Literal palette utilities (`bg-zinc-*`, `text-zinc-*`,
  `border-zinc-*`, `emerald` / `amber` / `rose`) still exist in the `.tsx`
  component code until the Phase 3 migration completes. Do not add new literal
  palette utilities for themeable UI; add or use a semantic (or scale) token.
- Font: **Geist Sans** (400–800 weights) for UI text, **Geist Mono** for code/numerics. Globally enabled OpenType features `cv11`, `ss01`, `ss03` for sharper i/l/I/0 disambiguation. Headings tighten tracking (`-0.015em`, `-0.02em` on h1). Use `text-heading` / `text-strong` for heading and emphasized neutral text, `text-primary` for highest-contrast body text, `text-secondary` for supporting text, and `text-muted` / `text-faint` for labels.
- Tone tokens: **positive** = emerald, **caution** = amber, **negative** = rose, **neutral** = zinc. Use `text-positive`, `border-positive`, `bg-positive-soft`, `fill-positive`, and the matching caution/negative/neutral utilities for new themeable tone work. **info** = sky is a minor accent (opportunity "track" cards, the suggested-query add action) exposed only as an `info-{200,300,500,950}` scale, not a full tone quartet.
- Provider identity colors in `ProviderBadge` encode which answer engine produced a signal. They are not semantic tone colors and stay literal unless the provider identity system changes.
- No decorative background gradients. Keep it clean and flat.

### Components & Patterns
- **AEO performance hero + metric cards:** the project overview leads with the AEO performance hero — three paired Mention / Cited / Mention-share rows with linear progress bars (stacking below `480px`) — followed by secondary metric cards in a `sm:grid-cols-2 lg:grid-cols-3` grid. Linear bars beat stacked radials when several numbers are read against each other. Keep a single `.metric-grid` / `.metric-card` definition; a duplicate once overrode the column count.
- **Score gauges** (`ScoreGauge`): SVG radial progress rings for a single numeric/text metric (e.g. traffic-source detail). Don't rebuild the overview header as a gauge cluster.
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

### Text & Tooltips
- **Heavy text belongs in tooltips, not inline.** A data surface shows values, one-line captions, and eyebrow labels — not prose. Multi-sentence explanations (methodology, "what this means", the evidence behind a finding) push the numbers down and break the analyst's scan, so they move into an `InfoTooltip` (`components/shared/InfoTooltip.tsx`) on the relevant heading, label, or row title. The trigger is a real keyboard-reachable button and the copy rides its `aria-label`, so nothing is lost for assistive tech or for tests (`getByRole('button', { name })`).
- **What may stay inline:** the metric value itself, a single-line caption/subtitle, eyebrow section labels, and **empty / onboarding states** (which must instruct — a "connect this integration" empty state is the only content, not heavy text).
- **The test:** if a sentence explains or justifies rather than labels or names, it goes in a tooltip. The section heading gets the info icon; the descriptive paragraph under it should not exist.

### Accessibility
- Skip-to-content link.
- `aria-current="page"` on active nav items.
- `aria-label` on nav landmarks.
- Focus-visible rings on interactive elements.
- Screen-reader-only labels (`.sr-only`) where needed.

### Charting (Critical)

**Recharts is the only charting library.** All charts must use it via `ChartPrimitives.tsx` — never import `recharts` directly in page/section components and never add Chart.js, Highcharts, D3, Plotly, Nivo, or Victory. ESLint enforces this.

- Import chart components and shared constants from `components/shared/ChartPrimitives.js`.
- Use `CHART_TOOLTIP_STYLE`, `CHART_AXIS_TICK`, `CHART_GRID_STROKE`, `CHART_AXIS_STROKE`, and `CHART_SERIES_COLORS` for consistent styling.
- Chart CSS variables (`--chart-series-*`, `--chart-tone-*`, `--chart-neutral-*`, `--chart-tooltip-*`, `--chart-grid`, `--chart-axis`) are registered in `styles.css`. Phase 4 bridges `ChartPrimitives.tsx` to these variables; until then, keep the JS constants and CSS token defaults in sync when touching chart colors.
- Use `formatChartDateLabel` for tooltip labels and `formatChartDateTick` for axis ticks.
- Custom SVG is allowed only for non-chart visualizations (gauges, sparklines, timelines) where Recharts is overkill.
- If Recharts is missing a feature, extend `ChartPrimitives.tsx` rather than adding a second library.

### Report parity (Critical)

**The downloadable HTML report (`canonry report` / `GET /report.html`) and the in-app SPA report view must stay perfectly aligned.** They are two renderers of the same `ProjectReportDto` — clients and agencies see one report. Any change to a section, label, headline, chart, tile, or order in `apps/web/src/pages/ReportPage.tsx` must ship the same change in `packages/api-routes/src/report-renderer.ts` in the same commit, and vice versa. Tile labels, eyebrows, titles, subtitles, action-card copy, and evidence-card titles must match verbatim across both. Update `packages/api-routes/test/report-renderer.test.ts` whenever client/agency strings change. See AGENTS.md "Report parity" for the full rule set.

### Theme Migration Tests

- `apps/web/test/design-tokens.test.ts` compiles `styles.css` with Tailwind's compiler and asserts semantic utilities such as `bg-bg`, `bg-surface/50`, `border-default`, and `text-primary` resolve through CSS variables. This is the build assertion that guards against accidentally putting color tokens in `@theme inline` and confirms chart-only tokens are emitted before the chart bridge uses them.
- `apps/web/test/dashboard-class-baseline.test.tsx` SSR-renders representative routes and snapshots stable component class lists. Use it as a fast migration tripwire before browser visual checks. The suite runs in jsdom; jsdom cannot compute Tailwind v4's modern CSS output (`@layer`, `@property`, `color-mix`) reliably, so computed-style coverage lives at the Tailwind compiler-output level here.

### Don'ts
- Don't use hero grids with large descriptive text blocks on the project page. Keep headers compact.
- Don't set multi-sentence explanatory prose inline in a data view — move it to an `InfoTooltip` on the heading or row title. (Empty / onboarding states are the exception.)
- Don't put evidence or findings in card grids. Use tables.
- Don't add decorative background gradients or glow effects.
- Don't create new component files unless the component is reused across 3+ pages.
- Don't import `recharts` directly — use `ChartPrimitives.js`.
- Don't add alternative charting libraries (Highcharts, Chart.js, D3, etc.).
- Don't change report copy or sections in only one of the SPA / HTML surfaces — they must move together.

## Skills Maintenance

The repo ships **two** Claude skills under `skills/`, both bundled into the published `@canonry/canonry` package and installable into any user's project via `canonry skills install`:

| Skill | Audience | Purpose |
|---|---|---|
| `skills/canonry/` | External users (their Claude Code / Codex) | Operator playbook: how to install canonry, run sweeps, audit indexing, fix integrations |
| `skills/aero/` | Aero (canonry's built-in analyst) AND external users | Analyst playbook: regression diagnosis, orchestration, memory patterns, reporting |

**Keep both skills in sync with the codebase.** Both are co-equal — the analyst playbook ships alongside the operator playbook in every install (see `feedback_analyst_is_core` memory).

### Layout

Each skill is a directory tree:

```
skills/<name>/
  SKILL.md          # tight entry point (≤ ~100 lines): when to use, top-level capabilities, references TOC
  references/       # deep playbooks the agent reads on demand
    *.md
```

`SKILL.md` is the only file always pulled into agent context when the skill is invoked. References lazy-load — the agent `Read`s them only when the task matches. **Keep `SKILL.md` lean** and push detail into `references/`.

### When to update skills

- **New CLI command** → add it to `skills/canonry/references/canonry-cli.md`
- **New provider** → update the provider list in `SKILL.md` and `canonry-cli.md`
- **New integration** (Google/Bing/CDP feature) → update the relevant reference file in `skills/canonry/references/`
- **Changed troubleshooting patterns** → update the troubleshooting table in `SKILL.md`
- **New analytics feature** → update `references/aeo-analysis.md`
- **New analyst workflow / reporting template** → update `skills/aero/references/`

### Bundling and installation

- `packages/canonry/scripts/copy-agent-assets.ts` mirrors `skills/<name>/` into `packages/canonry/assets/agent-workspace/skills/<name>/` at build time so the trees ship in the published package.
- `canonry skills install [--dir <path>] [--client claude|codex|all] [--force]` writes the bundled trees into `<dir>/.claude/skills/<name>/` and (for codex) creates a relative symlink at `<dir>/.codex/skills/<name>` pointing back at the Claude path. Default scope: all skills, both clients.
- `canonry init` auto-runs `installSkills()` when the cwd looks like a project (has `.git`, `canonry.yaml`, or `package.json`); otherwise prints a tip. Pass `--skip-skills` to opt out or `--skills-dir <path>` to override the target.

### What NOT to put in skills

- Internal implementation details, file paths, or architecture
- Anything that changes every release (version numbers, changelog)
- Dev-only workflows (testing, CI, building from source beyond basic install)
