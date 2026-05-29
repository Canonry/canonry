# canonry

## Purpose

The publishable npm package (`@ainyc/canonry`). Bundles the CLI, local Fastify server, in-process job runner, provider registry, scheduler, and pre-built SPA. This is what users install with `npm install -g @ainyc/canonry`.

## Key Files

| File | Role |
|------|------|
| `src/cli.ts` | CLI entry point — shebang, telemetry, command dispatch |
| `src/telemetry.ts` | `trackEvent`, source attribution, per-process `sessionId`, `cli.upgraded` detection |
| `src/run-telemetry.ts` | `classifyRunError`, `buildRunCompletedProps` — keeps the `run.completed` payload composition in one spot |
| `src/setup-state.ts` | `buildSetupState` — `{ provider_count, has_keywords, project_count, is_first_run }` snapshot ridden on every `cli.command` |
| `src/cli-commands.ts` | `REGISTERED_CLI_COMMANDS` array — declarative command specs |
| `src/commands/` | Command implementations (one file per domain) |
| `src/commands/competitor.ts` | Competitor commands: `competitor add`, `remove`/`delete`, `list` |
| `src/commands/query.ts` | Query commands: `query add`, `replace`, `remove`/`delete`, `list`, `import`, `generate` |
| `src/commands/mcp.ts` | MCP client install helpers: `mcp install`, `mcp config` (writes to client config files only — separate from the `canonry-mcp` stdio bin) |
| `src/mcp-clients.ts` | Registry of supported MCP clients (Claude Desktop, Cursor, Codex) — config-path resolvers and format hints used by `mcp install`/`mcp config` |
| `src/commands/skills.ts` | `installSkills` / `listSkills` — reconciles bundled `skills/<name>/` trees into a user's `.claude/skills/<name>/` **additively** (missing files copied without `--force`; upstream-updated files the operator never touched refreshed; genuine local edits preserved and reported as conflicts unless `--force`), writes a `.canonry-skill-manifest.json` recording what canonry last wrote, and creates relative `.codex/skills/<name>` symlinks. `getBundledSkillSnapshots()` exposes the bundled version + per-file hashes for the `agent.skills.current` doctor check. Auto-invoked by `canonry init` when cwd looks like a project. |
| `src/cli-commands/skills.ts` | CLI specs for `skills list` / `skills install [skill...] [--dir <path>] [--client claude\|codex\|all] [--force]`. |
| `scripts/copy-agent-assets.ts` | Build-time mirror of repo-root `skills/` into `assets/agent-workspace/skills/` so trees ship in the published package. |
| `src/client.ts` | `ApiClient` class + `createApiClient()` factory |
| `src/mcp/` | `canonry-mcp` stdio adapter over `createApiClient()` |
| `src/mcp/server.ts` | `createCanonryMcpServer` — registers all API tools, then disables non-core tiers unless `--eager` |
| `src/mcp/tool-registry.ts` | All API tools (97, including `canonry_report` and `canonry_gbp_places`), each tagged with a `tier` (`core` or one of the toolkit names) |
| `src/mcp/toolkits.ts` | Toolkit catalog (`monitoring`, `setup`, `gsc`, `ga`, `agent`) — name, title, description, when-to-load |
| `src/mcp/dynamic-catalog.ts` | `DynamicToolCatalog` — drives `canonry_help` and `canonry_load_toolkit` (enables tools, emits `tools/list_changed`) |
| `src/mcp/cli.ts` | `canonry-mcp` stdio entrypoint — parses `--read-only`, `--eager`, `--scope`, plus `CANONRY_MCP_*` env |
| `src/server.ts` | Fastify server setup — mounts api-routes, serves SPA, registers providers |
| `src/job-runner.ts` | In-process job runner for visibility sweeps |
| `src/provider-registry.ts` | `ProviderRegistry` — manages provider adapters |
| `src/scheduler.ts` | Cron-based schedule runner (kinds: `answer-visibility`, `traffic-sync`, `data-refresh`; the `onDataRefreshRequested` callback fans out to every connected integration) |
| `src/data-refresh.ts` | `refreshAllIntegrations` — fires GSC + Bing + GA + GBP syncs for a project via the in-process API client, `Promise.allSettled` for per-integration isolation. Wired to the scheduler's `data-refresh` kind in `server.ts`. |
| `src/snapshot-service.ts` | Snapshot creation and diff logic |
| `src/intelligence-service.ts` | Runs analysis after sweeps, persists insights + health snapshots |
| `src/run-coordinator.ts` | Post-run orchestrator — dispatches to intelligence + notifications |
| `src/commands/insights.ts` | `insights` and `insights dismiss` command implementations |
| `src/commands/health-cmd.ts` | `health` command implementation |
| `src/commands/doctor.ts` | `canonry doctor` — runs the doctor check registry via `ApiClient.runDoctor` |
| `src/cli-commands/doctor.ts` | CLI spec for `canonry doctor [--project <name>] [--check <id>...]` |
| `src/commands/backfill.ts` | Historical recomputation for answer visibility fields and insights |
| `src/commands/report.ts` | `runReportCommand` — `canonry report <project>` — fetches `/report` JSON, renders self-contained HTML to disk via `renderReportHtml` from `@ainyc/canonry-api-routes` |
| `src/cli-commands/report.ts` | CLI spec for `canonry report <project> [--output <path>] [--format json]` |
| `src/commands/ga.ts` | GA4 commands: `ga sync`, `ga traffic`, `ga status`, `ga social-referral-history`, `ga social-referral-summary`, `ga attribution` |
| `src/commands/gbp.ts` | Google Business Profile commands: `gbp connect` / `disconnect`, `gbp accounts` (list the accounts the OAuth user can access — pick one per project), `gbp locations` (list / discover / select / deselect; `discover --account <accounts/{n}>` targets a specific account, `--switch-account` opts into the destructive re-point), and Phase 2 performance + local signals: `gbp sync` (fires the `gbp-sync` run; `--wait` polls to terminal), `gbp metrics` (stored daily metrics, totals-by-metric), `gbp keywords` (stored search-keyword impressions over the synced `periodStart`..`periodEnd` window with `<N` threshold rendering + thresholded %), `gbp place-actions` (booking / reservation / order CTAs per location with the preferred-CTA flag), `gbp lodging` (latest hotel-attribute snapshot per location — populated-group count + sync time), `gbp places` (latest Places-API rendered-listing snapshot per location with the server-derived `amenities` list — the GBP-vs-public-listing cross-reference, #648), `gbp summary` (composite scorecard over the project's SELECTED locations: performance totals + recent-vs-prior 7d deltas, keyword coverage, place-action CTA presence, lodging completeness — all numbers come from `GET /gbp/summary`, the command only renders). Reviews are NOT here — the v4 reviews API is separately access-gated by Google; Q&A was retired. |
| `src/gbp-sync.ts` | `executeGbpSync` — per selected location (bounded-concurrency 4) pulls daily metrics + search-keyword impressions + place-action links + the lodging resource. Metrics / keywords / place-actions are range-replaced for the location in one transaction; lodging is **snapshot-on-change** (a new `gbp_lodging_snapshots` row is inserted only when the content hash differs from the latest stored snapshot, so unchanged hotels don't accrue duplicate rows). It also fetches the last `KEYWORD_TREND_MONTHS` (3) **complete** months of per-month keyword impressions (one call per month, since the API aggregates a range into a single figure) and **accumulates** them into `gbp_keyword_monthly` (upsert the fetched months, preserve older in-retention months, prune beyond 18 months) — this is the month-over-month series the `gbp-keyword-drop` insight reads, separate from the range-replaced trailing-window snapshot. `monthMinus` anchors to day 1 before shifting months so 29th–31st syncs don't produce duplicate/skipped months. Non-lodging locations (HTTP 400 → null) are skipped. For lodging locations that carry a Maps `placeId`, when a Places API key is configured (`google.places`) it also fetches Place Details (New) and snapshot-on-changes them into `gbp_place_details` — gated by a refresh-cadence age check (`refreshIntervalDays`, default 7) to control cost, and best-effort (a Places error is logged, never failing the run; #648). Captures per-location errors → run status completed / partial / failed. Run completion flows through `runGbpSync` (server.ts) → `RunCoordinator.onRunCompleted` for both manual and scheduled (`gbp-sync` kind) triggers. |
| `src/commands/traffic.ts` | Server-side traffic commands: `traffic connect cloud-run` / `traffic connect wordpress` / `traffic connect vercel` (write credentials to `~/.canonry/config.yaml`, create a `traffic_sources` row; Vercel connect seeds `lastSyncedAt = NOW` so the first scheduled sync uses a tight window inside Vercel's `request-logs` retention), `traffic sync` (pulls the source's logs, classifies, upserts hourly buckets + samples), `traffic backfill` (async one-shot: replays the last `--days` of logs, replaces hourly buckets in the window with current classifier output — capped at the upstream retention ceiling, polls via `--wait` or returns runId for `canonry runs get`), `traffic reset` (operator recovery: advances `lastSyncedAt` to NOW and clears the error state, used to unstick an idle source whose `lastSyncedAt` has aged past the upstream retention boundary — requires explicit `--advance-to-now` flag), `traffic sources` / `traffic status` (list connections + last-24h totals), and `traffic events` (windowed crawler / AI-referral rollups with `--kind`, `--source`, `--since-minutes`, `--until`, `--limit` filters). |
| `src/cloud-run-config.ts` / `src/wordpress-traffic-config.ts` / `src/vercel-traffic-config.ts` | Helpers for the `cloudRun:` / `wordpressTraffic:` / `vercelTraffic:` connection blocks in `~/.canonry/config.yaml` (each mirrors `ga4-config.ts` / `google-config.ts`). |
| `src/commands/backlinks.ts` | Backlinks commands: `backlinks install`, `doctor`, `status`, `sync`, `list`, `extract`, `releases`, `cache prune` |
| `src/commoncrawl-sync.ts` | `executeReleaseSync` — workspace-level Common Crawl release download + DuckDB query job |
| `src/backlink-extract.ts` | `executeBacklinkExtract` — per-project backlink extraction run |
| `src/discovery-run.ts` | `executeDiscoveryRun` — fires `executeDiscovery` (api-routes orchestrator) with Gemini-backed seed/embed/probe/classifyDomains deps, writes the `discovery.basket-divergence` insight, and hands off to `RunCoordinator.onRunCompleted` so Aero wakes up with a bucket-count payload. Forwards the run's resolved `locations` into `executeDiscovery` → `deps.seed`. `classifyDomains` is one plain-text `generateText` call per session; `buildClassificationPrompt` / `parseClassificationResponse` are exported pure helpers that build the `domain => category` prompt and forgivingly parse the model's reply into a `DiscoveryDomainClassification`. `buildSeedPrompt` / `buildLocationConstraint` are exported pure helpers that build the Gemini seed prompt — when locations are present they geo-constrain the prompt and (for 2+ locations) add a per-area seed quota of `floor(DEFAULT_SEED_COUNT / locationCount)`. |
| `src/commands/discover.ts` | Discovery commands: `discover run` (kick off ICP → seed → embed → probe pipeline; `--locations` geo-constrains seed generation to a project-location subset), `discover seed` (alias for run today; the phase split is a later PR), `discover list` (sessions newest-first), `discover show` / `discover probe` (session detail with per-query probes — competitor domains print with their classified type), `discover promote preview` (read-only preview of bucketed queries + recurring suggested competitor domains of every classified type), `discover promote` (adopt a completed session's cited + aspirational queries plus `direct-competitor` domains into the project by default — add-only, idempotent, with `--bucket` / `--competitor-types` / `--no-competitors` scoping). |
| `src/cli-commands/discover.ts` | CLI specs for `discover run / seed / probe / list / show / promote preview / promote`. `discover run` / `discover seed` accept `--locations` (comma-separated or repeated) to override the project's location set for seeding. |
| `src/agent-webhook.ts` | `AGENT_WEBHOOK_EVENTS` — event list subscribed to by `canonry agent attach` |
| `src/commands/agent.ts` | `agentAttach` / `agentDetach` — wire an external agent's webhook to a project |
| `src/commands/agent-ask.ts` | `agentAsk` — one-shot turn against the built-in Aero agent, streams events to stdout |
| `src/cli-commands/agent.ts` | CLI specs for `agent ask / attach / detach` |
| `src/agent/session.ts` | `createAeroSession` — constructs a pi-agent-core Agent scoped to a canonry project (composes `soul.md` + `SKILL.md` into the system prompt, wires model, tools, API-key resolver) |
| `src/agent/session-registry.ts` | Hybrid session registry — in-memory `Map<project, Agent>` + durable `agent_sessions` row per project. Handles hydration, persistence, follow-up queueing, post-`agent_end` auto-drain, and the `<memory>` hydrate block appended to every new session's system prompt. `acquireForTurn` is async and awaits transcript compaction before returning. |
| `src/agent/memory-store.ts` | CRUD helpers for `agent_memory`: `listMemoryEntries`, `upsertMemoryEntry`, `deleteMemoryEntry`, `loadRecentForHydrate`, `writeCompactionNote`. Enforces the 2 KB value cap and the `compaction:` reserved-prefix rule. |
| `src/agent/compaction.ts` | Transcript compaction — `shouldCompact`, `findSafeSplit` (snaps to user-message boundaries), `runSummaryLlm` (one-shot pi-ai `complete()` call), and `compactMessages` which persists the summary as a `compaction:` memory row and returns the kept suffix. |
| `src/agent/compaction-config.ts` | Tuning constants for compaction — token threshold, target ratio, preserved-tail size, max-messages hard cap. |
| `src/agent/token-counter.ts` | `estimateMessageTokens` / `estimateTranscriptTokens` — chars/4 heuristic handling user/assistant/toolResult content shapes. Used only to decide when to compact, not to enforce provider limits. |
| `src/agent/tools.ts` | Thin wrapper around `mcp-to-agent-tool.ts` — `buildReadTools(ctx)` and `buildAllTools(ctx)` delegate to `buildMcpAgentTools(canonryMcpTools, ctx)`. Adding a new tool to `mcp/tool-registry.ts` automatically exposes it to Aero — no separate registration in this file. |
| `src/agent/mcp-to-agent-tool.ts` | Adapter that converts every `CanonryMcpTool` into a pi-agent-core `AgentTool`. Strips `project` from the LLM-visible schema and injects `ctx.projectName` at call time. `AERO_EXCLUDED_MCP_TOOLS` lists tools that ride the registry but should not reach Aero (e.g. `canonry_agent_clear` — Aero must not erase the operator's transcript). |
| `src/agent/skill-tools.ts` | 2 skill-doc tools (`list_skill_docs`, `read_skill_doc`) — progressive disclosure of bundled reference playbooks. Ride in every scope. |
| `src/agent/skill-paths.ts` | `resolveAeroSkillDir` — finds the on-disk `skills/aero/` (prod/dev/repo candidate paths) for the prompt loader and skill-doc tools |
| `src/agent/agent-routes.ts` | Fastify routes — `GET/DELETE transcript` + `POST prompt` (SSE) for the dashboard Aero bar |
| `src/agent/pi-runtime.ts` | Thin factory re-exporting pi-agent-core types with canonry-scoped construction |

## Patterns

### How to add a CLI command

1. Create or extend a file in `src/commands/` for the domain.
2. Add a command spec to the `REGISTERED_CLI_COMMANDS` array in `src/cli-commands.ts`:
   ```typescript
   { path: ['mycommand', 'subcommand'], usage: 'Description', run: myHandler }
   ```
3. The CLI dispatches based on `path` matching argv.

### ApiClient usage (Critical)

**Always use `createApiClient()`** — never instantiate `ApiClient` directly:

```typescript
import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient() // handles basePath, config loading automatically
}
```

All `ApiClient` methods must return typed DTOs from `@ainyc/canonry-contracts`. Never cast responses with `as Record<string, unknown>`.

**Every `ApiClient` method delegates to the generated SDK via `invoke()`.** Adding a new method is:

```typescript
import { getApiV1ProjectsByNameMyNewThing } from '@ainyc/canonry-api-client'

async myNewThing(name: string): Promise<MyNewDto> {
  return this.invoke<MyNewDto>(() =>
    getApiV1ProjectsByNameMyNewThing({ client: this.heyClient, path: { name } }),
  )
}
```

`invoke()` handles base-path probing, CliError mapping, structured-error envelopes, and the `CANONRY_TRACE=1` request log. **Do not call `fetch()` directly** — ESLint blocks it in `packages/canonry/src/**` except in a handful of files that legitimately hit external HTTP (`telemetry.ts` → telemetry collector, `update-check.ts` → npm registry, `sitemap-parser.ts` → user sitemap, `commands/daemon.ts` → localhost health probe). If you need raw `fetch()` for a NEW external service, add the file to the `ignores` list in `eslint.config.js` with a one-line comment naming the service.

The legacy `request<T>()` raw-fetch wrapper was removed in v4.51; if you find any reference to it, replace with an SDK call through `invoke()`.

### MCP adapter

`canonry-mcp` is the only MCP executable. It is allowed only as a stdio adapter over `createApiClient()` and must not import DB modules, API routes, job runners, CLI command dispatch, telemetry, or loggers. It must never write to stdout except MCP protocol frames. Add tools only when the same capability already exists through the public API/CLI, and keep input schemas tied to `packages/contracts` Zod schemas.

### Command output

All commands that produce output must support `--format json` for machine-parseable output. Use the format flag to switch between human-friendly tables and JSON.

### Run completion pipeline

When a sweep finishes, the flow is: `JobRunner` → `RunCoordinator.onRunCompleted()` → `IntelligenceService.analyzeAndPersist()` then `Notifier.onRunCompleted()`. The coordinator runs intelligence first (synchronous) so insights are persisted before webhooks fire. Each subscriber is wrapped in an independent try/catch — one failing must not block the others.

`IntelligenceService` reads query snapshots from the DB, calls the pure analysis functions in `packages/intelligence/`, and persists insights + health snapshots. It also provides `backfill()` for reprocessing historical runs chronologically.

### Index coverage auto-refresh

`gscUrlInspections` (the index-coverage dashboard's source of truth) is only fully populated by a `inspect-sitemap` run — `gsc-sync` inspects just the top 50 pages by clicks, so newly-added / zero-click URLs silently fall out of coverage. To keep it fresh, `server.ts` chains a full GSC `inspect-sitemap` off the **success** of both `executeGscSync` (`gsc-sync`) and `executeBingInspectSitemap` (`bing-inspect-sitemap` — Bing's coverage sync, which has no separate `bing-sync` kind). The chaining lives in the `onGscSyncRequested` / `onBingInspectSitemapRequested` callbacks, so it covers UI and CLI uniformly (both hit the same endpoints) and the dashboard "Refresh all" button.

`maybeRefreshGscCoverage` (`src/coverage-refresh.ts`) owns the decision: it no-ops when GSC isn't connected for the project (so the Bing → GSC chain is silent on Bing-only projects) and skips when an `inspect-sitemap` run already ran within `COVERAGE_REFRESH_MIN_INTERVAL_MS` (1 h) to stay under the URL Inspection quota (2000/property/day, ~1 req/sec). Its project lookup + spacing guard + run-row insert are synchronous so the GSC and Bing arms of "Refresh all" can't both pass the guard. The chained run is `trigger: scheduled`; a refresh failure is logged, never bubbled into the triggering sync's result.

Both inspection loops (`executeInspectSitemap` and `gsc-sync`'s top-50 pass) drive their `inspectUrl` calls through `inspectUrlsPaced` (`src/gsc-inspect-paced.ts`), which paces ~1 req/sec with jitter, retries transient rate responses with jittered exponential backoff, and trips a consecutive-failure circuit breaker. The endpoint signals per-minute quota pressure with a transient 403 (`PERMISSION_DENIED`-shaped) rather than a 429, so a 403 is treated as a soft, retryable rate signal here while genuine 401/400 stay non-retryable. When the breaker trips, `inspect-sitemap` fails the run (so a quota or property-access outage does not overwrite the coverage snapshot with a misleading all-not-indexed reading), whereas `gsc-sync` logs and continues because its inspection is best-effort secondary work after the search-analytics rows are already persisted.

### Backfill behavior

`canonry backfill answer-visibility` does more than recompute `answerMentioned`. It also reparses stored provider `raw_response` payloads for supported API providers (OpenAI, Claude, Gemini, Perplexity) and refreshes derived snapshot fields such as `citationState`, `citedDomains`, `groundingSources`, and `searchQueries`.

### Provider registration

Providers are registered at server startup in `server.ts`. Each provider adapter (from `packages/provider-*`) is imported and added to the `ProviderRegistry`. Projects reference providers by name.

## Common Mistakes

- **Instantiating `ApiClient` directly** — use `createApiClient()` which handles basePath and config.
- **Casting API responses** — use typed DTOs from contracts, not `as { ... }`.
- **Forgetting `--format json` support** — every output command needs it.
- **Forgetting to register command in `cli-commands.ts`** — the command won't be accessible.

## Agent layer (Aero)

Canonry ships a built-in AI agent called **Aero**, built on
[`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono). Users
who already have their own agent (Claude Code, Codex, custom) can still
consume Canonry through the external-agent webhook.

### Built-in agent (native loop)

- **CLI**: `canonry agent ask <project> "<prompt>"` — one-shot turn. Streams
  `AgentEvent` lines to stdout (or JSON with `--format json`). Supports
  `--provider claude|openai|gemini|zai` and `--model <id>`.
- **Dashboard**: bottom command bar (`AeroBar`) on every project-scoped
  route. SSE-streamed via `POST /api/v1/projects/:name/agent/prompt`.
- **Proactive**: `RunCoordinator` enqueues a synthesized `[system]` follow-up
  into the project's session after every `run.completed`; `SessionRegistry.drainNow`
  wakes the agent unprompted so insights/failures get analyzed without a
  user click.
- **Persistence**: one `agent_sessions` row per project. Transcript + queued
  follow-ups survive `canonry serve` restarts. See `docs/data-model.md`.
- **Memory**: durable project-scoped notes in `agent_memory` (key/value +
  source). Written via `remember` tool (or CLI / API), read via `recall`, and
  the N most-recent rows are injected into every new session's system prompt
  under a `<memory>` block so notes take effect immediately on next session.
  Hydrate is capped at 20 rows / 32 KB, oldest-first truncation. Keys with
  the `compaction:` prefix are reserved for summarized transcript slices.
- **Compaction**: once a transcript crosses `COMPACTION_TOKEN_THRESHOLD` or
  `COMPACTION_MAX_MESSAGES`, `acquireForTurn` awaits a one-shot summarizer
  (`pi-ai` `complete()` on the session's current model) that rolls the
  oldest half of the transcript into a `compaction:<sessionId>:<iso>`
  memory row, removes those messages from `agent.state.messages`, and
  rehydrates the system prompt so the next LLM call sees the summary in
  its `<memory>` block. Splits are snapped to user-message boundaries to
  avoid orphaning tool calls from their results. Concurrent compaction
  runs for the same project dedupe via an in-flight promise map.

Tool surface has two layers:
- **Canonry state** (`src/agent/tools.ts` → `mcp-to-agent-tool.ts`) — every
  tool from `src/mcp/tool-registry.ts` minus the `AERO_EXCLUDED_MCP_TOOLS`
  set, adapted into pi-agent-core `AgentTool`s. The adapter strips the
  top-level `project` property from each tool's JSON schema and injects
  `ctx.projectName` at call time, so the LLM never sees raw project ids and
  cannot target the wrong project. Result: **adding a new tool to the MCP
  registry automatically makes it available to Aero — no second
  registration**. Tool intent surfaces via `tool_execution_start` events.
- **Skill docs** (`src/agent/skill-tools.ts`) — 2 tools (`list_skill_docs`,
  `read_skill_doc`) for progressive disclosure of bundled reference playbooks.
  These stay Aero-only because they read on-disk skill files, not API state.
  Ride in every scope. `SKILL.md` stays lightweight; detailed playbooks
  (workflows, regression diagnosis, reporting templates, integrations) load
  on-demand via slug.

System prompt is composed from `skills/aero/soul.md` (identity/voice/values)
+ `skills/aero/SKILL.md` (task rules). Soul is prepended so identity frames
the task instructions. Both files ship in `assets/agent-workspace/skills/aero/`.
The `<memory>` hydrate block is appended at session-build time by
`SessionRegistry.buildHydratedSystemPrompt` — the DB row keeps the raw
(unhydrated) prompt so every new session sees the latest notes.

### External agents (webhook lifecycle)

`canonry agent attach <project> --url <webhook-url>` registers an agent
webhook subscribing to `run.completed`, `insight.critical`, `insight.high`,
`citation.gained`. Idempotent — skipped if one already exists on the project.
`canonry agent detach <project>` removes it.

## Telemetry events

Anonymous fire-and-forget telemetry, opt-out via `canonry telemetry disable`,
`CANONRY_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, or any truthy `CI` env var.
All events POST to `https://ainyc.ai/api/telemetry` with the following
top-level envelope:

```jsonc
{
  "anonymousId": "uuid-v4",          // stable per-install (~/.canonry/config.yaml)
  "sessionId":   "uuid-v4",          // per-process — same for every event in one CLI invocation / serve boot
  "source":      "cli",              // surface that emitted; see TelemetrySource below
  "sourceContext": "...",            // optional sub-source ("php/8.2 wp-cron")
  "event":       "cli.command",
  "timestamp":   "...",
  "version":     "4.15.0",
  "nodeVersion": "...",
  "os":          "darwin",
  "arch":        "arm64",
  "errorCode":   "NO_PROVIDERS",     // present only when the event represents a failure
  "properties":  { ... }
}
```

### Source taxonomy (`TelemetrySource`)

| Source | When |
|--------|------|
| `cli` | One-shot CLI command (`canonry run`, `canonry status`, …) |
| `cli-server` | Long-running `canonry serve` process (set via `setTelemetrySource('cli-server')` after the server boots, so dashboard/API/scheduler-driven events ride this source) |
| `api` | Reserved — direct API caller (cloud `apps/api`) |
| `mcp-server` | Reserved — `canonry-mcp` stdio adapter (currently forbidden from emitting per `Surface Priority → Agent & automation design principles → MCP adapter boundary`; emission would require a separate adapter) |
| `wp-plugin` | Reserved — WordPress plugin |
| `dashboard` | Reserved — browser-side emissions from `apps/web/` |
| `agent-runtime` | Reserved — Aero / external agent runtimes |

### Event catalog

| Event | Properties | Notes |
|-------|-----------|-------|
| `cli.command` | `{ command, setup_state? }` | Fires on every CLI invocation except `telemetry` and `--help`. `setup_state: { provider_count, has_keywords, project_count, is_first_run }` lets the receiver cohort by configured / not-configured. |
| `cli.init` | `{ providerCount, providers }` | Fires from `canonry init`. |
| `cli.upgraded` | `{ fromVersion, toVersion }` | Fires once when the on-disk `lastSeenVersion` differs from the running build. Suppressed on a fresh install (no prior version recorded). |
| `serve.started` | `{ providerCount, providers }` | Fires after `canonry serve` opens its listener; this is also when `source` flips to `cli-server`. |
| `run.completed` | `{ status, providerCount, providers, queryCount, durationMs, trigger?, domainHash?, phases?, location? }` | `trigger` mirrors `runs.trigger` (`manual` / `scheduled` / `config-apply`). `domainHash` = SHA-256 of the project canonical hostname (no raw domains stored). `phases = { setup_ms, provider_call_ms, total_ms }`. Failures additionally set top-level `errorCode` from `RunErrorCode` (`PROJECT_NOT_FOUND` / `RUN_NOT_FOUND` / `RUN_NOT_EXECUTABLE` / `NO_PROVIDERS` / `QUOTA_EXCEEDED` / `RUN_CANCELLED` / `PROVIDER_ERROR` / `INTERNAL`). |

### Adding a new event

1. Pick a stable `event` name and add it to the catalog above.
2. Call `trackEvent(event, properties, options)` from the originating code path. Pass `options.source` if the default global source is wrong; pass `options.errorCode` for failure events.
3. If the event represents a run/job result, compose the payload through a helper in `src/run-telemetry.ts` (or a sibling) so the shape stays in one place — never inline a new property bag in three call sites.
4. Add tests that assert the new field/event in `packages/canonry/test/telemetry.test.ts` (or a dedicated file like `run-telemetry.test.ts`).
5. Bump the version in both `package.json` files.

## See Also

- `packages/api-routes/` — the route handlers this server mounts
- `packages/contracts/` — DTOs returned by the API client
- `docs/architecture.md` — how CLI, server, and job runner interact
