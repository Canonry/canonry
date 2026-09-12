# CODEMAP — File-Level Index for Agents

> Single-pass navigation map. Every entry is a real path. Per-package `AGENTS.md` owns durable rules; this file is the fast index. Regenerate the file list with `find apps packages -type f -name '*.ts' -o -name '*.tsx' | sort`.

Start with `AGENTS.md` (project overview + deployment posture), then `docs/README.md` (doc map), then the per-package `AGENTS.md` nearest your task. Never read `AGENTS.md` in one giant chunk — read the section you need.

## Root

| Path | Role |
|------|------|
| `AGENTS.md` | Primary agent guidance — deployment posture, workspace map, commands, agent layer, doctor |
| `CLAUDE.md` | Claude overlay (imports AGENTS.md + UI design system) |
| `docs/GUARDS.md` | Lint guard table + adding-a-guard procedure (extracted from AGENTS.md) |
| `docs/DOC_UPDATE.md` | Keeping-docs-current table (extracted from AGENTS.md) |
| `PRODUCT.md` / `DESIGN.md` | Dashboard purpose, hierarchy, copy, controls — read before UI work |
| `CONTRIBUTING.md` | Setup, `pnpm install` / `typecheck` / `test` / `lint` |
| `canonry-install.sh` | One-command dev setup: install + build + global link |

## Apps

### `apps/web/` — Vite SPA (React 19 + TanStack Router/Query + Tailwind 4)
Bundled via `packages/canonry/build-web.ts` → `packages/canonry/assets/`. Lowest-priority surface.

| Path | Role | Notes |
|------|------|-------|
| `src/App.tsx` | Root layout, first-run redirect (`/` → `/setup` when 0 projects), health, notifications, AeroBar host | Check before changing first-open flow |
| `src/router/routes.tsx` | TanStack Router tree (`/`, `/projects`, `/projects/$projectName`, `/runs`, `/traffic`, etc.) | Route = one lazy chunk |
| `src/pages/SetupPage.tsx` | 1260 LOC wizard: `System check → Create project → Queries → Competitors → Launch` | Largest page — state machine `deriveSetupStep`, resume from `useDashboard` |
| `src/pages/ProjectPage.tsx` | Project shell + tab router (`overview`, `portfolio`, `search-console`, `local`, `discovery`, `report`, `activity`, `backlinks`, `technical-aeo`, `history`, `settings`); stable `technical-aeo` key/route is labeled **Site Health** | Extract before adding hooks |
| `src/pages/OverviewPage.tsx` | Portfolio overview (project list, sparkline, health cards) | |
| `src/pages/ProjectsPage.tsx` / `HistoryPage.tsx` / `RunsPage.tsx` / `SettingsPage.tsx` / `BacklinksPage.tsx` / `TrafficPage.tsx` | One file per route | |
| `src/components/project/*` | Section components: `GscSection`, `BingSummaryMetric`, `SiteHealthSection`, `SiteGraphSigma`, `TechnicalAeoSection`, `DiscoverySection`, `CitationVisibilitySection`, `VisibilityTrendSection`, `ActivitySection`, `BacklinksSection`, `GbpSection`, etc. | Site Health's map is Sigma v3 WebGL + Graphology; browser consumes published coordinates and never runs layout physics. |
| `src/components/project/advanced-measurement/*` | Advanced measurement UI (`AdvancedMeasurementSection`, `SetupWizard`, adapters) | |
| `src/components/shared/*` | `ChartPrimitives` (Recharts wrapper), `AeroBar`, `BrandLockup`, `ToneBadge`, `ProviderBadge`, `StatusBadge` | |
| `src/components/ui/*` | `button`, `card`, `badge`, `sheet` (Radix + Tailwind) | |
| `src/components/layout/*` | `Drawer`, `ErrorBoundary`, `TaskCenter`, `Toaster` | |
| `src/api.ts` | `heyClient`, `apiFetch<T>`, typed wrappers over `@ainyc/canonry-api-client` | **All web API calls must go through generated SDK** (`@ainyc/canonry-api-client/react-query`) — `fetch()` banned except here |
| `src/api-aero.ts` | Aero SSE client | |
| `src/embed.ts` | Presentational embed helpers: `embedViewIdForPath`, `isEmbedProjectTabAllowed`, `embedThemeStyle` | Pure, testable |
| `src/lib/*` | `health-helpers`, `onboarding-telemetry`, `format-helpers`, `run-tracker-store`, `tone-helpers`, `write-guard`, `base-path`, `safe-url`, etc. | |
| `src/queries/*` | TanStack Query hooks (`use-dashboard-overview`, `use-project-dashboard`, `use-health`, `mutations`, `server-traffic`) | |
| `src/contexts/*` | `dashboard-context`, `account-context` | |
| `src/mappers/insight-mapper.ts` | Insight DTO → view-model | |
| `src/styles.css` | Tailwind v4 entry, semantic tokens (`--color-bg`, `--surface`, `--text-*`, tone scales) | |
| `src/mock-data.ts` | Static demo data — not for example-workspace adapter | |
| `vite.config.ts` | `base: './'`, proxy `/api/v1` → `CANONRY_API_URL` (default 4100), `manualChunks` for recharts/tanstack/markdown | |
| `AGENTS.md` | Per-app agent rules, API call patterns | |

