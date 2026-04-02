# canonry

## Purpose

The publishable npm package (`@ainyc/canonry`). Bundles the CLI, local Fastify server, in-process job runner, provider registry, scheduler, and pre-built SPA. This is what users install with `npm install -g @ainyc/canonry`.

## Key Files

| File | Role |
|------|------|
| `src/cli.ts` | CLI entry point — shebang, telemetry, command dispatch |
| `src/cli-commands.ts` | `REGISTERED_CLI_COMMANDS` array — declarative command specs |
| `src/commands/` | Command implementations (24 files, one per domain) |
| `src/client.ts` | `ApiClient` class + `createApiClient()` factory |
| `src/server.ts` | Fastify server setup — mounts api-routes, serves SPA, registers providers |
| `src/job-runner.ts` | In-process job runner for visibility sweeps |
| `src/provider-registry.ts` | `ProviderRegistry` — manages provider adapters |
| `src/scheduler.ts` | Cron-based schedule runner |
| `src/snapshot-service.ts` | Snapshot creation and diff logic |

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

### Provider registration

Providers are registered at server startup in `server.ts`. Each provider adapter (from `packages/provider-*`) is imported and added to the `ProviderRegistry`. Projects reference providers by name.

## Common Mistakes

- **Instantiating `ApiClient` directly** — use `createApiClient()` which handles basePath and config.
- **Casting API responses** — use typed DTOs from contracts, not `as { ... }`.
- **Forgetting `--format json` support** — every output command needs it.
- **Forgetting to register command in `cli-commands.ts`** — the command won't be accessible.

## See Also

- `packages/api-routes/` — the route handlers this server mounts
- `packages/contracts/` — DTOs returned by the API client
- `docs/architecture.md` — how CLI, server, and job runner interact
