# CODEMAP — File-Level Index for Agents

> This index lists key source paths. Per-package `AGENTS.md` files define the rules. Refresh the tracked source list with `git ls-files -- 'apps/**/*.ts' 'apps/**/*.tsx' 'packages/**/*.ts' 'packages/**/*.tsx'`.

Start with `AGENTS.md` (project overview + deployment posture), then `docs/README.md` (doc map), then the per-package `AGENTS.md` nearest your task. Never read `AGENTS.md` in one giant chunk — read the section you need.

## Root

| Path | Role |
|------|------|
| `AGENTS.md` | Repo-wide agent rules and the map of where every other rule lives (`**/AGENTS.md`, nearest folder wins) |
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
| `src/App.tsx` | Root layout, setup shell, health, notifications, and Aero bar | |
| `src/router/routes.tsx` | TanStack Router tree and first-run redirect | The index route redirects to `/setup` after a successful, empty project list. Overview, Projects, and Onboarding use eager imports. |
| `src/pages/OnboardingSetupPage.tsx` / `src/pages/ProjectSetupTracker.tsx` | `/setup` website form and project setup tracker | Track states come from `GET /projects/{name}/setup`. The AI Visibility panel is `src/components/setup/AiVisibilitySetupPanel.tsx`. |
| `src/pages/SetupPage.tsx` | Legacy wizard (`?experience=legacy`): `System check → Create project → Queries → Competitors → Launch`, and a project's Set up AI Visibility page | `deriveSetupStep` resolves the wizard state. `src/queries/use-dashboard-overview.ts` supplies resume data. The wizard and the tracker share `src/components/setup/`. |
| `src/pages/ProjectPage.tsx` | Project shell + tab router (`overview`, `portfolio`, `search-console`, `seo-data`, `journeys`, `conversions`, `local`, `queries`, `client-queries`, `discovery`, `activity`, `traffic`, `backlinks`, `agent-readiness`, `history`, `settings`); the `agent-readiness` tab is labeled **Agent Readiness**, and the deprecated `/technical-aeo` route redirects to it | Extract before adding hooks |
| `src/pages/OverviewPage.tsx` | Portfolio overview (project list, sparkline, health cards) | "What changed" is built in `build-dashboard.ts` with contracts `portfolioWhatChangedItems`, the roll-up `canonry overview --all` prints: each project's rows from its server `whatChanged` lost counts, its runs in progress from the polled run list, then the couldn't-load, all-clear or awaiting row. The lost counts come only from the server; the page loads no answer evidence |
| `src/pages/ProjectsPage.tsx` / `src/pages/HistoryPage.tsx` / `src/pages/RunsPage.tsx` / `src/pages/SettingsPage.tsx` / `src/pages/BacklinksPage.tsx` / `src/pages/TrafficPage.tsx` | Top-level page components | |
| `src/components/project/*` | Section components including `GscSection`, `SiteHealthSection`, `SiteGraphSigma`, `TechnicalAeoSection`, `DiscoverySection`, `CitationVisibilitySection`, `VisibilityTrendSection`, `ActivitySection`, `BacklinksSection`, and `GbpSection` | The Agent Readiness map uses Sigma and Graphology to draw the server's published coordinates. |
| `src/components/project/advanced-measurement/*` | Advanced Measurement UI (`AdvancedMeasurementSection`, `AdvancedMeasurementSetupWizard`, adapters) | |
| `src/components/shared/*` | `ChartPrimitives` (Recharts wrapper), `AeroBar`, `BrandLockup`, `ToneBadge`, `ProviderBadge`, `StatusBadge` | |
| `src/components/ui/*` | `button`, `card`, `badge`, `sheet` (Radix + Tailwind) | |
| `src/components/layout/*` | `Drawer`, `ErrorBoundary`, `TaskCenter`, `Toaster` | |
| `src/api.ts` | `heyClient`, `apiFetch<T>`, typed wrappers over `@canonry/canonry-api-client` | Use the generated SDK for API calls. The raw `fetch()` exceptions are this file and `src/api-aero.ts`. |
| `src/api-aero.ts` | Aero client for streamed turns and supporting requests | |
| `src/embed.ts` | Presentational embed helpers: `embedViewIdForPath`, `isEmbedProjectTabAllowed`, `embedThemeStyle` | Pure, testable |
| `src/lib/*` | `health-helpers`, `onboarding-telemetry`, `format-helpers`, `run-tracker-store`, `tone-helpers`, `write-guard`, `base-path`, `safe-url`, `measurement-view-url` (shared measurement URL selection and the first-page visibility-report query key), `project-scope` (which scope control the project context row shows on each tab), etc. | `VisibilityTrendSection` exports `VisibilityOverview` (results toolbar above the keyed workspace) and `useVisibilityReportFirstPage`. |
| `src/queries/*` | TanStack Query hooks (`use-dashboard-overview`, `use-project-dashboard`, `use-health`, `mutations`, `server-traffic`) | |
| `src/contexts/*` | `dashboard-context`, `account-context` | |
| `src/mappers/insight-mapper.ts` | Insight DTO → view-model | |
| `src/styles.css` | Tailwind v4 entry, semantic tokens (`--color-bg`, `--surface`, `--text-*`, tone scales) | |
| `src/mock-data.ts` | Static demo data — not for example-workspace adapter | |
| `vite.config.ts` | `base: './'`, proxy `/api/v1` → `CANONRY_API_URL` (default 4100), `manualChunks` for recharts/tanstack/markdown | |
| `AGENTS.md` | Per-app agent rules, API call patterns | |