### `apps/api/` — Cloud Run entry (imports `packages/api-routes`)
### `apps/worker/` — Cloud worker entry

### `apps/vals/ai-visibility-check/` — Public Deno / Val Town sample

| Path | Role | Notes |
|------|------|-------|
| `main.http.tsx` | Val HTTP entry | Thin composition root for the bounded public sample |
| `deno.json` / `deno.lock` | Self-contained production Deno imports and locked graph | Exact external pins must match the Canonry engine contract; this is the graph deploy validates |
| `deno.dev.json` | Dev graph: same tasks, `@canonry/val-kit` linked to the workspace copy | What local verification runs; never pushed to Val Town |
| `src/` | HTTP policy, bounded check runner, provider adapter, storage ports, evidence UI | Host owns quotas, provider access, secrets, and persistence |
| `README.md` / `AGENTS.md` | Local limits, release order, and durable guardrails | Read before changing the Val host |

### `apps/vals/brand-perception-check/` — Public Deno / Val Town sample

What an answer engine SAYS about a brand when asked about it directly. A separate instrument from AI Visibility, never
a variant: every question names the brand, so the two share no denominator, no table, and no cache.

| Path | Role | Notes |
|------|------|-------|
| `main.http.tsx` | Val HTTP entry | Names `CheckStore<PerceptionCheckResult>` once; everything downstream is typed from there |
| `deno.json` | Self-contained production Deno graph | No production `deno.lock` yet — it cannot be generated until `@canonry/val-kit` is on public npm |
| `deno.dev.json` / `deno.dev.lock` | Dev graph: `@canonry/val-kit` linked to the workspace copy | What local verification runs; never pushed to Val Town |
| `src/runtime/check-result.ts` | `PerceptionCheckResult` + `CHECK_FINGERPRINT_NAMESPACE` (`perception-v1`) | The kit stores it opaquely; the namespace is what keeps the two Vals' caches disjoint |
| `src/jobs/perception-check.ts` | The ONE phase, its 45s budget, output sanitizers, and the visitor-facing failure copy | `failed` when nothing was measured; a planning failure reads as a fact about the brand |
| `src/app/`, `src/mcp/` | HTTP routes and response policy; the 5-tool MCP surface | Near-identical to the sibling Val — the next hoist into the kit |
| `src/ui/` | View model, server-rendered HTML, browser script, and the product's own CSS on top of the kit's | Verdict snapshot, answers table with per-row disclosure, concerns, source types |
| `README.md` / `AGENTS.md` | Public marketing copy; contributor rules, budget arithmetic, and release order | Read `AGENTS.md` before changing the Val host |

## Packages

### `packages/val-kit/` — Published host kit for the Vals (`@canonry/val-kit`)
The pure modules the Val Town Vals share, built with tsup to `dist/` and imported in production as
`npm:@canonry/val-kit@<version>/<subpath>` (Val Town applies no import map, so the version is pinned inline at every
import site). Published manually with `pnpm --filter @canonry/val-kit publish` (no workflow); a Val's production graph
cannot resolve until the version it pins exists on npm.

