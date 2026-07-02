# AGENTS.md

## Project Overview

`canonry` is an **agent-first** open-source AEO operating platform that tracks how AI answer engines cite a domain for tracked queries and acts on the signal through the content engine and integrations. Published as `@canonry/canonry` on npm, with `@ainyc/canonry` kept as a compatibility package at the same versions. The CLI and API are the primary interfaces — the web dashboard is supplementary.

## Deployment Posture (Critical)

**Both `canonry serve` (local) and `apps/api` (Cloud Run) are single-tenant deployments.** They are designed to run with exactly one trust boundary per instance — one operator's projects on one local machine, OR one team's projects on one Cloud Run service. They are NOT designed to multiplex multiple unrelated tenants behind a single instance.

### What this means in practice

- The `api_keys` table has no `owner_id` / `tenant_id` / `account_id` column. Every domain table (`projects`, `queries`, `runs`, `notifications`, `schedules`, `google_connections`, `bing_connections`, `ga_connections`, `traffic_sources`, `agent_sessions`, `agent_memory`, `discovery_sessions`, `audit_log`) is scoped to the project, not to a caller. `resolveProject(app.db, name)` is a global `SELECT … WHERE name = ?` with no caller filter, so a full-instance `cnry_…` bearer can read or write any project on the instance. The one exception is a **project-scoped key**: `api_keys.project_id` (nullable, opt-in via `canonry key create --project <name>` or `POST /keys {projectId}`) binds a key to a single project. Enforcement: the `authPlugin` gate 403s any other `/projects/<name>` route; `assertProjectScope` covers the id-addressed routes (`/runs/:id`, `/screenshots/:id`); the global aggregation reads (`GET /projects`, `GET /runs`, `GET /history`) are filtered to the one project; the global writes `POST /runs` (batch) and `POST /apply` are restricted to it; and `POST /keys` cannot mint a broader (unscoped or sibling) key. A NULL `project_id` (every historical key) keeps full-instance access. It is a project boundary, not a multi-tenant `owner_id` boundary — shared `google_connections` and the instance-level `/settings/*` config (provider keys) are unchanged, so a scoped key with write scopes can still touch instance-global settings; the embed read-only key cannot.
- `google_connections` and `bing_connections` are uniquely keyed on `(domain, connectionType)`, not on `(project_id, connectionType)`. Two projects on the same instance that track the same `canonicalDomain` share an OAuth connection by design — operators sharing infra get this for free, malicious tenants do not.
- `GET /api/v1/projects` returns every project on the instance.
- `PUT /api/v1/settings/providers/:name` and the other `/settings/*` routes rewrite the instance's global provider keys + OAuth client credentials. Default API keys have `scopes: ['*']` and there is no `admin` scope yet.

### Operational guidance

- **Do not deploy `apps/api` as a multi-tenant SaaS.** One Cloud Run service per team. If you need to host multiple teams, deploy multiple isolated Cloud Run services with separate databases and OAuth clients.
- **Do not hand out `cnry_…` API keys outside the trust boundary you'd give a teammate.** A leaked key reads and writes every project on the instance.
- **API key management (`canonry key create` / `list` / `revoke`, `POST /keys`, `POST /keys/:id/revoke`) is gated by the `keys.write` scope.** The default `*` key written by `canonry init` satisfies it; narrower delegate keys must declare `keys.write` explicitly. Listing keys is ungated but returns SAFE metadata only (id, name, prefix, scopes, timestamps) — never the stored hash or the plaintext token. The raw `cnry_…` token is returned exactly once, at creation. Revoke sets `revokedAt` (it does not delete the row) and takes effect on the next request; you cannot revoke the key you are currently authenticating with. `GET /keys/self` (CLI `canonry key whoami`) returns the SAFE metadata of the key the request authenticated with, including the derived `readOnly` flag.
- **Read-only keys (`canonry key create --read-only`, scopes `['read']`).** A key is read-only when it carries the `read` scope and no write-granting scope (`*`, `write`, `*.write`) — see `isReadOnlyKey` in `@ainyc/canonry-contracts`. The auth plugin's global `onRequest` gate denies every mutating HTTP method (POST/PUT/PATCH/DELETE) for a read-only key with `403 FORBIDDEN`; GET/HEAD/OPTIONS pass. The gate keys off the HTTP method, NOT per-route `requireScope` calls, so a newly added write route is read-only-protected automatically. POST-based preview/dry-run routes (e.g. `POST .../queries/replace-preview`) are unavailable to read-only keys by design — use a full key. Read-only is purely additive: any key without the `read` token (including the default `['*']`) is unaffected. One benign exception: `GET .../bing/coverage` upserts a derived daily snapshot under a read method (idempotent, no user-meaningful state) — left allowed. `canonry-mcp` probes `GET /keys/self` at startup and auto-restricts the catalog to read tools when its configured key is read-only. A session backed by a read-only key would make the whole dashboard read-only (not a concern today — sessions map to the `['*']` key).
- **If a multi-tenant story becomes a requirement,** the work is substantial — add `owner_id` to every domain table, attach `apiKey.ownerId` to `request` in `authPlugin`, AND-in `eq(table.ownerId, request.apiKey.ownerId)` on every read/write, rekey `google_connections` / `bing_connections` to include `project_id`, and gate `/settings/*` on a real `admin` scope. The trade-off is real — a schema migration that touches ~15 tables and every route file. Plan accordingly.

## Workspace Map

