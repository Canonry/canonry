@AGENTS.md

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

### Charting (Critical)

**Recharts is the only charting library.** All charts must use it via `ChartPrimitives.tsx` — never import `recharts` directly in page/section components and never add Chart.js, Highcharts, D3, Plotly, Nivo, or Victory. ESLint enforces this.

- Import chart components and shared constants from `components/shared/ChartPrimitives.js`.
- Use `CHART_TOOLTIP_STYLE`, `CHART_AXIS_TICK`, `CHART_GRID_STROKE`, `CHART_AXIS_STROKE`, and `CHART_SERIES_COLORS` for consistent styling.
- Use `formatChartDateLabel` for tooltip labels and `formatChartDateTick` for axis ticks.
- Custom SVG is allowed only for non-chart visualizations (gauges, sparklines, timelines) where Recharts is overkill.
- If Recharts is missing a feature, extend `ChartPrimitives.tsx` rather than adding a second library.

### Don'ts
- Don't use hero grids with large descriptive text blocks on the project page. Keep headers compact.
- Don't put evidence or findings in card grids. Use tables.
- Don't add decorative background gradients or glow effects.
- Don't create new component files unless the component is reused across 3+ pages.
- Don't import `recharts` directly — use `ChartPrimitives.js`.
- Don't add alternative charting libraries (Highcharts, Chart.js, D3, etc.).

## Skills Maintenance

The repo ships **two** Claude skills under `skills/`, both bundled into the published `@ainyc/canonry` package and installable into any user's project via `canonry skills install`:

| Skill | Audience | Purpose |
|---|---|---|
| `skills/canonry-setup/` | External users (their Claude Code / Codex) | Operator playbook: how to install canonry, run sweeps, audit indexing, fix integrations |
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

- **New CLI command** → add it to `skills/canonry-setup/references/canonry-cli.md`
- **New provider** → update the provider list in `SKILL.md` and `canonry-cli.md`
- **New integration** (Google/Bing/CDP feature) → update the relevant reference file in `skills/canonry-setup/references/`
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
