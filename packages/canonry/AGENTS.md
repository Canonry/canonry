# canonry

## Purpose

The publishable npm package (`@ainyc/canonry`). Bundles the CLI, local Fastify server, in-process job runner, provider registry, scheduler, and pre-built SPA. This is what users install with `npm install -g @ainyc/canonry`.

## Key Files

| File | Role |
|------|------|
| `src/cli.ts` | CLI entry point — shebang, telemetry, command dispatch |
| `src/cli-commands.ts` | `REGISTERED_CLI_COMMANDS` array — declarative command specs |
| `src/commands/` | Command implementations (one file per domain) |
| `src/commands/competitor.ts` | Competitor commands: `competitor add`, `remove`/`delete`, `list` |
| `src/commands/keyword.ts` | Keyword commands: `keyword add`, `replace`, `remove`/`delete`, `list`, `import`, `generate` |
| `src/commands/mcp.ts` | MCP client install helpers: `mcp install`, `mcp config` (writes to client config files only — separate from the `canonry-mcp` stdio bin) |
| `src/mcp-clients.ts` | Registry of supported MCP clients (Claude Desktop, Cursor, Codex) — config-path resolvers and format hints used by `mcp install`/`mcp config` |
| `src/client.ts` | `ApiClient` class + `createApiClient()` factory |
| `src/mcp/` | `canonry-mcp` stdio adapter over `createApiClient()` |
| `src/server.ts` | Fastify server setup — mounts api-routes, serves SPA, registers providers |
| `src/job-runner.ts` | In-process job runner for visibility sweeps |
| `src/provider-registry.ts` | `ProviderRegistry` — manages provider adapters |
| `src/scheduler.ts` | Cron-based schedule runner |
| `src/snapshot-service.ts` | Snapshot creation and diff logic |
| `src/intelligence-service.ts` | Runs analysis after sweeps, persists insights + health snapshots |
| `src/run-coordinator.ts` | Post-run orchestrator — dispatches to intelligence + notifications |
| `src/commands/insights.ts` | `insights` and `insights dismiss` command implementations |
| `src/commands/health-cmd.ts` | `health` command implementation |
| `src/commands/backfill.ts` | Historical recomputation for answer visibility fields and insights |
| `src/commands/ga.ts` | GA4 commands: `ga sync`, `ga traffic`, `ga status`, `ga social-referral-history`, `ga social-referral-summary`, `ga attribution` |
| `src/commands/backlinks.ts` | Backlinks commands: `backlinks install`, `doctor`, `status`, `sync`, `list`, `extract`, `releases`, `cache prune` |
| `src/commoncrawl-sync.ts` | `executeReleaseSync` — workspace-level Common Crawl release download + DuckDB query job |
| `src/backlink-extract.ts` | `executeBacklinkExtract` — per-project backlink extraction run |
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
| `src/agent/tools.ts` | 17 canonry-state `AgentTool` definitions — 9 read (`get_status`, `get_health`, `get_timeline`, `get_insights`, `list_keywords`, `list_competitors`, `get_run`, `recall`, `list_backlinks`) and 8 write (`run_sweep`, `dismiss_insight`, `add_keywords`, `add_competitors`, `update_schedule`, `attach_agent_webhook`, `remember`, `forget`) |
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
- **Canonry state** (`src/agent/tools.ts`) — 9 read (status/health/timeline/
  insights/keywords/competitors/run detail/recall/backlinks) + 8 write
  (run sweep / dismiss insight / add keywords / add competitors /
  update schedule / attach webhook / remember / forget). Project name is
  closed over by `ToolContext` so the LLM can't target the wrong project;
  tools surface their intent via `tool_execution_start` events.
- **Skill docs** (`src/agent/skill-tools.ts`) — 2 tools (`list_skill_docs`,
  `read_skill_doc`) for progressive disclosure of bundled reference playbooks.
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

## See Also

- `packages/api-routes/` — the route handlers this server mounts
- `packages/contracts/` — DTOs returned by the API client
- `docs/architecture.md` — how CLI, server, and job runner interact