```text
apps/api/                        Cloud API entry point (imports packages/api-routes)
apps/worker/                     Cloud worker entry point
apps/web/                        Vite SPA source (bundled into packages/canonry/assets/)
packages/canonry/                Publishable npm package (CLI + server + bundled SPA)
packages/api-routes/             Shared Fastify route plugins
packages/contracts/              DTOs, enums, config-schema, error codes
packages/config/                 Typed environment parsing
packages/db/                     Drizzle ORM schema, migrations, client (SQLite/Postgres)
packages/provider-gemini/        Gemini adapter
packages/provider-openai/        OpenAI adapter
packages/provider-claude/        Claude/Anthropic adapter
packages/provider-local/         Local LLM adapter (OpenAI-compatible API)
packages/provider-perplexity/    Perplexity adapter
packages/provider-cdp/           Chrome DevTools Protocol adapter
packages/integration-google/     Google Search Console integration
packages/integration-google-analytics/  Google Analytics 4 integration
packages/integration-bing/       Bing Webmaster Tools integration
packages/integration-openai-ads/  OpenAI Advertiser API (ChatGPT ads) integration
packages/integration-wordpress/  WordPress integration
docs/                            Architecture, roadmap, testing, ADRs
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

# CLI
canonry init
canonry serve
canonry serve --embed --embed-allow-origin https://app.example.com [--embed-allow-origin ...] [--embed-view overview] [--embed-project-tab overview --embed-project-tab technical-aeo]  # opt-in read-only embed mode (#716): chromeless render + Content-Security-Policy: frame-ancestors. Off by default; serve is byte-for-byte unchanged without --embed. Fails CLOSED to frame-ancestors 'none' when no (valid) origins are configured. --embed-project-tab is an allowlist of PROJECT-PAGE tabs (overview/technical-aeo/search-console/activity/backlinks/...) the embedded project dashboard may show; finer than --embed-view (which only gates whole top-level routes). Env equivalents: CANONRY_EMBED=1, CANONRY_EMBED_ORIGINS=a,b (comma/space), CANONRY_EMBED_VIEWS=overview,project, CANONRY_EMBED_PROJECT_TABS=overview,technical-aeo (env overrides config.yaml `embed:`). Cross-origin embeds cannot use the SameSite=Lax session cookie (it is not sent in a cross-site iframe) — v1 supports a same-origin embed (cookie flows) OR a self-hosted build with a read-only VITE_API_KEY (client-visible). Not an /api/v1 op, so no MCP tool (same precedent as --base-path).
canonry start --embed --embed-allow-origin https://app.example.com   # daemon form; forwards the embed flags to the spawned serve
canonry project create <name> --domain <domain> --country US --language en
canonry query add <project> <query>...
canonry query replace <project> <query>...
canonry competitor add <project> <domain>...
canonry competitor remove <project> <domain>...
canonry run <project>
canonry run <project> --provider gemini          # single-provider run
canonry run <project> --probe --provider openai --query "..."  # operator/agent test run — writes a snapshot for inspection but is EXCLUDED from dashboard, analytics, intelligence, and notifications
canonry status <project>
canonry visibility-stats <project>                                    # per-query mention/citation rates with sample size, pooled across runs
canonry visibility-stats <project> --last-runs 10 --by-provider       # last N runs, per-provider breakdown (counts sum to pooled)
canonry visibility-stats <project> --since 2026-06-01 --until 2026-06-30 --format jsonl  # date window; one record per query
canonry visibility-stats <project> --month 2026-06 --share-of-voice   # a whole calendar month + pooled share of voice vs tracked competitors (project brand mentions / (project + competitor))
canonry apply <file...>                          # multi-doc YAML + multiple files
canonry export <project>
canonry report <project>                         # client-facing AEO report → canonry-report-<project>-YYYY-MM-DD.html
canonry report <project> --period 7              # window (7|14|30|90, default 30): scopes GSC/GA/server-activity + the period-over-period deltas
canonry report <project> --output dist/aeo.html
canonry report <project> --format json           # raw report payload to stdout

# Schedules — one row per (project, kind) where kind ∈ {answer-visibility, traffic-sync, gbp-sync, data-refresh, backlinks-sync, site-audit}
canonry schedule set <project> --preset daily                                                # answer-visibility (default kind)
canonry schedule set <project> --kind traffic-sync --cron "*/15 * * * *" --source <id>       # traffic-sync (sourceId required)
canonry schedule set <project> --kind gbp-sync --preset daily                                # gbp-sync (no source; syncs selected locations)
canonry schedule set <project> --kind data-refresh --preset daily                            # data-refresh (refreshes connected GSC/Bing/GA/GBP; no source)
canonry schedule set <project> --kind backlinks-sync --preset weekly                         # backlinks-sync (re-probe Common Crawl + pull Bing inbound links for connected projects; sync CC only when a newer rolling window is published; no source/providers)
canonry schedule set <project> --kind site-audit --preset weekly                             # site-audit / Technical AEO (crawl the sitemap + audit every page; no source/providers)
canonry schedule show <project> [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync|site-audit] # default kind is answer-visibility
canonry schedule enable  <project> [--kind ...]
canonry schedule disable <project> [--kind ...]
canonry schedule remove  <project> [--kind ...]                                              # delete the schedule for that kind

# Agent layer
canonry agent ask <project> "<prompt>"               # one-shot turn against built-in Aero
canonry agent ask <project> "<prompt>" --provider zai --format json
canonry agent attach <project> --url <webhook-url>   # subscribe an external agent to run/insight events
canonry agent detach <project>                       # remove the agent webhook
canonry agent memory list <project>                  # list Aero's durable project-scoped notes
canonry agent memory set <project> --key <k> --value <v>    # upsert a note (2 KB max)
canonry agent memory forget <project> --key <k>      # delete a note

# Doctor — health checks (extensible registry: google.auth.*, ga.auth.*, config.providers, …)
canonry doctor                                                # global checks (provider keys, etc.)
canonry doctor --project <name>                               # project-scoped checks (Google/GA auth, redirect URI, scopes)
canonry doctor --project <name> --check google.auth.* --format json   # filter by id/wildcard, JSON output

# Discovery — expand a tracked-query basket from an ICP description
canonry discover run <project> --icp "..." [--buyer "..."] [--seed-provider gemini --seed-provider openai] [--wait] [--format json]
canonry discover run <project> --dedup-threshold 0.95 --max-probes 100 --wait     # tune dedup / per-session probe budget (cap 500)
canonry discover run <project> --probe-concurrency 3 --wait                       # parallel probe workers (default 1 = serial, cap 8); probe rows persist in canonical order regardless
canonry discover run <project> --icp-angle "angle 1" --icp-angle "angle 2" --wait  # multi-angle: one session per ICP angle, aggregates coverage across niches
canonry discover run <project> --locations michigan,florida --wait                # geo-constrain seed generation to a subset of project locations (omit = use all; projects with no locations are unaffected)
canonry discover list <project> [--limit 20] [--format json]
canonry discover show <project> <session-id> [--format json]
canonry discover probe <project> <session-id> [--format json]                       # alias of show (read-only) until a later PR splits phases
canonry discover harvest <project> <session-id> [--min-probe-hits <n>] [--no-anchor] [--format json|jsonl]   # read the answer engine's issued search-query fan-out (Gemini groundingMetadata.webSearchQueries) back out of the session's stored probes, gate it (drop navigational / over-specific / off-subject / exact-tracked / embedding-cosine synonym dups), and return survivors as candidate seeds ranked by probe recurrence — read-only, nothing is probed/tracked/promoted (issue #713)
canonry discover promote preview <project> <session-id> [--format json]             # preview bucketed candidates + recurring suggested competitors of every classified type (read-only)
canonry discover promote <project> <session-id> [--bucket cited,aspirational,wasted-surface] [--competitor-types direct-competitor,editorial-media] [--no-competitors] [--format json]   # adopt cited + aspirational queries + direct-competitor domains by default

# OpenAI ads (ChatGPT ads) — paid-surface data for the connected ad account
canonry ads connect <project> --api-key <sdk-key>     # validate + store the Ads Manager SDK key (config.yaml)
canonry ads status <project>
canonry ads sync <project>                            # trigger an ads-sync run
canonry ads campaigns <project> [--format json|jsonl] # snapshots incl. context hints
canonry ads insights <project> [--level campaign|ad_group] [--entity <id>] [--from <d>] [--to <d>] [--format json|jsonl]
canonry ads summary <project>                         # campaign-level totals (spend in micros, derived ctr/cpc)
canonry ads disconnect <project>

# Technical AEO — site-wide technical audit (powered by the `site-audit` run kind + @ainyc/aeo-audit's runSitemapAudit)
canonry technical-aeo run <project> [--sitemap-url <url>] [--limit <n>] [--wait] [--format json]   # crawl the sitemap + audit every page; idempotent (returns the in-flight run); default page cap 500, hard max 2000
canonry technical-aeo score <project> [--format json]                                # latest site score (0–100) + per-factor scorecard + delta vs the previous audit
canonry technical-aeo pages <project> [--status success|error] [--sort score-asc|score-desc|url] [--limit <n>] [--format json|jsonl]  # per-page breakdown of the latest run (worst-first by default)
canonry technical-aeo trend <project> [--limit <n>] [--format json|jsonl]            # aggregate-score history across past audits
# Schedule it: canonry schedule set <project> --kind site-audit --preset weekly

# MCP adapter (separate bin, stdio only)
canonry-mcp                                          # core tier (~12 tools); load toolkits on demand
canonry-mcp --read-only                              # core read tier; toolkits load read-only tools only
canonry-mcp --eager                                  # register all API tools at startup (legacy flat catalog)

# MCP client install helpers (operate on local client config files)
canonry mcp install --client claude-desktop          # merges a canonry entry into the config
canonry mcp install --client cursor --read-only      # scope to the 69 read API tools
canonry mcp config  --client codex                   # print snippet for clients without auto-install

# Skills — install canonry's agent playbook into a user's project
canonry skills list                                  # show bundled skills (canonry, aero)
canonry skills install                               # write both skills into ./.claude/skills/ + ./.codex/skills/ (default)
canonry skills install aero --client claude          # install only the analyst skill, no codex symlink
canonry skills install --dir ~/projects/foo --force  # custom target, overwrite divergent local edits

# API keys — mint / list / revoke / whoami (mint+revoke gated by the keys.write scope; the default * key satisfies it)
canonry key list [--format json|jsonl]                          # safe metadata only (never the hash or plaintext)
canonry key create --name <name> [--scope <s> ...] [--format json]  # prints the plaintext key ONCE; omit --scope to default to *
canonry key create --name <name> --read-only [--format json]    # read-only key (scopes=['read']); server denies every write method
canonry key revoke <id> [--format json]                         # revoke (not delete); takes effect on the next request
canonry key whoami [--format json]                              # introspect the CURRENT key (name, scopes, readOnly, status)
```

## Agent Layer