### `apps/api/` — Cloud Run entry (imports `packages/api-routes`)

`src/app.ts` mounts the shared REST routes. `src/index.ts` starts the server.

### `apps/mcp-gateway/` — Remote read-only MCP gateway

`src/index.ts` starts the gateway. `src/server.ts` wires OAuth and routes each
authorized connection to its registered Canonry instance. See the
[gateway guide](../apps/mcp-gateway/README.md).

## Packages

### `packages/canonry/` — Publishable npm (`@canonry/canonry`)
CLI + Fastify server + job runner + scheduler + bundled SPA. The only published package; every internal package is
bundled into this one.

| Path | Role |
|------|------|
| `src/server.ts` | Mounts `api-routes`, serves the SPA, and registers providers and the scheduler. Resolves `basePath`, the `assetsDir` override, and embed configuration. `sendSpaDocument` sets CSP `frame-ancestors` and injects `window.__CANONRY_CONFIG__`. |
| `build-web.ts` | Builds `apps/web` then `cp apps/web/dist → assets/` (preserves `agent-workspace/`, verifies hashed refs) |
| `src/embed.ts` | `resolveEmbedConfig(env, config)` — env over `config.yaml` `embed:` (origins/views/projectTabs/theme), fail-closed `frame-ancestors 'none'` |
| `src/config.ts` | `CanonryConfig` + `.canonry/config.yaml` load/save, provider creds, Cloudflare per-source traffic credentials, `embed`, `agent.mode`, `basePath` |
| `src/google-marketing-runtime.ts` | Project-scoped Google Ads and GTM discovery and snapshot runtime. Provider calls are bounded and read-only. |
| `src/cloudflare-traffic-config.ts` / `src/cloudflare-ingest-url.ts` | Source-ID-keyed local Cloudflare credentials for direct push (bearer/HMAC) and Queue pull (Account Queues token); no cleartext secret enters generated artifacts |
| `src/execute-site-audit.ts` | `executeSiteAudit` — runs `@canonry/agent-readiness` `runSiteCrawl`, upserts the live attempt graph from events, then publishes immutable complete/selected-partial snapshots. It also materializes the deterministic Agent Readiness 20k-node / 50k-edge graph sample. Page budget: the run creator's resolved one (request, else the project's saved `siteAuditMaxPages`, else the full site up to 50,000); an unset edge budget stays unset so the engine derives it from the page count. Caps: 50,000 pages / 1,000,000 edges. Dead-link checks are opt-in. |
| `src/site-audit-factors.ts` | `computeFactorAverages`: the site factor scorecard the executor publishes and the demo seed reuses. Each factor's site `sharePct` is the mean of the engine's per-page shares, apportioned to add up to 100; a factor's `weight` is relative and never a percentage. |
| `src/site-crawl-graph-layout.ts` | Publication-time Graphology/ForceAtlas2 worker: deterministic hierarchy seed → bounded layout → persisted coordinates/edge sample; timeout or failure records an unavailable layout without failing the crawl. |
| `src/job-runner.ts` | In-process sweep execution, site audit recovery, batch ingestion, and run finalization. `src/server.ts` dispatches discovery and research through separate handlers. |
| `src/provider-registry.ts` | Collects `ProviderAdapter` impls |
| `src/provider-batch-config.ts` | Batch dispatch config (`docs/batch-mode.md`): validates `providers.<name>.batch` / `.pricing`, builds each registered `ProviderConfig`, `batchEligibleProviderNames` (adapter capability AND `batch.enabled`) |
| `src/provider-batch-poller.ts` | In-process loop that owns submitted provider batches: per-batch poll backoff (30s doubling to 10 min), deadline cancel + 1 h grace, hands ended batches to `JobRunner.ingestProviderBatch` and runs to `JobRunner.finalizeBatchRun`; started/stopped by `server.ts` |
| `src/scheduler.ts` | Scheduled runs. `packages/contracts/src/schedule.ts` defines supported kinds in `schedulableRunKindSchema`. |
| `src/agent/*` | Aero agent: `session.ts` (pi-agent-core), `session-registry.ts` (hybrid mem+DB), `runtime.ts` (progressive tools / limits), `view-context.ts` (selected evidence), `tools.ts` (MCP adapter catalog), `memory-store.ts`, `compaction.ts` |
| `src/mcp/*` | Shared MCP tools and stdio adapter. Read `tool-registry.ts`, `toolkits.ts`, and `dynamic-catalog.ts`. The HTTP transport lives in `src/mcp-http.ts`. |
| `src/gsc-sitemap-submission.ts` | GSC sitemap helpers (`dedupeGscSitemapUrls`, `resolveDiscoveredGscSitemapUrls`, `submitGscSitemapBatches`) — dedupe + index expansion (4× parallel) + 50-url batched submit |
| `src/cli.ts` / `src/cli-commands.ts` / `src/commands/*` | CLI dispatch and command implementations. Cloudflare traffic connect writes secret-free direct-push or Queue-pull artifacts; auto-deploy requires explicit route acknowledgement and local credential ownership. |
| `src/client.ts` | `ApiClient` + `createApiClient()` |
| `assets/` | Bundled SPA output (do not edit by hand; `build-web.ts` regenerates) |
| `AGENTS.md` | Per-package agent rules and key files |

