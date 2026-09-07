# config

## Purpose

Typed environment parsing and the dashboard config schema. `loadConfig()` and
`saveConfigPatch()` live in `packages/canonry/src/config.ts`; `loadConfig()`
validates the optional dashboard block with this package's schema.

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | `dashboardConfigSchema` (including optional `managedSweeps`), `getPlatformEnv()`, `getBootstrapEnv()` |

## Patterns

- **Config source priority**: Environment variables override `config.yaml` values.
- **`loadConfig()`**: Returns a fully validated config object. Used by CLI commands (via `createApiClient()`) and the server.
- **`saveConfigPatch()`**: Merges partial updates into `~/.canonry/config.yaml`.
- **Base path**: `CANONRY_BASE_PATH` env var and `basePath` in config.yaml are merged into `apiUrl`.

## Common Mistakes

- **Reading env vars directly instead of using `loadConfig()`** — the config module handles validation and defaults.
- **Storing secrets in the database** — credentials belong in `~/.canonry/config.yaml`.

## See Also

- `packages/contracts/src/config-schema.ts` — Zod schemas for config validation
- `packages/canonry/src/client.ts` — `createApiClient()` uses `loadConfig()`