Canonry ships a built-in AI agent called **Aero**, backed by
[`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono). Aero
is an AEO analyst: it reads project state, analyzes regressions, acts
through a typed tool surface (runs sweeps, dismisses insights, attaches
webhooks, updates schedules), and **wakes up unprompted** when runs
complete — producing an analysis without a user request.

Users who prefer their own agent (Claude Code, Codex, custom) still get
the external-agent webhook path via `canonry agent attach <url>`.

### Built-in Aero (native loop)

- **CLI:** `canonry agent ask <project> "<prompt>"` — one-shot, streams
  `AgentEvent`s to stdout. Supports `--provider claude|openai|gemini|zai|deepinfra`
  and `--format json`. `deepinfra` is a Western-hosted OpenAI-compatible host
  (GLM-5.2); its key comes from `DEEPINFRA_TOKEN` or
  `providers.deepinfra.apiKey`, and `DEEPINFRA_BASE_URL` repoints the host at a
  proxy (e.g. a LiteLLM gateway) — unset falls back to `api.deepinfra.com`.
- **Dashboard:** the bottom command bar on every project-scoped route.
  SSE-streamed. Starter buttons cover the common ops (status, insights,
  last failed run, schedule).
- **Proactive:** `RunCoordinator` fires a synthesized user message into the
  session's follow-up queue after each `run.completed`; `SessionRegistry.drainNow`
  wakes the agent to analyze and writes the response back to the transcript
  before the next interaction.
- **Persistence:** one rolling session per project in the `agent_sessions`
  table. Transcript + queued follow-ups survive `canonry serve` restarts.

Key files:
- `packages/canonry/src/agent/session.ts` — `createAeroSession` (pi integration)
- `packages/canonry/src/agent/session-registry.ts` — hybrid in-memory + DB registry
- `packages/canonry/src/agent/tools.ts` — thin wrapper that exposes the entire MCP tool registry to Aero via `mcp-to-agent-tool.ts`
- `packages/canonry/src/agent/mcp-to-agent-tool.ts` — adapter; new MCP tools flow into Aero with no second registration
- `packages/canonry/src/agent/agent-routes.ts` — Fastify SSE endpoints
- `apps/web/src/components/shared/AeroBar.tsx` — dashboard UI

### Disabling Aero

Aero is on by default. To turn the built-in agent OFF entirely — no proactive
auto-wake on run completion, no `SessionRegistry`, and the interactive agent
routes (`/projects/:name/agent/*`) plus `canonry agent ask` not served — set
`agent.mode: 'disabled'` in `~/.canonry/config.yaml`, or `CANONRY_AGENT_DISABLED=1`
in the environment (env wins; `CANONRY_AGENT_DISABLED=0` forces it back on even
when config disables). Resolved by `resolveAgentEnabled` in
`packages/canonry/src/agent-config.ts`. This only affects the agent — data
syncs, intelligence, and notifications are unchanged. Use it when the proactive
analysis is unused and you want to stop the per-run agent LLM cost. This
silences only the *automatic* per-run agent stream; the on-demand `analyze`-tier
calls (the recommendation `explain` / `brief` routes — Sonnet) still bill when a
user explicitly requests them, since those are not part of the agent loop.

### External agents (webhook)

`canonry agent attach <project> --url <webhook-url>` registers a webhook for
the project. `canonry agent detach <project>` removes it. Events:
`run.completed`, `insight.critical`, `insight.high`, `citation.gained`.

## Doctor

`canonry doctor` runs an extensible set of health checks across global config and project-scoped integrations. Each check has a stable dotted ID (`google.auth.connection`, `ga.auth.connection`, `config.providers`, …) so an agent or skill can filter via `--check <id>` / `?check=<id>` and react to specific failures programmatically.

- **CLI:** `canonry doctor [--project <name>] [--check <id>...] [--format json]`
- **API:** `GET /api/v1/doctor` (global), `GET /api/v1/projects/:name/doctor` (project-scoped). Both accept `?check=<comma-separated ids or wildcards>`.
- **MCP:** `canonry_doctor` (core tier) — passes `project` + `checks[]` straight through.

Each check returns `status: ok | warn | fail | skipped`, a stable machine-readable `code`, a `summary`, optional `remediation`, and structured `details`. v1 ships:

| Category | ID | Scope | Purpose |
|----------|----|-------|---------|
| database | `db.file.present` | global | Configured SQLite database file still exists on disk (catches `rm ~/.canonry/data.db` against a running daemon — SQLite holds the inode open across `unlink`) |
| config | `config.file.present` | global | Configured `~/.canonry/config.yaml` still exists on disk (same gotcha as above) |
| auth | `google.auth.connection` | project | OAuth credentials present, refresh token works |
| auth | `google.auth.property-access` | project | Authorized principal can list the selected GSC site |
| auth | `google.auth.redirect-uri` | project | `publicUrl`-derived redirect URI is valid + advertised |
| auth | `google.auth.scopes` | project | Granted GSC + Indexing scopes match what's stored |
| auth | `ga.auth.connection` | project | GA4 service account verifies against the configured property |
| auth | `gbp.auth.connection` | project | Google Business Profile OAuth credentials present, refresh token works |
| auth | `gbp.auth.scopes` | project | Granted scope includes `business.manage` |
| auth | `gbp.account.access` | project | The tracked GBP account is still listable for the authorized user (maps 0-QPM access-form-pending → warn) |
| auth | `gbp.places.api-key` | project | Google Places API readiness for the listing cross-reference (#648): warns when GBP is connected but no Places key is set, or when no selected location carries a Maps place id; skipped when Places is disabled (`tier: off`) or GBP isn't connected |
| integrations | `gbp.data.recent-sync` | project | A selected GBP location synced in the last 7d (warn) or 30d (fail); warns when never synced |
| auth | `ads.auth.connection` | project | OpenAI ads connection row has a matching SDK key in the local config (skipped when not connected) |
| integrations | `ads.data.recent-sync` | project | Connected ad account synced in the last 7d (warn) or 30d (fail); warns when never synced (skipped when not connected) |
| auth | `wordpress.publish.connection` | project | WordPress publishing connection (`integration-wordpress`): the Application Password authenticates and the `wp/v2` REST API responds; skipped when no connection is configured |
| auth | `traffic.source.credentials` | project | Per-source-type credential validation (Cloud Run service-account access token resolves; WordPress and Vercel probe-call their endpoints) |
| auth | `traffic.source.scopes` | project | Per-source-type scope validation (skipped where the adapter has no explicit scope check — e.g. WordPress Application Passwords, Vercel API tokens) |
| integrations | `traffic.source.connected` | project | At least one non-archived server-side traffic source exists for the project |
| integrations | `traffic.source.recent-data` | project | Connected sources have crawler/AI-referral events in the last 7d (warn) or 30d (fail) |
| integrations | `backlinks.source.connected` | project | At least one backlink source is set up — Common Crawl (`autoExtractBacklinks` + a `ready` release sync) OR Bing Webmaster (a connection for the domain); warns when a project has neither |
| integrations | `content.winnability.coverage` | project | Discovery classification coverage for cited-surface domains behind the content winnability gate; warns when discovery has not classified the domains that make ownable/ceded decisions meaningful |
| providers | `config.providers` | global | At least one answer-engine provider key configured |
| providers | `config.agent-providers` | global | At least one agent LLM provider (claude / openai / gemini / zai / deepinfra) has a usable key — warns when none do (the built-in Aero agent can't run); skipped on deployments that don't run the agent |
| agent | `agent.skills.installed` | global | Both bundled skills (`canonry`, `aero`) are present under `~/.claude/skills/` |
| agent | `agent.skills.current` | global | Installed `~/.claude/skills/` trees are not behind the bundled build — warns when a newly shipped or upstream-updated file has not been picked up (skips when nothing is installed; local edits are reported but do not count as "behind") |

### Adding a new check

1. Implement a `CheckDefinition` in `packages/api-routes/src/doctor/checks/<topic>.ts`. Use `@ainyc/canonry-contracts` `CheckStatuses` / `CheckCategories` / `CheckScopes` enums — never raw strings.
2. Register it in `packages/api-routes/src/doctor/registry.ts` (`ALL_CHECKS`).
3. Add a `<topic>.ts` test under `packages/api-routes/test/doctor-*` covering the happy path + each `code` value the check can emit.
4. Both the CLI and MCP tool surface the new check automatically — no additional wiring required.

### MCP clients (stdio adapter)

For MCP clients such as Claude Desktop, Codex, or custom agent shells that
prefer a typed tool catalog over shell or HTTP, the package ships a separate
`canonry-mcp` bin. It is a thin stdio adapter over `createApiClient()` — not
a parallel surface. v1 exposes 114 curated API tools (77 read, 37 write) — including
the `canonry_project_overview` and `canonry_search` core composites; the
catalog is split across a small **core tier** (always loaded) and five
**toolkits** (`monitoring`, `setup`, `gsc`, `ga`, `agent`) that the client
loads on demand via `canonry_load_toolkit`. The catalog coalesces enable
side effects so each `canonry_load_toolkit` call emits exactly one
`notifications/tools/list_changed`. Pass `--read-only` to surface
only the read tools, or `--eager` (or `CANONRY_MCP_EAGER=1`) to register
every tool at startup like the previous flat catalog. Auth is inherited
from `~/.canonry/config.yaml`.

Key files:
- `packages/canonry/src/mcp/server.ts` — `createCanonryMcpServer` (one client per server instance, registers core tier + meta tools)
- `packages/canonry/src/mcp/cli.ts` — stdio entrypoint + scope/eager flag parsing
- `packages/canonry/src/mcp/tool-registry.ts` — single source of truth for all 112 API tools, each tagged with a `tier`
- `packages/canonry/src/mcp/toolkits.ts` — toolkit catalog (`monitoring`, `setup`, `gsc`, `ga`, `agent`) consumed by `canonry_help`
- `packages/canonry/src/mcp/dynamic-catalog.ts` — `DynamicToolCatalog`: enables tools on `canonry_load_toolkit`, drives `canonry_help`
- `packages/canonry/src/mcp/openapi-classification.ts` — drift table; every published OpenAPI op is `included`, `deferred`, or `excluded-protocol`
- `packages/canonry/src/mcp/results.ts` — `withToolErrors` wrapper, `CliError` → MCP error envelope mapping
- `packages/canonry/bin/canonry-mcp.mjs` — published bin shim
- `docs/mcp.md` — install, auth, client config, safety rules, tier system, and v1 limitations

The MCP adapter must follow the boundary rules in `Surface Priority → Agent
& automation design principles → MCP adapter boundary` (rule 8 in this
file): no DB, route, job-runner, telemetry, or logger imports; never write
non-MCP data to stdout. Every new MCP tool must already exist as a public
API endpoint and CLI command — MCP is not a place to add capabilities.
MCP parity is the default for every new public API/CLI capability: either add
the matching tool, or explicitly classify the OpenAPI operation as `deferred`
or `excluded-protocol` with a short security/protocol/product rationale in
`openapi-classification.ts`. Do not silently skip MCP.

### Notification events (shared)

The notification system supports `citation.lost`, `citation.gained`, `run.completed`,
`run.failed`, `insight.critical`, `insight.high`. `insight.critical` and
`insight.high` fire when the intelligence engine generates critical- or
high-severity insights after a run — dispatched by `RunCoordinator` after
`IntelligenceService.analyzeAndPersist()` completes.

## Dependency Boundary

- `packages/api-routes/` must not import from `apps/*`.
- `packages/canonry/` is the only publishable artifact. Internal packages are bundled via tsup.
- All internal packages use `@ainyc/canonry-*` naming convention.

## Vocabulary (Critical)

Canonry tracks two parallel signals for every (query × provider) snapshot. They are independent — a model can do either, both, or neither — and must never be conflated in code, copy, or contract field names.

| Term | Meaning | Source field |
|------|---------|--------------|
| **mention / mentioned** | The project's brand or domain appears in the actual LLM answer text response (the prose the model returns). | `query_snapshots.answer_mentioned` (boolean) |
| **cited** | The project's domain appears in the source links/material the LLM used to get the answer (the structured grounding / citations / search-result list returned alongside the answer). | `query_snapshots.citation_state` = `'cited'` |

### Rules

1. **Use `mention` / `mentioned` for answer-text presence.** Never use `answer`, `visible`, or `visibility` for new code that means the same thing — those exist as legacy terms (DB column `visibility_state`, run kind `answer-visibility`, function `visibilityStateFromAnswerMentioned`) but new APIs, fields, CLI flags, and UI labels must say `mentioned`.
2. **Use `cited` for source-list presence.** Never use `citation` as an umbrella for both signals — citation refers specifically to the source-attribution side.
3. **Never compute one signal from the other.** A label that says "cited" must read `citationState` (or a derived `cited: boolean`); a label that says "mentioned" must read `answerMentioned`. If you find a metric named for one signal but computed from the other, that's a bug — fix it, don't paper over it.
4. **When you need to refer to both at once,** say "citation + mention coverage" or "visibility (cited or mentioned)" — but always disambiguate immediately.
5. **Public API field names** must use the canonical vocabulary. Renaming a field means a version bump per the API Stability rules, so get it right the first time.
6. **When rendering snapshot state in CLI/UI output, render both signals.** Don't print a single-cell label that flips between "cited" and "mentioned" depending on which field is populated — readers cannot tell which signal they're looking at. Use a two-glyph cell (`[citation][mention]` — `C/c` for cited/not, `M/m` for mentioned/not, `–` for missing) like `canonry citations` and `canonry run` do, and always print the legend above the table.
7. **Lint-enforced banned literals.** ESLint blocks the literals `'not-vis'`, `'visibility run'`, `'visibility sweep'`, `'visibility report'`, `'answer rate'`, `'answer-rate'`, and `'answerRate'` in `packages/canonry/src/commands/`, `packages/canonry/src/cli-commands/`, `packages/api-routes/src/`, and `apps/web/src/`. Bare `'visible'` is not banned because it has legitimate uses (DOM `document.visibilityState`, the legacy `VisibilityState` enum value) — the burden of correctness for those falls on review.

### Anti-patterns

```typescript
// ❌ Wrong — name says "answer", reader can't tell which signal
{ answerRate: 0.42 }

// ✅ Correct
{ mentionRate: 0.42 }

// ❌ Wrong — "visible" is ambiguous (cited? mentioned? both?)
let visible = 0
if (mentioned) visible++

// ✅ Correct
let mentioned = 0
if (answerMentioned) mentioned++

// ❌ Wrong — "Citation visibility" headline that counts answer-text mentions
"Cited by 3 of 4 engines" // computed from answerMentioned

// ✅ Correct — distinct headlines for the two signals
"Cited by 2 of 4 engines"     // citationState
"Mentioned in 3 of 4 answers" // answerMentioned
```

## Enum Constants (Critical)

**Never compare domain values as raw string literals.** Use the enum constant objects exported from `packages/contracts/src/run.ts` (re-exported via `@ainyc/canonry-contracts`).

### Available constants

| Constant | Type | Values |
|----------|------|--------|
| `RunKinds` | `RunKind` | `RunKinds['answer-visibility']`, `RunKinds['gsc-sync']`, etc. |
| `RunStatuses` | `RunStatus` | `RunStatuses.completed`, `RunStatuses.failed`, etc. |
| `RunTriggers` | `RunTrigger` | `RunTriggers.manual`, `RunTriggers.scheduled`, `RunTriggers.probe`, etc. |
| `CitationStates` | `CitationState` | `CitationStates.cited`, `CitationStates['not-cited']` |
| `VisibilityStates` | `VisibilityState` | `VisibilityStates.visible`, `VisibilityStates['not-visible']` |
| `ComputedTransitions` | `ComputedTransition` | `ComputedTransitions.lost`, `ComputedTransitions.emerging`, etc. |

### Rules

1. **Import and use the constant objects** — never write `kind === 'answer-visibility'`, write `kind === RunKinds['answer-visibility']`.
2. **Type function parameters with the union type** — use `kind: RunKind` not `kind: string`. This enables exhaustive switch checking.
3. **Use exhaustive switches** — when all cases are covered, omit the `default` branch so TypeScript errors if a new variant is added. If a default is needed, use `default: { const _exhaustive: never = value; }` to catch missing cases at compile time.
4. **Add new variants to the Zod schema in `packages/contracts/src/run.ts`** — the constant object is derived from it automatically via `schema.enum`.

### Pattern

```typescript
import type { RunKind } from '@ainyc/canonry-contracts'
import { RunKinds, RunStatuses } from '@ainyc/canonry-contracts'

// ✅ Correct — enum constant + typed parameter + exhaustive switch
function kindLabel(kind: RunKind): string {
  switch (kind) {
    case RunKinds['answer-visibility']: return 'Answer visibility sweep'
    case RunKinds['gsc-sync']: return 'GSC sync'
    case RunKinds['inspect-sitemap']: return 'Sitemap inspection'
    case RunKinds['site-audit']: return 'Site audit'
  }
}

// ❌ Wrong — raw string literals, untyped parameter
function kindLabel(kind: string): string {
  switch (kind) {
    case 'answer-visibility': return 'Answer visibility sweep'
    default: return kind
  }
}
```

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

### UI/CLI parity (Critical)

**Every dashboard view, widget, and computed metric visible in the web UI must have an equivalent API endpoint and CLI command that returns the same data.** The UI is a consumer of the API, not a privileged surface. If a user can see it in the browser, an agent must be able to read it from the CLI.

#### Rules

1. **No UI-only calculations.** If the UI computes a derived metric (percentages, trends, diffs, scores, roll-ups), that calculation must live in the API response — not in frontend component code. The API returns the computed value; both the UI and CLI consume it.
2. **No UI-only state.** Every dashboard panel, section, or page that displays data must map to a CLI command. If the UI shows a "Social Referral Summary" card, there must be a `canonry ga social-referral-summary` command that returns the same information.
3. **Mirror granularity.** If the UI shows both a summary and a detail view, the CLI must offer both. A single dump endpoint that requires agents to post-process is not equivalent.
4. **Same data, same shape.** The JSON output of `--format json` for a CLI command should be structurally identical to the API response the UI consumes. An agent should be able to replace a UI `fetch()` call with a `canonry ... --format json` call and get the same fields.

#### When adding a new UI component

Before building any new dashboard section or widget:

1. Confirm the backing API endpoint already exists (or add it first).
2. Confirm the matching CLI command already exists (or add it first).
3. Ensure all derived metrics and calculations are in the API response, not computed in the component.
4. The UI component should only be responsible for layout and presentation — never for business logic or data aggregation.

#### Anti-patterns

```typescript
// ❌ Wrong — UI computes a metric that agents can't access
const aiShare = Math.round((traffic.aiSessions / traffic.totalSessions) * 100)

// ✅ Correct — API returns the computed metric, UI just displays it
// API response: { aiSharePct: 12 }
<span>{traffic.aiSharePct}%</span>
```

```typescript
// ❌ Wrong — UI aggregates raw data that the API doesn't expose as a summary
const totalBySource = referrals.reduce((acc, r) => { ... }, {})

// ✅ Correct — API has a summary endpoint, UI consumes it
// GET /projects/:name/ga/attribution returns { channelBreakdown: [...] }
```

### Calculation Testing (Critical)

**Every calculation must have robust logical tests.** Any derived number, percentage,
trend, score, rank, bucket, residual, roll-up, dedupe, or classification must be
tested against the business invariant it claims to represent.

#### Rules

1. **Assert exact expected math, not shape only.** Tests like `toBeGreaterThanOrEqual(0)`, `typeof value === 'number'`, or "renders without crashing" are not sufficient for calculation changes.
2. **Test the invariant.** If buckets are supposed to sum to a total, assert the sum. If a metric is supposed to be disjoint, seed overlap and prove it is not double-counted. If a rate uses a denominator, assert the numerator, denominator, rounded value, and display value.
3. **Cover edge cases deliberately.** Include zero totals, missing/partial data, duplicate rows, overlapping categories, rounding boundaries (`<1%`, `0%`, `100%`), clamping behavior, and stale/legacy rows when the calculation can encounter them.
4. **Keep calculations out of presentation-only tests.** Put the canonical calculation in the API/shared layer and test it there; UI tests should verify that the UI renders the API-provided values without recomputing them.
5. **Protect agent-facing output.** When a calculation appears in CLI JSON, reports, MCP/API responses, or dashboard cards, add or update tests for the machine-readable contract as well as any human-readable display string.

### Report parity (Critical)

**The downloadable HTML report and the in-app report SPA must always show the same sections, the same labels, the same numbers, and the same visual structure.** Clients and agencies see one report — only the surface differs. They are two renderers of the same DTO; never let them diverge.

#### Rules

1. **One DTO, two renderers.** `apps/web/src/pages/ReportPage.tsx` (SPA) and `packages/api-routes/src/report-renderer.ts` (HTML) consume the same `ProjectReportDto`. Any change to one must land in the other in the same change.
2. **Section parity per audience.** For each `audience` (`'client' | 'agency'`), the SPA and HTML must render the same ordered set of sections with the same eyebrows, titles, and subtitles.
3. **Same copy, same numbers.** Tile labels, headlines, action-card copy, evidence-card titles, and chart axis labels must match verbatim across both surfaces. If the SPA says "AI mentions your name", the HTML says "AI mentions your name" — not "Mention coverage".
4. **Visual parity in spirit.** The HTML can't render React components, but every chart, progress bar, hero block, and badge in the SPA must have a visual equivalent in the HTML (inline SVG, CSS, or table). Don't ship a chart in one surface that doesn't exist in the other.
5. **Test both renderers.** When you change client/agency copy or section structure, update `packages/api-routes/test/report-renderer.test.ts` so the HTML asserts the new strings, and verify the SPA visually before merging.

#### Anti-patterns

```typescript
// ❌ Wrong — SPA renames a tile but HTML keeps the old label
// ReportPage.tsx
<Metric label="AI mentions your name" value={...} />
// report-renderer.ts (unchanged, drifts)
<div class="metric"><div class="label">Mention coverage</div>...</div>

// ✅ Correct — both surfaces updated together
// ReportPage.tsx
<Metric label="AI mentions your name" value={...} />
// report-renderer.ts
<div class="metric"><div class="label">AI mentions your name</div>...</div>
```

```typescript
// ❌ Wrong — adding a chart to the SPA only
// ReportPage.tsx renders <ProviderBreakdownChart />
// report-renderer.ts has no equivalent

// ✅ Correct — add an inline-SVG version in the HTML renderer too
```

#### Checklist for any report change

- [ ] Updated SPA section in `apps/web/src/pages/ReportPage.tsx`
- [ ] Updated HTML section in `packages/api-routes/src/report-renderer.ts`
- [ ] Section order matches between SPA and HTML for each audience
- [ ] All visible strings (eyebrows, titles, subtitles, labels) match verbatim
- [ ] Charts/progress bars/heroes have visual equivalents in both surfaces
- [ ] `report-renderer.test.ts` updated to assert the new strings

### Agent & automation design principles

The CLI and API **are** the agent interface. MCP is allowed only as an adapter over the public API client. It is not a parallel surface and must not introduce capabilities unavailable through API/CLI. No virtual filesystem, no privileged agent SDK. If an AI agent can't do something with `canonry <command> --format json` or an HTTP call, it's a bug.

#### Rules

1. **No interactive prompts.** Every CLI command must be fully operable via flags and environment variables. Never import `node:readline` in command files — ESLint enforces this. If a value is sensitive (API keys, passwords), accept it via `--flag`, env var, or `config.yaml`. Prompts are allowed only in `canonry init` as a convenience; all init values must also be passable via flags.
2. **JSON everywhere.** Every command that produces output must support `--format json`. JSON output goes to stdout. Errors go to stderr as `{ "error": { "code": "...", "message": "..." } }`. Human-readable text is the default; JSON is the machine contract.
3. **Idempotent writes.** `canonry apply` is the model — running it twice with the same input produces the same state. New write commands must follow this pattern. `POST` endpoints that create resources (like runs) are exempt, but must return a stable identifier and handle conflicts gracefully (e.g., `runInProgress` error with the existing run ID).
4. **Single-call reads.** If an agent needs two API calls to answer a common question, add a composite endpoint. Examples: `/projects/:name/runs/latest` (don't make agents list-then-filter), `/projects/:name/search?q=term` (don't make agents fetch all snapshots to grep). The test: can an agent get what it needs in one `curl` call?
5. **Meaningful exit codes.** `0` = success, `1` = user error (bad input, not found, validation), `2` = system error (network, provider failure, internal). Agents use exit codes to decide whether to retry.
6. **Stable output contracts.** JSON field names, endpoint paths, and error codes are public API. Renaming a JSON field is a breaking change. Add fields freely; never remove or rename without a version bump.
7. **UI/CLI parity.** Every piece of data or computed metric visible in the web UI must be retrievable via the API and CLI. If the UI shows it, an agent must be able to `curl` or `canonry ... --format json` it. Derived calculations (percentages, trends, roll-ups) belong in the API response, not in frontend code. See the "UI/CLI parity" section above for the full rules.
8. **MCP adapter boundary.** `canonry-mcp` may call `createApiClient()` and public client methods only. It must not import DB modules, API routes, job runners, CLI dispatch, telemetry, or loggers, and it must never write non-MCP data to stdout.
9. **MCP parity by default.** Every new public API endpoint and CLI command must either add an equivalent MCP tool, or classify the OpenAPI operation as `deferred` / `excluded-protocol` with an explicit rationale in `packages/canonry/src/mcp/openapi-classification.ts`. Security-sensitive credential or token operations may be deferred, but the PR must say why.

#### Checklist for any new command or endpoint

- [ ] Fully operable without interactive input (no readline, no prompts)
- [ ] `--format json` supported, outputs to stdout
- [ ] Errors output structured JSON to stderr with a code from `CliError`
- [ ] Write operations are idempotent (or return conflict details)
- [ ] Equivalent MCP tool added, or `openapi-classification.ts` has an explicit `deferred` / `excluded-protocol` rationale
- [ ] Common read patterns achievable in a single API call
- [ ] Exit code follows 0/1/2 convention
- [ ] New request parameters classified identity vs tuning (see "Request Parameters: Identity vs Tuning"): identity params join every reuse/dedup key with a test; tuning params documented as dropped on reuse

#### Checklist for any new UI component

- [ ] Backing API endpoint exists and returns all data the component displays
- [ ] Matching CLI command exists with `--format json` support
- [ ] All derived metrics (percentages, trends, diffs) are computed in the API, not the component
- [ ] JSON shape from CLI matches the API response the UI fetches
- [ ] Reads flow through the generated `@ainyc/canonry-api-client` SDK (via `heyClient` from `apps/web/src/api.ts`) — raw `fetch()` is ESLint-banned in `apps/web/src/`

### Spec-driven typing (Critical)

The OpenAPI spec at `packages/api-routes/src/openapi.ts` is the single source of truth for HTTP request/response shapes. The web client (`@ainyc/canonry-api-client`), the CLI's `ApiClient`, and the MCP adapter all consume types regenerated from it. Two enforceable rules keep that pipeline intact:

1. **Every new route MUST register a Zod schema and reference it via `jsonResponse(...)`.** New endpoints returning `rawJsonResponse(..., looseObjectSchema)` are blocked by `packages/api-routes/test/no-new-loose-routes.test.ts` — the test caps the current loose-response count, so adding one fails CI. Add the schema in `packages/contracts/src/<topic>.ts`, register it in `openapi-schemas.ts`, flip the route, run `pnpm gen`. See `packages/api-routes/AGENTS.md → "Typed responses"` for the step-by-step pattern.

2. **Every web call into the canonry API MUST go through the generated SDK.** Raw `fetch()` and `XMLHttpRequest` are ESLint-banned in `apps/web/src/` (only `api.ts` and `api-aero.ts` may use them — the former is the SDK wrapper layer, the latter is the SSE prompt / transcript bridge). Use `useQuery(getApiV1...Options({client: heyClient, ...}))` for cached reads, the existing typed `fetchX()` wrappers in `api.ts` for composite calls, and add a new wrapper to `api.ts` (delegating to the generated SDK function) when one doesn't exist. See `apps/web/AGENTS.md → "API calls (Critical)"` for the full rules.

The contract test `packages/api-routes/test/openapi-contract.test.ts` enforces a third invariant: every registered schema must be referenced by at least one route. Deleting the last consumer of a schema means removing it from the registry — no orphan entries.

## Maintenance Guidance

- Keep shared shapes in `packages/contracts`.
- Keep environment parsing in `packages/config`.
- Keep provider logic in `packages/provider-*/`.
- Keep API route plugins in `packages/api-routes` (no app-level concerns).
- Keep API handlers thin.
- Keep the canonry app independent from the audit package repo except for the published npm dependency.
- Raw observation snapshots only (`cited`/`not-cited`); transitions computed at query time.

## Shared Utilities (Critical)

**Generic, pure helpers belong in `packages/contracts/` — not duplicated inline in consumer files.** When you find yourself writing a `formatX`, `parseX`, `normalizeX`, `clampX`, or any other small helper that doesn't depend on domain state, the rule is: write it once, in `contracts`, and import it everywhere it's needed.

### Rules

1. **Default to centralizing.** Before defining a helper inline, check `packages/contracts/src/` for an existing equivalent. Specifically check `formatting.ts`, `url-normalize.ts`, `report-dedup.ts`, `retry.ts`, and `errors.ts` — those are the established homes for cross-package utilities.
2. **Make helpers as generic as possible.** A helper named `formatGscDate` that handles only GSC's date format is a missed abstraction. Name and shape it so the next caller (GA, BWT, reports) can reuse it without modification. Domain-specific wrappers can live in the consumer file and call into the generic core.
3. **No duplicate implementations.** If two packages both need to convert ISO 8601 to `YYYY-MM-DD`, there is exactly one function for that — `formatIsoDate` in `contracts/formatting.ts` — and both packages import it. Catch this in review: if you see a second implementation appearing, replace it with the import.
4. **Pure functions only.** Utilities in `contracts` must have no side effects, no I/O, no DB access, no logging. They take values and return values. Anything else belongs in the consuming package.
5. **Test the utility, not the caller.** Tests for shared helpers live alongside the helper (`packages/contracts/test/<name>.test.ts`). Consumer tests should not re-test the helper's logic — they should trust it.
6. **When you discover an inline helper that should be generic, migrate it.** Don't leave duplication for "later." Pull it into `contracts`, update all callers in the same change, and delete the inline copies.

### Where utilities live

| Concern | File |
|---------|------|
| Date / number / ratio formatting | `packages/contracts/src/formatting.ts` |
| URL / domain normalization | `packages/contracts/src/url-normalize.ts` |
| Tracked-query text normalization | `packages/contracts/src/query-normalize.ts` (`normalizeQueryText` — trim + lowercase for dedup / FK-null text matching) |
| Report action / opportunity dedup | `packages/contracts/src/report-dedup.ts` |
| Error factories | `packages/contracts/src/errors.ts` |
| SQL `LIKE` wildcard escaping | `packages/contracts/src/sql-like.ts` (`escapeLikePattern` — caller adds `ESCAPE '\\'`) |
| Retry / exponential backoff | `packages/contracts/src/retry.ts` (`withRetry`, `backoffDelayMs`, `isRetryableHttpError`) |
| Bounded async concurrency | `packages/contracts/src/concurrency.ts` (`mapWithConcurrency` — order-preserving worker pool, fail-fast with clean settle) |
| Telemetry funnel classification | `packages/contracts/src/telemetry.ts` (`isGhostTelemetryEvent` — shared by the CLI client drop + the cloud collector backstop) |
| JSON column parsing (DB-only) | `packages/db` (`parseJsonColumn`) |

Add new utility files to `packages/contracts/src/` and re-export them from `index.ts`. Keep modules small and focused — a `formatting.ts` for formatters, a separate file for the next category. One file per concern.

### Anti-patterns

```typescript
// ❌ Wrong — defining a generic helper inline in a domain file
// packages/api-routes/src/report-renderer.ts
function formatNumber(value: number): string {
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('en-US')
}

// ✅ Correct — single source of truth, imported everywhere
// packages/contracts/src/formatting.ts
export function formatNumber(value: number): string { /* ... */ }

// packages/api-routes/src/report-renderer.ts
import { formatNumber } from '@ainyc/canonry-contracts'
```

```typescript
// ❌ Wrong — three packages each define their own formatDate
// packages/canonry/src/gsc-sync.ts: function formatDate(d: Date) { ... }
// packages/integration-google-analytics/src/ga4-client.ts: function formatDate(d: Date) { ... }
// packages/api-routes/src/report-renderer.ts: function formatDate(iso: string) { ... }

// ✅ Correct — one shared helper, imported by all three
// packages/contracts/src/formatting.ts: export function formatIsoDate(iso: string) { ... }
```

## Error Handling in API Routes (Critical)

The global error handler in `packages/api-routes/src/index.ts` catches `AppError` instances and serializes them with the correct status code and JSON envelope. Route handlers must leverage this — never duplicate the serialization logic.

### Rules

1. **Throw `AppError` — never catch and manually reply.** Call `resolveProject(app.db, name)` directly. If the project doesn't exist it throws `notFound()`, which the global handler catches. Do not wrap in try-catch or use a `resolveProjectSafe` helper.
2. **Always use factory functions from `@ainyc/canonry-contracts`.** Never hand-construct `{ error: { code: '...', message: '...' } }`. Use `validationError()`, `notFound()`, `authRequired()`, `providerError()`, etc. This guarantees typed error codes and a consistent envelope.
3. **New error codes** must be added to the `ErrorCode` union in `packages/contracts/src/errors.ts` with a corresponding factory function.

### Pattern

```typescript
// ✅ Correct — let the global handler serialize
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

const project = resolveProject(app.db, request.params.name) // throws notFound on miss
if (!body.queries?.length) throw validationError('"queries" must be non-empty')

// ❌ Wrong — duplicates global handler logic
try {
  const project = resolveProject(app.db, name)
} catch (e) {
  reply.status(e.statusCode).send(e.toJSON()) // never do this
}
return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: '...' } }) // never do this
```

## JSON & Boolean Column Reads (Critical)

The schema is mid-migration from raw `text(...)` / `integer(...)` columns to Drizzle's native `text({ mode: 'json' }).$type<T>()` and `integer({ mode: 'boolean' })` modes. Reads depend on which mode the column uses.

### `projects` table (already migrated)

JSON and boolean columns are auto-coerced by Drizzle. Direct property access returns the typed value — no helper, no coercion needed:

```typescript
// ✅ Correct — Drizzle reads/writes the typed value
const locations: LocationContext[] = project.locations
const labels: Record<string, string> = project.labels
const auto: boolean = project.autoExtractBacklinks