### `packages/api-routes/` — Shared Fastify route plugins

| Path | Role |
|------|------|
| `src/index.ts` | Plugin entry, `ApiRoutesOptions`, global error handler |
| `src/helpers.ts` | `resolveProject()`, `writeAuditLog()`, and `notProbeRun()`. Apply `notProbeRun()` to aggregate reads. Operator run lists and explicit run detail include probes. |
| `src/auth.ts` | API key + session, `hashApiKey`, `requireScope`, read-only gate (method-based), `requirePaidReadScope` for billed GETs |
| `src/projects.ts` | `PUT /projects/:name` upsert |
| `src/runs.ts` | Run creation, lists, preview, admission, cancellation, fill, completeness, and detail. Run detail includes `providerBatches` and `usage`. |
| `src/run-queue.ts` | `queueRunIfProjectIdle`: stamps the plan manifest and freezes `runs.provider_dispatch_modes` (rules: `resolveRunDispatchModes` in contracts) |
| `src/provider-batches.ts` | Reads over `provider_batches` (run detail, fill age, scheduler `batch-pending`) |
| `src/snapshot-evidence-fingerprint.ts` | The evidence fingerprint measurement cursors pin (excludes dispatch provenance columns) |
| `src/queries.ts` / `src/query-replace.ts` | Query basket ops — `replaceProjectQueries` is only declarative replace (preserves FKs) |
| `src/query-class-read.ts` | `readQueryClasses`: the branded / non-brand `queryClass` on every `/queries` row (text classifier for a simple project or a schema v1 plan, stored assignment class under an active schema v2 plan) |
| `src/technical-aeo.ts` | Agent Readiness routes, served at `/agent-readiness/…` with deprecated `/technical-aeo/…` twins: exact-identity `POST /agent-readiness/runs`; legacy score/page/trend reads; bounded crawl summary, page inventory, hierarchy, links/neighbors, semantic subgraph/path, complete-run changes, opt-in dead-links, persisted `/agent-readiness/graph` visualization projection (with server-owned `rootNodeKey`), and `GET /agent-readiness/runs` scan history with per-scan `hasCrawlData`. Legacy score-only runs answer crawl-scoped reads with their no-crawl shape; only unknown run ids 404. All use `notProbeRun()`. |
| `src/composites.ts` | Composite reads (`/overview`, `/search`) |
| `src/overview-what-changed.ts` | `/overview.whatChanged`: lost mentions and lost citations in the latest check, one per query, and runs in progress (Simple and Advanced rules) |
| `src/analytics.ts` / `visibility-stats.ts` / `visibility-compare.ts` | Aggregated metrics, per-query rates, month compare |
| `src/google.ts` / `src/bing.ts` / `src/bing-data.ts` / `src/ga.ts` / `src/traffic.ts` / `src/backlinks.ts` / `src/ads.ts` | Integration routes (`bing-data.ts`: Bing sync trigger, stored Bing reads, live Bing drill-downs) |
| `src/doctor/*` | Health checks — `registry.ts`, `runner.ts`, `checks/*`. Cloudflare direct push skips pull lag. Both direct and Queue sources use `traffic.source.worker-version` to compare the generated version with the most recently ingested batch's Worker version. |
| `src/discovery/*` | Discovery orchestrator + routes |
| `src/measurement-*` | Advanced measurement plans, overview, property evidence |
| `src/measurement-scope-options.ts` | `planScopeOptions`: the single server scope-option builder (visibility report with `marketLinks: true`, query-tracking workspace with `marketLinks: false`); `simpleScopeOptions` for Simple projects |
| `src/visibility-attribution.ts` | Query attribution helpers (`buildQueryAttribution`, `resolveCurrentQuery`) — by-id then by-text fallback for historical snapshots |
| `AGENTS.md` | Route file map, `notProbeRun` contract, SDK layering |

