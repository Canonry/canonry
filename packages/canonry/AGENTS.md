# canonry

## Purpose

The publishable npm package (`@ainyc/canonry`). Bundles the CLI, local Fastify server, in-process job runner, provider registry, scheduler, and pre-built SPA. This is what users install with `npm install -g @ainyc/canonry`.

## Key Files

| File | Role |
|------|------|
| `src/cli.ts` | CLI entry point — shebang, telemetry, command dispatch |
| `src/cli-commands.ts` | `REGISTERED_CLI_COMMANDS` array — declarative command specs |
| `src/commands/` | Command implementations (one file per domain) |
| `src/client.ts` | `ApiClient` class + `createApiClient()` factory |
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
| `src/agent-webhook.ts` | `AGENT_WEBHOOK_EVENTS` — event list subscribed to by `canonry agent attach` |
| `src/commands/agent.ts` | `agentAttach` / `agentDetach` — wire an external agent's webhook to a project |
| `src/commands/agent-ask.ts` | `agentAsk` — one-shot turn against the built-in Aero agent, streams events to stdout |
| `src/cli-commands/agent.ts` | CLI specs for `agent ask / attach / detach` |
| `src/agent/session.ts` | `createAeroSession` — constructs a pi-agent-core Agent scoped to a canonry project (composes `soul.md` + `SKILL.md` into the system prompt, wires model, tools, API-key resolver) |
| `src/agent/session-registry.ts` | Hybrid session registry — in-memory `Map<project, Agent>` + durable `agent_sessions` row per project. Handles hydration, persistence, follow-up queueing, and post-`agent_end` auto-drain. |
| `src/agent/tools.ts` | 13 canonry-state `AgentTool` definitions — 7 read (`get_status`, `get_health`, `get_timeline`, `get_insights`, `list_keywords`, `list_competitors`, `get_run`) and 6 write (`run_sweep`, `dismiss_insight`, `add_keywords`, `add_competitors`, `update_schedule`, `attach_agent_webhook`) |
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

Tool surface has two layers:
- **Canonry state** (`src/agent/tools.ts`) — 7 read (status/health/timeline/
  insights/keywords/competitors/run detail) + 6 write (run sweep / dismiss
  insight / add keywords / add competitors / update schedule / attach webhook).
  Project name is closed over by `ToolContext` so the LLM can't target the
  wrong project; tools surface their intent via `tool_execution_start` events.
- **Skill docs** (`src/agent/skill-tools.ts`) — 2 tools (`list_skill_docs`,
  `read_skill_doc`) for progressive disclosure of bundled reference playbooks.
  Ride in every scope. `SKILL.md` stays lightweight; detailed playbooks
  (workflows, regression diagnosis, reporting templates, integrations) load
  on-demand via slug.

System prompt is composed from `skills/aero/soul.md` (identity/voice/values)
+ `skills/aero/SKILL.md` (task rules). Soul is prepended so identity frames
the task instructions. Both files ship in `assets/agent-workspace/skills/aero/`.

### External agents (webhook lifecycle)

`canonry agent attach <project> --url <webhook-url>` registers an agent
webhook subscribing to `run.completed`, `insight.critical`, `insight.high`,
`citation.gained`. Idempotent — skipped if one already exists on the project.
`canonry agent detach <project>` removes it.

## See Also

- `packages/api-routes/` — the route handlers this server mounts
- `packages/contracts/` — DTOs returned by the API client
- `docs/architecture.md` — how CLI, server, and job runner interact