// ✅ Correct — writes use the typed value too
await db.update(projects).set({
  locations: [{ label: 'us', country: 'US' }],
  labels: { team: 'growth' },
  autoExtractBacklinks: true,
}).where(eq(projects.id, id)).run()
```

### Other tables (not yet migrated)

`runs`, `querySnapshots`, `schedules`, `notifications`, GA/GSC/Bing rollups, `agentSessions`, `trafficSources`, etc. still use raw `text(...)` for JSON and raw `integer(...)` for booleans. Reads from those columns require the typed helper, and boolean reads coerce manually:

```typescript
import { parseJsonColumn } from '@ainyc/canonry-db'

// ✅ Correct — typed helper for the legacy raw-text columns
const overlap = parseJsonColumn<string[]>(snap.competitorOverlap, [])
const breakdown = parseJsonColumn<HealthSnapshotDto['providerBreakdown']>(row.providerBreakdown, {})

// ❌ Wrong — fragile, no fallback for malformed historical rows
const overlap = JSON.parse(snap.competitorOverlap || '[]') as string[]
```

### When migrating a table to native modes

1. Update `packages/db/src/schema.ts`: switch JSON columns to `text(col, { mode: 'json' }).$type<T>().notNull().default([])` (or `{}`), boolean columns to `integer(col, { mode: 'boolean' }).notNull().default(false)`.
2. No DB migration is needed — the storage format is unchanged. Drizzle parses/stringifies in TS.
3. Update every read site that called `parseJsonColumn<T>(row.X, ...)` to direct access `row.X`.
4. Update every write site that wrapped values in `JSON.stringify(...)` to pass the raw typed value.
5. Update every boolean read site (`row.X === 1`) and write site (`x ? 1 : 0`) to use the boolean directly.
6. Add tests that round-trip a write → read to confirm the type flows end-to-end. (`packages/api-routes/test/db-dto-coverage.test.ts` catches schema drift; round-trip tests catch coercion bugs.)
7. `JSON.parse` is still fine for HTTP request bodies, config files, and other non-DB sources.

## ApiClient Type Safety

All `ApiClient` methods in `packages/canonry/src/client.ts` must return typed DTOs from `@ainyc/canonry-contracts`. CLI commands must not cast API responses with `as Record<string, unknown>` or `as { ... }`.

- Define response interfaces in `packages/contracts/` when they don't already exist.
- The `request<T>()` method is already generic — specify the correct type parameter.
- When adding a new API endpoint, add the corresponding client method with a typed return value.

## Transaction Boundaries

Multi-table writes must be wrapped in a single `db.transaction()` call to ensure atomicity.

### Rules

1. **Do all async I/O (HTTP calls, DNS lookups, validation) before entering the transaction.** SQLite transactions must be synchronous (better-sqlite3 requirement).
2. **Include audit log writes inside the transaction** — `writeAuditLog()` accepts transaction context via its `Pick<DatabaseClient, 'insert'>` parameter.
3. **Fire callbacks (e.g., `onScheduleUpdated`) after the transaction commits**, not inside it.

### Pattern

```typescript
// Validate async work first
const urlCheck = await resolveWebhookTarget(url)
if (!urlCheck.ok) throw validationError(urlCheck.message)