### `packages/contracts/` — DTOs, enums, Zod schemas, error codes
Single source of truth for API ↔ web ↔ CLI types. Every new route adds a Zod schema here + `openapi.ts` registration + generated client.
Batch dispatch: `src/provider-batch.ts` (dispatch mode, batch status, usage, price schemas, adapter capability), `src/run-dispatch.ts` (`resolveRunDispatchModes`, ineligibility reasons, ledger outcomes, `summarizeRunUsage`), and `src/sweep-pricing.ts` (built-in `DEFAULT_MODEL_PRICES`, `resolveModelPrice`, `estimateAnswerCostMicros`, `buildSnapshotUsage`, `usageCount`: per-answer cost estimates; update a model price here).

### `packages/db/` — Drizzle ORM, SQLite client, migrations
Schema in `src/schema.ts`. ER diagram in `docs/data-model.md`.

### `packages/config/` — Typed env parsing

### `packages/intelligence/` — Insights + health snapshot logic

### Providers (`packages/provider-*`)
Provider packages implement `ProviderAdapter` from `packages/contracts/src/provider.ts`. See the [provider guide](providers/README.md) for adapters and their supported request modes.

- `packages/provider-openrouter/src/adapter.ts` resolves model routes through a shared connection.
- `packages/provider-claude/src/batch.ts` implements the Message Batches capability (`adapter.batch`).
- `packages/provider-answer-services/src/core/` contains the adapter factory, HTTP and SSE readers, and evidence assembly. `packages/provider-answer-services/src/services/index.ts` registers vendors.

### Integrations (`packages/integration-*`)
`integration-google`, `integration-google-ads` (read-only Google Ads discovery and snapshots), `integration-google-analytics`, `integration-bing`, `integration-google-business-profile`, `integration-google-places`, `integration-google-tag-manager` (read-only GTM discovery and live-container snapshots), `integration-openai-ads`, `integration-dataforseo`, `integration-typesafe`, `integration-wordpress`, `integration-commoncrawl`, `integration-cloud-run`, `integration-cloudflare-worker` (transport-neutral edge batch + ES-module direct-push / Queue-producer delivery), `integration-cloudflare-queue` (Queues HTTP pull/ack client), `integration-vercel`, `integration-traffic`, `integration-wordpress-traffic`.

### Other
`packages/api-client-generated/` — Hey API generated SDK (`src/generated/`), regenerated by `pnpm gen`.
`packages/wordpress-traffic-logger-plugin/` — PHP plugin for traffic logging.

## Navigation Recipes

