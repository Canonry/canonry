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
| `src/agent-bootstrap.ts` | Agent runtime detection, installation, profile setup, gateway config, credential resolution, workspace seeding |
| `src/agent-manager.ts` | Agent gateway process lifecycle — spawns the gateway as a detached process, loads `.env` into process env |
| `src/commands/agent.ts` | Thin orchestrator for `agent setup` + implementations for `status/start/stop/reset` |
| `src/cli-commands/agent.ts` | CLI command specs for the `agent` subcommand family |

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

## Agent setup flow

`canonry agent setup` is the single entry point. The orchestrator in `commands/agent.ts` calls helpers from `agent-bootstrap.ts`:

1. **Init canonry** — calls `initCommand()` if no `config.yaml` exists. Prompts for monitoring provider keys and agent LLM credentials (provider, key, model). Accepts all values via flags or env vars for non-interactive use.
2. **Detect/install agent runtime** — checks PATH, installs the pinned agent runtime if missing, enforces Canonry's pinned Node floor of `>=22.14.0`, and verifies that the detected binary version matches the pinned package version.
3. **Save agent config** — persists `{binary, profile, gatewayPort}` to canonry `config.yaml` via `saveConfigPatch()`.
4. **Initialize profile** — initializes the agent profile in local mode, non-interactively.
5. **Configure gateway** — sets the local mode and gateway port.
6. **Configure LLM** — `resolveAgentCredentials()` resolves key from flags/env/existing `.env`. `writeAgentEnv()` writes to the agent env file. The model is set via the agent CLI.
7. **Seed workspace** — copies skills from `assets/agent-workspace/` into the agent workspace.

At runtime, `AgentManager.start()` spawns the agent gateway as a detached process, injecting `.env` values into the process environment.

### Agent webhook lifecycle

`canonry agent attach <project>` registers an agent webhook notification for the named project (subscribes to `run.completed`, `insight.critical`, `insight.high`, `citation.gained`). Idempotent — checks for an existing agent webhook before creating. `canonry agent detach <project>` removes the agent webhook. When `config.agent.autoStart` is true, the server auto-attaches webhooks to newly created/applied projects via the `onProjectUpserted` callback.

## See Also

- `packages/api-routes/` — the route handlers this server mounts
- `packages/contracts/` — DTOs returned by the API client
- `docs/architecture.md` — how CLI, server, and job runner interact