// Then do all writes atomically
app.db.transaction((tx) => {
  tx.update(projects).set({ ... }).where(...).run()
  tx.delete(queries).where(...).run()
  for (const q of newQueries) {
    tx.insert(queries).values({ ... }).run()
  }
  writeAuditLog(tx, { ... })
})

// Fire callbacks after commit
opts.onScheduleUpdated?.('upsert', projectId)
```

## Atomic Counters

Use `INSERT ... ON CONFLICT DO UPDATE` for counter increments. Never use read-then-write patterns, which lose counts under concurrent requests.

### Pattern

```typescript
import { sql } from 'drizzle-orm'

db.insert(usageCounters).values({
  id: crypto.randomUUID(), scope, period, metric, count: 1, updatedAt: now,
}).onConflictDoUpdate({
  target: [usageCounters.scope, usageCounters.period, usageCounters.metric],
  set: { count: sql`${usageCounters.count} + 1`, updatedAt: now },
}).run()
```

## Database Schema Changes (Critical)

**Every new `sqliteTable(...)` in `packages/db/src/schema.ts` MUST have a corresponding migration in `packages/db/src/migrate.ts`.**

This is not optional. If you add a table to the schema but omit the migration, the table will never be created in any existing or new database, and every query against it will throw `no such table` at runtime.

### Rules

1. **New table** → append a `MIGRATION_VERSIONS` entry in `migrate.ts` with `CREATE TABLE IF NOT EXISTS ...` plus every index from the schema definition.
2. **New column** → append a `MIGRATION_VERSIONS` entry with `ALTER TABLE ... ADD COLUMN ...`. The runner swallows the SQLite "duplicate column name" error so the statement is safe to re-run.
3. **Removed column or table** → SQLite does not support `DROP COLUMN` on older versions; document the intent and leave the entry's `statements[]` as a comment-only no-op if needed.
4. **Never edit `MIGRATION_SQL`** (the initial block at the top). That block bootstraps brand-new installs and creates the `_migrations` tracking table. All incremental changes go in `MIGRATION_VERSIONS` only.
5. **Pick the next version number.** Find the highest existing `version` in `MIGRATION_VERSIONS` and add the next integer. Versions are recorded in the `_migrations` table on success; duplicate or out-of-order `version` values break the skip-already-applied logic.
6. **Never edit a previously-shipped version's `statements[]`.** Old DBs have already recorded that version as applied and will skip it on next boot — your edit will silently never run. Add a new version that fixes things up forward.
7. **Make every statement idempotent.** Each version commits in a single transaction; a non-recoverable failure mid-version rolls back and the next boot retries. Idempotent forms: `CREATE … IF NOT EXISTS`, `DROP … IF EXISTS`, `ALTER TABLE ADD COLUMN` (duplicate-column error swallowed), `UPDATE … WHERE` with a guard that becomes false after first apply.

### Pattern

```typescript
// In packages/db/src/migrate.ts — append to MIGRATION_VERSIONS:
{
  version: 47,
  name: 'my-new-feature',
  statements: [
    `CREATE TABLE IF NOT EXISTS my_new_table (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      value       TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_my_new_table_project ON my_new_table(project_id)`,
  ],
},
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
  queries:
    - query one
  competitors:
    - competitor.com
  providers:
    - gemini
    - openai