| Goal | Start | Then |
|------|-------|------|
| Change first-run / onboarding | `apps/web/src/router/routes.tsx` (redirect) → `apps/web/src/pages/OnboardingSetupPage.tsx` → `apps/web/src/pages/ProjectSetupTracker.tsx` → `apps/web/src/components/setup/` | `packages/api-routes/src/project-setup.ts` defines track states. `apps/web/src/lib/onboarding-telemetry.ts` and `apps/web/src/hooks/use-onboarding-telemetry.ts` handle onboarding events. |
| Add a dashboard section | `apps/web/src/pages/ProjectPage.tsx` → `apps/web/src/components/project/` → `apps/web/src/queries/use-project-dashboard.ts` | New API data needs `packages/api-routes` + `packages/contracts` + regenerate `api-client-generated` |
| Add an API route | `packages/contracts/src/*.ts` (Zod) → `packages/api-routes/src/<domain>.ts` → `packages/api-routes/src/openapi.ts` → `pnpm gen` → `apps/web/src/api.ts` or `apps/web/src/queries/*` | Respect `notProbeRun()` + `requireScope`/`requirePaidReadScope` |
| Add a CLI command | `packages/canonry/src/cli-commands/<cmd>.ts` → `packages/canonry/src/mcp/tool-registry.ts` (tier) + `openapi-classification.ts` → test | Every command supports `--format json`; add the MCP tool or classify the operation (root `AGENTS.md` → "Agent & automation design principles") |
| Change SPA serving / embed | `packages/canonry/src/server.ts` (`sendSpaDocument`, `assetsDir`) + `packages/canonry/src/embed.ts` + `apps/web/src/embed.ts` | `CANONRY_EMBED` / `CANONRY_EMBED_ORIGINS` env, `window.__CANONRY_CONFIG__.embed` |
| Touch Agent Readiness | `packages/canonry/src/execute-site-audit.ts` → `site-crawl-graph-layout.ts` → `packages/api-routes/src/technical-aeo.ts` → `packages/contracts/src/technical-aeo.ts` → regenerate `api-client-generated` → `packages/canonry/src/mcp/tool-registry.ts` → `apps/web/src/components/project/SiteHealthSection.tsx` | `agent-readiness` is the canonical route, API, embed, CLI, and MCP name, labeled **Agent Readiness**; keep the deprecated `technical-aeo` / `site-health` names working as aliases. Every operator-visible graph state must have a shared API/MCP semantic field or task-shaped read. Sigma receives persisted positions; agents receive bounded subgraphs, paths, and run diffs rather than the visualization payload. |
| Touch batch dispatch | `docs/batch-mode.md` → `packages/contracts/src/run-dispatch.ts` → `packages/contracts/src/sweep-pricing.ts` (prices, cost estimates) → `packages/api-routes/src/run-queue.ts` (freezing) → `packages/canonry/src/provider-batch-config.ts` (config) → `packages/canonry/src/job-runner.ts` (submission, ingest, DB-derived finalize, cancel, boot recovery) → `packages/canonry/src/provider-batch-poller.ts` (polling, deadlines) | Eligibility lives only in `resolveRunDispatchModes`; planless runs never batch; dispatch mode stays out of the execution identity; a batch run finalizes only through `finalizeBatchRun` (`packages/canonry/AGENTS.md` → "Run completion pipeline") |
| Touch Aero agent | `packages/canonry/src/agent/session.ts` → `packages/canonry/src/agent/session-registry.ts` → `packages/canonry/src/agent/tools.ts` → `apps/web/src/components/shared/AeroBar.tsx` | `packages/canonry/src/agent-config.ts` resolves disabled and prompt-only modes. The session registry resolves provider and model overrides. `packages/canonry/src/agent/agent-routes.ts` enforces administrator access and serves isolated viewer sessions when `agent.allowViewers` is enabled. |
| Debug auth / keys | `packages/api-routes/src/auth.ts` → `packages/api-routes/src/keys.ts` → `packages/canonry/src/commands/keys.ts` | `isReadOnlyKey` in `contracts`, single-tenant posture in `AGENTS.md` |
| Inspect Google marketing conversion integrity | `docs/google-marketing.md` → `skills/canonry/references/google-marketing.md` → `packages/api-routes/src/google-marketing.ts` → `packages/canonry/src/google-marketing-runtime.ts` | Stored snapshots are the default. Live discovery requires `google-marketing.read-live` and instance-wide access. Signed-in users need the administrator role. |
| Set up Cloudflare traffic | `packages/canonry/src/cli-commands/traffic.ts` → `packages/canonry/src/commands/traffic.ts` → `packages/canonry/src/cloudflare-traffic-config.ts` | Check the exact zone route. For direct push, keep the ingest host outside the route. For Queue pull, enable the HTTP pull consumer. The CLI can deploy the Worker. Attach the route separately. |

## Agent Efficiency Tips

- Use `rg --files` to locate files and `rg -n` to locate symbols. Read the relevant lines of large files.
- Follow the validation requirements in `CONTRIBUTING.md` before you open a PR.
- `pnpm gen` regenerates SDK after contract/route changes.
- `pnpm plugin:sync` / `pnpm plugin:check` for skill drift.
- To list new source files before Git tracks them, use `find apps packages -type f -name '*.ts' -o -type f -name '*.tsx'`.