| Subpath | Role |
|---------|------|
| `.` | Everything in one import — prefer a subpath in a Val, so a file says which part of the seam it depends on |
| `visibility` | Answer-engine visibility: question planner, Gemini probe adapter, mention extraction, brand matching, share of voice |
| `perception` | Brand perception: branded query planner, verdict extraction with verbatim-evidence verification, source typing, aggregation |
| `security` | Public-surface guards: Turnstile verification and URL / SSRF checking |
| `storage` | Storage ports plus the in-memory and Val Town SQLite adapters behind them |
| `jobs` | The bounded public-check pipeline: phases, deadlines, cache reuse, and job records |
| `mcp` | MCP protocol, server, tools, resources, and the generated skill catalog |
| `ui` | Server-rendered evidence UI: markup, styles, and the client script (no inline styles — the page CSP blocks them) |
| `config` | Environment-driven limits and feature configuration |

### `packages/canonry/` — Publishable npm (`@canonry/canonry`, compat `@ainyc/canonry`)
CLI + Fastify server + job runner + scheduler + bundled SPA. The published product package (`packages/val-kit` is the
only other published artifact; every remaining internal package is bundled into this one).

| Path | Role |
|------|------|
| `src/server.ts` | 2969 LOC Fastify setup: mounts `api-routes`, serves SPA, registers providers, scheduler. Key seams: `basePath` (`CANONRY_BASE_PATH` → `config.basePath`), `assetsDir` override (default `assets/`), `resolveEmbedConfig` at boot, `sendSpaDocument` CSP `frame-ancestors`, `window.__CANONRY_CONFIG__` injection |
| `build-web.ts` | Builds `apps/web` then `cp apps/web/dist → assets/` (preserves `agent-workspace/`, verifies hashed refs) |
| `src/embed.ts` | `resolveEmbedConfig(env, config)` — env over `config.yaml` `embed:` (origins/views/projectTabs/theme), fail-closed `frame-ancestors 'none'` |
| `src/config.ts` | `CanonryConfig` + `.canonry/config.yaml` load/save, provider creds, Cloudflare per-source traffic credentials, `embed`, `agent.mode`, `basePath` |
| `src/google-marketing-runtime.ts` | Project-scoped Google Ads and GTM discovery and snapshot runtime. Provider calls are bounded and read-only. |
| `src/cloudflare-traffic-config.ts` / `src/cloudflare-ingest-url.ts` | Source-ID-keyed local Cloudflare credentials for direct push (bearer/HMAC) and Queue pull (Account Queues token); no cleartext secret enters generated artifacts |
| `src/execute-site-audit.ts` | `executeSiteAudit` — runs `@canonry/aeo-audit` `runSiteCrawl`, upserts the live attempt graph from events, then publishes immutable complete/selected-partial snapshots. It also materializes the deterministic Site Health 20k-node / 50k-edge graph sample. Default page budget 1,000; an unset edge budget stays unset so the engine derives it from the page count. Caps: 50,000 pages / 1,000,000 edges. Dead-link checks are opt-in. |
| `src/site-crawl-graph-layout.ts` | Publication-time Graphology/ForceAtlas2 worker: deterministic hierarchy seed → bounded layout → persisted coordinates/edge sample; timeout or failure records an unavailable layout without failing the crawl. |
| `src/job-runner.ts` | In-process queue: `answer-visibility`, `site-audit`, `discovery`, `research`, etc. |
| `src/provider-registry.ts` | Collects `ProviderAdapter` impls |
| `src/scheduler.ts` | Cron kinds: `answer-visibility`, `traffic-sync`, `gbp-sync`, `data-refresh`, `backlinks-sync`, `site-audit`, `ads-sync` |
| `src/agent/*` | Aero agent: `session.ts` (pi-agent-core), `session-registry.ts` (hybrid mem+DB), `tools.ts` (exposes MCP registry via `mcp-to-agent-tool.ts`), `memory-store.ts`, `compaction.ts` |
| `src/mcp/*` | `canonry-mcp` stdio adapter, `tool-registry.ts` (188 tools), `toolkits.ts`, `dynamic-catalog.ts`. Cloudflare connect is classified `deferred`: deployment consumes local secrets and must stay out of MCP/Aero transcripts. |
| `src/gsc-sitemap-submission.ts` | GSC sitemap helpers (`dedupeGscSitemapUrls`, `resolveDiscoveredGscSitemapUrls`, `submitGscSitemapBatches`) — dedupe + index expansion (4× parallel) + 50-url batched submit |
| `src/cli.ts` / `src/cli-commands.ts` / `src/commands/*` | CLI dispatch and command implementations. Cloudflare traffic connect writes secret-free direct-push or Queue-pull artifacts; auto-deploy requires explicit route acknowledgement and local credential ownership. |
| `src/client.ts` | `ApiClient` + `createApiClient()` |
| `assets/` | Bundled SPA output (do not edit by hand; `build-web.ts` regenerates) |
| `AGENTS.md` | Per-package agent rules (416 lines, key seam table) |