```

Locations are project-scoped via `spec.locations` and `spec.defaultLocation`. Runs choose the default location, an explicit location, all configured locations, or no location. Do not model locations as query-owned state.

Multiple projects can be defined in one file using `---` document separators. Apply with `canonry apply <file...>` (accepts multiple files) or `POST /api/v1/apply`. Applied project YAML is declarative input; runtime project/run data lives in the DB, while local authentication credentials live in `~/.canonry/config.yaml`.

## API Surface

All endpoints under `/api/v1/`. Auth via `Authorization: Bearer cnry_...`. Key endpoints:

- `PUT /api/v1/projects/{name}` — create/update project
- `POST /api/v1/projects/{name}/runs` — trigger visibility sweep
- `GET /api/v1/projects/{name}/timeline` — per-query citation history
- `GET /api/v1/projects/{name}/snapshots/diff` — compare two runs
- `POST /api/v1/apply` — config-as-code apply
- `GET /api/v1/openapi.json` — OpenAPI spec (no auth)

See OpenAPI spec at `/api/v1/openapi.json` for the complete API surface.

## Probe runs (Critical)

A **probe run** (`runs.trigger = 'probe'`, `RunTriggers.probe`) is an operator/agent test run that writes a snapshot so the operator can inspect provider behavior — but it MUST NOT influence the dashboard, analytics, intelligence, report, or notifications. Examples: verifying a provider migration still works; agent-initiated regression checks after a code change.

Triggered via `canonry run <project> --probe ...` or `POST /api/v1/projects/:name/runs` with `{ "trigger": "probe", ... }`.

### Rules for new code

1. **Read-aggregate endpoints MUST exclude probes.** Every Drizzle query that does `from(runs).where(eq(runs.projectId, ...))` for dashboard / analytics / report / timeline / intelligence purposes MUST AND-in `notProbeRun()` from `packages/api-routes/src/helpers.ts`. The test that catches regressions is `packages/api-routes/test/probe-exclusion.test.ts` — add a case when you ship a new aggregate endpoint.

2. **Per-run detail endpoints INCLUDE probes.** Endpoints that take a `runId` from the caller (`GET /runs/:id`, screenshot, browser-diff, GSC inspect lookups) MUST work for probe runs — the operator needs to inspect the snapshot they just created.

3. **Operator-facing list endpoints INCLUDE probes.** `GET /runs` and `GET /projects/:name/runs` show probes alongside real runs so operators can find their tests. The dashboard's TanStack Query consumer (`apps/web/src/queries/use-dashboard.ts`) filters probes client-side after fetching the unfiltered list.

4. **`RunCoordinator` short-circuits probes.** `packages/canonry/src/run-coordinator.ts` returns early without running intelligence, firing webhooks, or waking Aero when `runRow.trigger === 'probe'`. Don't add new post-run subscribers that skip this check.

5. **Operator triggers only.** `runTriggerRequestSchema` only accepts `manual` or `probe` from external callers. `scheduled`, `config-apply`, `backfill` are server-set based on the call site.

### Checklist when adding a new run-aggregate endpoint

- [ ] Drizzle query AND-in `notProbeRun()` from `helpers.ts`
- [ ] Add a case to `probe-exclusion.test.ts` asserting the endpoint reads from the real run, not the probe
- [ ] If the endpoint pages through historical runs (insights / health / report), confirm the recent-runs window also excludes probes

## Base Path Awareness (Critical)

Canonry supports running behind a reverse proxy with a sub-path prefix (e.g. `/canonry/`). All code that constructs URLs or registers routes **must** respect `basePath`. Failing to do so causes silent 404s in production.

### CLI commands — always use `createApiClient()`

Never instantiate `ApiClient` directly with `loadConfig()` in command files. Use the centralized helper:

```typescript
import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}
```

`createApiClient()` (in `packages/canonry/src/client.ts`) calls `loadConfig()` which incorporates `basePath` from both `config.yaml` and the `CANONRY_BASE_PATH` env var into `apiUrl` before constructing the client.

### Server routes — use `apiPrefix`

All API routes in `packages/api-routes/` are registered via a Fastify plugin with a `routePrefix` that already includes `basePath`. Do not hardcode `/api/v1` in route handlers or redirects. Use the prefix passed to the plugin.

### Health endpoint

The `/health` endpoint exposes `basePath` in its response for auto-discovery:
```json
{ "status": "ok", "service": "canonry", "version": "1.26.1", "basePath": "/canonry" }
```
When `basePath` is not configured, the `basePath` field is omitted.

### Web UI — use `window.__CANONRY_CONFIG__.basePath`

The SPA receives `basePath` via an injected config object. Use it for all API fetch calls and router base paths. Do not hardcode `/api/v1`.

### Checklist for any new route or CLI command

- [ ] Server route registered via the plugin's `routePrefix` (not hardcoded `/api/v1`)
- [ ] CLI command uses `createApiClient()` (not `new ApiClient(loadConfig().apiUrl, ...)`)
- [ ] MCP parity handled: add the tool, or document a `deferred` / `excluded-protocol` classification rationale
- [ ] Any redirect URLs or OAuth callback URLs use `publicUrl` or `apiUrl` (which already include basePath)
- [ ] Frontend fetch calls prepend `window.__CANONRY_CONFIG__.basePath`

## API Stability

**Never change existing API endpoint paths or HTTP methods during revisions.** The CLI, UI, and any external integrations are hard-coded to the published routes. Changing a path or method is a breaking change regardless of the reason.

- Additive changes (new endpoints, new optional fields) are fine.
- Renaming or restructuring existing routes requires a versioned migration plan and explicit user approval.
- If a route is wrong, fix the underlying logic — not the URL.

## Request Parameters: Identity vs Tuning (Critical)

Any operation that can SKIP or REUSE work has an identity key: in-flight consolidation (discover-run), dedup keys, response caches, idempotency guards. Every new request parameter on such an operation MUST be classified explicitly, in the PR, as one of:

1. **Identity** — the parameter changes what the operation PRODUCES (its output semantics). It must join the reuse key, be persisted on the row for auditability, and ship a test asserting that two requests differing only in this parameter never share a result. Examples: `buyerDescription` on discover-run changes the seed prompt's semantics, and `locations` changes both the seed geo-constraint and the probe geo context, so both are part of the consolidation identity — same ICP with a different (or no) buyer, or a different service-area subset, never consolidates onto another session.
2. **Tuning** — the parameter only changes HOW the work runs (cost / speed / quality knobs). It may be dropped when an in-flight operation is reused, but the drop must be documented at the route and in the endpoint description. Examples: `dedupThreshold`, `maxProbes`, `probeConcurrency` on discover-run.

The failure mode this prevents: a new semantics-bearing parameter is wired parse → forward → consumer while an existing reuse branch between parse and forward silently returns another request's result (a caller gets probes seeded for a different buyer, with `200 consolidated: true` and no error). When touching such a route, read the ENTIRE handler between request parse and operation kickoff — hunting for early-return, reuse, and cache branches — not just the lines the diff touches.

## Versioning

**Only bump the package version for non-documentation changes that modify more than 100 lines.** When a bump is required, the root `package.json` and `packages/canonry/package.json` versions must always be kept in sync with each other and with the latest published version on npm (`@canonry/canonry` and the compatibility `@ainyc/canonry` publish).

- Documentation-only changes (README, docs/, CLAUDE.md) do not require a bump.
- Small non-documentation changes of 100 changed lines or fewer do not require a bump.
- Larger changes — features, bug fixes, refactors, dependency updates, test additions that accompany code changes — require a semver bump in both `package.json` files when they exceed the 100-line threshold.
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
- **Test boundary matchers with data as STORED, not idealized.** Before writing a filter/normalizer/matcher over a stored column, check how that column is actually populated (project upsert/apply store `canonicalDomain` raw — full URLs and mixed case included) and sample real values when a database is available. Use the canonical helpers (`hostOf`, `normalizeQueryText`) from contracts instead of inline normalization: a clean-fixture-only suite passes while production values miss the match.
- **Test default-value propagation end-to-end.** When a feature stores a default (e.g., `defaultLocation` on a project) that another feature consumes (e.g., run creation), write a test that exercises the full path with no explicit override. Don't just test that the default is stored and that the consumer accepts a value — test that they connect.

## Code Comments

- **Never use comments as a substitute for code.** A comment like `// else use project default` is not implementation — it's a wish. If a branch is described in a comment, the code for that branch must exist. ESLint's `no-warning-comments` rule flags `TODO`/`FIXME`/`HACK` as warnings to prevent deferred work from rotting.
- **No placeholder branches.** If an `if/else if` chain has a case that should do something, write the code. If it intentionally does nothing, add an explicit empty block with a comment explaining why it's a no-op (e.g., `// allLocations handled in the block below`).

