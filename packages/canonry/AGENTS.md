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
| `src/commands/skills.ts` | `installSkills` / `listSkills` — copies bundled `skills/<name>/` trees into a user's `.claude/skills/<name>/` and creates relative `.codex/skills/<name>` symlinks. Auto-invoked by `canonry init` when cwd looks like a project. |
| `src/cli-commands/skills.ts` | CLI specs for `skills list` / `skills install [skill...] [--dir <path>] [--client claude\|codex\|all] [--force]`. |
| `scripts/copy-agent-assets.ts` | Build-time mirror of repo-root `skills/` into `assets/agent-workspace/skills/` so trees ship in the published package. |
| `src/client.ts` | `ApiClient` class + `createApiClient()` factory |
| `src/mcp/` | `canonry-mcp` stdio adapter over `createApiClient()` |
| `src/mcp/server.ts` | `createCanonryMcpServer` — registers all API tools, then disables non-core tiers unless `--eager` |
| `src/mcp/tool-registry.ts` | All API tools (62 in v1.3, including `canonry_report`), each tagged with a `tier` (`core` or one of the toolkit names) |
| `src/mcp/toolkits.ts` | Toolkit catalog (`monitoring`, `setup`, `gsc`, `ga`, `agent`) — name, title, description, when-to-load |
| `src/mcp/dynamic-catalog.ts` | `DynamicToolCatalog` — drives `canonry_help` and `canonry_load_toolkit` (enables tools, emits `tools/list_changed`) |
| `src/mcp/cli.ts` | `canonry-mcp` stdio entrypoint — parses `--read-only`, `--eager`, `--scope`, plus `CANONRY_MCP_*` env |
| `src/server.ts` | Fastify server setup — mounts api-routes, serves SPA, registers providers |
| `src/job-runner.ts` | In-process job runner for visibility sweeps |
| `src/provider-registry.ts` | `ProviderRegistry` — manages provider adapters |
| `src/scheduler.ts` | Cron-based schedule runner |
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
| `src/commands/traffic.ts` | Server-side traffic commands: `traffic connect cloud-run` (writes SA key to `~/.canonry/config.yaml`, creates a `traffic_sources` row), `traffic sync` (pulls Cloud Logging, classifies, upserts hourly buckets + samples), `traffic backfill` (async one-shot: replays the last `--days` of logs, replaces hourly buckets in the window with current classifier output — capped at the upstream retention ceiling, polls via `--wait` or returns runId for `canonry runs get`), `traffic sources` / `traffic status` (list connections + last-24h totals), and `traffic events` (windowed crawler / AI-referral rollups with `--kind`, `--source`, `--since-minutes`, `--until`, `--limit` filters). |
| `src/cloud-run-config.ts` | Helpers for `cloudRun:` connection block in `~/.canonry/config.yaml` (mirrors `ga4-config.ts` / `google-config.ts`). |
| `src/commands/backlinks.ts` | Backlinks commands: `backlinks install`, `doctor`, `status`, `sync`, `list`, `extract`, `releases`, `cache prune` |
| `src/commoncrawl-sync.ts` | `executeReleaseSync` — workspace-level Common Crawl release download + DuckDB query job |
| `src/backlink-extract.ts` | `executeBacklinkExtract` — per-project backlink extraction run |
| `src/discovery-run.ts` | `executeDiscoveryRun` — fires `executeDiscovery` (api-routes orchestrator) with Gemini-backed seed/embed/probe deps, writes the `discovery.basket-divergence` insight, and hands off to `RunCoordinator.onRunCompleted` so Aero wakes up with a bucket-count payload. |
| `src/commands/discover.ts` | Discovery commands: `discover run` (kick off ICP → seed → embed → probe pipeline), `discover seed` (alias for run today; the phase split is a later PR), `discover list` (sessions newest-first), `discover show` / `discover probe` (session detail with per-query probes), `discover promote preview` (read-only preview of bucketed queries + recurring suggested competitor domains), `discover promote` (adopt a completed session's cited + aspirational queries plus recurring competitors into the project by default — add-only, idempotent, with `--bucket` / `--no-competitors` scoping). |
| `src/cli-commands/discover.ts` | CLI specs for `discover run / seed / probe / list / show / promote preview / promote`. |
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

### ApiClient usage

**Always use `createApiClient()`** — never instantiate `ApiClient` directly:

```typescript
import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient() // handles basePath, config loading automatically
}
```

All `ApiClient` methods must return typed DTOs from `@ainyc/canonry-contracts`. Never cast responses with `as Record<string, unknown>`.

### MCP adapter

`canonry-mcp` is the only MCP executable. It is allowed only as a stdio adapter over `createApiClient()` and must not import DB modules, API routes, job runners, CLI command dispatch, telemetry, or loggers. It must never write to stdout except MCP protocol frames. Add tools only when the same capability already exists through the public API/CLI, and keep input schemas tied to `packages/contracts` Zod schemas.

### Command output

All commands that produce output must support `--format json` for machine-parseable output. Use the format flag to switch between human-friendly tables and JSON.

### Run completion pipeline

When a sweep finishes, the flow is: `JobRunner` → `RunCoordinator.onRunCompleted()` → `IntelligenceService.analyzeAndPersist()` then `Notifier.onRunCompleted()`. The coordinator runs intelligence first (synchronous) so insights are persisted before webhooks fire. Each subscriber is wrapped in an independent try/catch — one failing must not block the others.

`IntelligenceService` reads query snapshots from the DB, calls the pure analysis functions in `packages/intelligence/`, and persists insights + health snapshots. It also provides `backfill()` for reprocessing historical runs chronologically.

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