### `packages/api-routes/` — Shared Fastify route plugins (~180 ops, 83 files)

| Path | Role |
|------|------|
| `src/index.ts` | Plugin entry, `ApiRoutesOptions`, global error handler |
| `src/helpers.ts` | `resolveProject()`, `writeAuditLog()`, `notProbeRun()` — **every dashboard read MUST AND `notProbeRun()`** |
| `src/auth.ts` | API key + session, `hashApiKey`, `requireScope`, read-only gate (method-based), `requirePaidReadScope` for billed GETs |
| `src/projects.ts` | `PUT /projects/:name` upsert (largest route file) |
| `src/runs.ts` | Run CRUD + batch `POST /runs` |
| `src/queries.ts` / `src/query-replace.ts` | Query basket ops — `replaceProjectQueries` is only declarative replace (preserves FKs) |
| `src/technical-aeo.ts` | Exact-identity `POST /technical-aeo/runs`; legacy score/page/trend reads; bounded crawl summary, page inventory, hierarchy, links/neighbors, semantic subgraph/path, complete-run changes, opt-in dead-links, persisted `/technical-aeo/graph` visualization projection (with server-owned `rootNodeKey`), and `GET /technical-aeo/runs` scan history with per-scan `hasCrawlData`. Legacy score-only runs answer crawl-scoped reads with their no-crawl shape; only unknown run ids 404. All use `notProbeRun()`. |
| `src/composites.ts` / `src/db-derived-dtos.ts` | Composite reads, `drizzle-zod` row schemas |
| `src/analytics.ts` / `visibility-stats.ts` / `visibility-compare.ts` | Aggregated metrics, per-query rates, month compare |
| `src/google.ts` / `src/bing.ts` / `src/ga.ts` / `src/traffic.ts` / `src/backlinks.ts` / `src/ads.ts` | Integration routes |
| `src/doctor/*` | Health checks — `registry.ts`, `runner.ts`, `checks/*`. Cloudflare direct push skips pull lag. Both direct and Queue sources use `traffic.source.worker-version` to compare the generated version with the most recently ingested batch's Worker version. |
| `src/discovery/*` | Discovery orchestrator + routes |
| `src/measurement-*` | Advanced measurement plans, overview, property evidence |
| `src/visibility-attribution.ts` | Query attribution helpers (`buildQueryAttribution`, `resolveCurrentQuery`) — by-id then by-text fallback for historical snapshots |
| `AGENTS.md` | Route file map, `notProbeRun` contract, SDK layering |

### `packages/contracts/` — DTOs, enums, Zod schemas, error codes
Single source of truth for API ↔ web ↔ CLI types. Every new route adds a Zod schema here + `openapi.ts` registration + generated client.

### `packages/db/` — Drizzle ORM, SQLite/Postgres, migrations
Schema in `src/schema.ts`. ER diagram in `docs/data-model.md`.

### `packages/config/` — Typed env parsing

### `packages/intelligence/` — Insights + health snapshot logic

### Providers (`packages/provider-*`)
`provider-gemini`, `provider-openai`, `provider-claude`, `provider-local`, `provider-perplexity`, `provider-cdp` — each implements `ProviderAdapter` from `contracts`.

### Integrations (`packages/integration-*`)
`integration-google`, `integration-google-ads` (read-only Google Ads discovery and snapshots), `integration-google-analytics`, `integration-bing`, `integration-google-business-profile`, `integration-google-places`, `integration-google-tag-manager` (read-only GTM discovery and live-container snapshots), `integration-openai-ads`, `integration-wordpress`, `integration-commoncrawl`, `integration-cloud-run`, `integration-cloudflare-worker` (transport-neutral edge batch + ES-module direct-push / Queue-producer delivery), `integration-cloudflare-queue` (Queues HTTP pull/ack client), `integration-vercel`, `integration-traffic`, `integration-wordpress-traffic`.