## CI Guidance

- Validation CI: `typecheck`, `test`, `lint` across the full workspace on PRs.
- Keep explicit job permissions.
- Publish workflow will be added when `packages/canonry/` is ready for npm.

## Keeping Documentation Current

This repo uses per-package `AGENTS.md` files for local context. **These must stay in sync with the code.** Update the relevant documentation when making structural changes:

| When you... | Update... |
|-------------|-----------|
| Add a new package under `packages/` or `apps/` | Create `AGENTS.md` + `CLAUDE.md` (`@AGENTS.md`) in the new package |
| Add a new table or column in `packages/db/src/schema.ts` | Update `docs/data-model.md` (ER diagram + table groups) |
| Add a new API route file in `packages/api-routes/src/` | Update `packages/api-routes/AGENTS.md` key files table |
| Add a new CLI command | Update `packages/canonry/AGENTS.md`; add the equivalent MCP tool or document the explicit classification exception |
| Add or change an MCP tool | Update `packages/canonry/src/mcp/tool-registry.ts` (tag with a `tier`), `openapi-classification.ts`, `docs/mcp.md`, and the `mcp-registry`/`mcp-stdio` tests. The built-in Aero agent picks the new tool up automatically through `agent/mcp-to-agent-tool.ts` — no second registration in `agent/tools.ts`. Add the name to `AERO_EXCLUDED_MCP_TOOLS` only if Aero must not invoke it (e.g. `canonry_agent_clear`). |
| Add a new doctor check | Add a `CheckDefinition` in `packages/api-routes/src/doctor/checks/<topic>.ts`, register in `doctor/registry.ts`, add tests in `packages/api-routes/test/doctor-*`, document the new check ID in `AGENTS.md`'s "Doctor" section |
| Add a new MCP toolkit | Add the toolkit name to `packages/canonry/src/mcp/toolkits.ts`, tag the relevant tools with the new tier, and update the toolkit table in `docs/mcp.md` |
| Add a new UI dashboard section or widget | Verify backing API endpoint + CLI command exist first (UI/CLI parity rule) |
| Add a new provider package | Update `docs/providers/README.md` and create `docs/providers/<name>.md` |
| Add a new integration package | Create `packages/integration-<name>/AGENTS.md` |
| Change a critical pattern (error handling, DB access, auth) | Update the relevant package's AGENTS.md patterns section |
| Add a new dependency between packages | Update `docs/architecture.md` module dependency graph |
| Add a generic utility (formatter, parser, normalizer) | Add it to `packages/contracts/src/<topic>.ts`, re-export from `index.ts`, add tests in `packages/contracts/test/<topic>.test.ts`. Update the "Where utilities live" table in this file if introducing a new category. |

**Documentation-only changes do not require a version bump.**

## Roadmap

See `docs/roadmap.md` for the full feature roadmap including competitive analysis, priority matrix, and phased implementation order.