### Other
`packages/api-client-generated/` — Hey API generated SDK (`src/generated/`), regenerated by `pnpm gen`.
`packages/wordpress-traffic-logger-plugin/` — PHP plugin for traffic logging.

## Navigation Recipes

| Goal | Start | Then |
|------|-------|------|
| Change first-run / onboarding | `apps/web/src/App.tsx` (redirect) → `apps/web/src/pages/SetupPage.tsx` → `apps/web/src/lib/onboarding-telemetry.ts` | Check `packages/canonry/src/execute-site-audit.ts` for probe semantics |
| Add a dashboard section | `apps/web/src/pages/ProjectPage.tsx` → `apps/web/src/components/project/` → `apps/web/src/queries/use-project-dashboard.ts` | New API data needs `packages/api-routes` + `packages/contracts` + regenerate `api-client-generated` |
| Add an API route | `packages/contracts/src/*.ts` (Zod) → `packages/api-routes/src/<domain>.ts` → `packages/api-routes/src/openapi.ts` → `pnpm gen` → `apps/web/src/api.ts` or `apps/web/src/queries/*` | Respect `notProbeRun()` + `requireScope`/`requirePaidReadScope` |
| Change SPA serving / embed | `packages/canonry/src/server.ts` (`sendSpaDocument`, `assetsDir`) + `packages/canonry/src/embed.ts` + `apps/web/src/embed.ts` | `CANONRY_EMBED` / `CANONRY_EMBED_ORIGINS` env, `window.__CANONRY_CONFIG__.embed` |
| Touch Site Health / Technical AEO | `packages/canonry/src/execute-site-audit.ts` → `site-crawl-graph-layout.ts` → `packages/api-routes/src/technical-aeo.ts` → `packages/contracts/src/technical-aeo.ts` → regenerate `api-client-generated` → `packages/canonry/src/mcp/tool-registry.ts` → `apps/web/src/components/project/SiteHealthSection.tsx` | Keep `technical-aeo` as the stable route/API/embed key; label it **Site Health**. Every operator-visible graph state must have a shared API/MCP semantic field or task-shaped read. Sigma receives persisted positions; agents receive bounded subgraphs, paths, and run diffs rather than the visualization payload. |
| Touch Aero agent | `packages/canonry/src/agent/session.ts` → `session-registry.ts` → `tools.ts` → `apps/web/src/components/shared/AeroBar.tsx` | `agent.mode: 'disabled'` / `CANONRY_AGENT_DISABLED` kill-switch |
| Debug auth / keys | `packages/api-routes/src/auth.ts` → `packages/api-routes/src/keys.ts` → `packages/canonry/src/commands/keys.ts` | `isReadOnlyKey` in `contracts`, single-tenant posture in `AGENTS.md` |
| Inspect Google marketing conversion integrity | `docs/google-marketing.md` → `skills/canonry/references/google-marketing.md` → `packages/canonry/src/google-marketing-runtime.ts` | Stored snapshots are default. A bounded provider read needs `google-marketing.read-live`. |
| Set up Cloudflare traffic | `packages/canonry/src/cli-commands/traffic.ts` → `src/commands/traffic.ts` → `src/cloudflare-traffic-config.ts` | Preflight the exact zone route; for direct push keep the ingest host outside it, for Queue pull enable the separate HTTP consumer; use local CLI deployment and do not add an MCP tool |

## Agent Efficiency Tips

- Prefer `muse.search` (ripgrep, bounded) over `muse.bash` for code search — bash fan-out spawns saturate the host.
- `muse.read_file` caps at 500 lines — read `SetupPage.tsx`/`ProjectPage.tsx`/`server.ts` in windows, not whole file.
- `pnpm run typecheck` / `pnpm run test` / `pnpm run lint` must pass before PR — see `CONTRIBUTING.md`.
- `pnpm gen` regenerates SDK after contract/route changes.
- `pnpm plugin:sync` / `pnpm plugin:check` for skill drift.
- Regenerate file list: `find apps packages -type f -name '*.ts' -o -name '*.tsx' | sort` then update this file; run `pnpm plugin:sync` after touching `skills/` or `plugins/canonry/`.
