# config

## Purpose

Typed environment parsing and managed-run presentation schemas. `loadConfig()` and
`saveConfigPatch()` live in `packages/canonry/src/config.ts`; `loadConfig()`
validates `dashboard.managedSweeps` and `dashboard.managedRunKinds` without
rewriting the dashboard block. The list uses `schedulableRunKindSchema`.

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | `dashboardManagedRunKindsSchema`, `dashboardManagedSweepsSchema`, `getPlatformEnv()`, `getBootstrapEnv()` |

## Patterns

- **Config source priority**: Environment variables override `config.yaml` values.
- **`loadConfig()`**: Loads config for CLI commands (via `createApiClient()`) and the server. Preserve legacy dashboard fields and their key order; never replace the block with schema parse output. An invalid managed boolean or run-kind list raises a path-qualified `CliError` (exit 1). Missing or blank values leave the opt-in unset.
- **`saveConfigPatch()`**: Merges partial updates into `~/.canonry/config.yaml`.
- **Base path**: `CANONRY_BASE_PATH` env var and `basePath` in config.yaml are merged into `apiUrl`.

## Common Mistakes

- **Reading env vars directly instead of using `loadConfig()`** — the config module handles validation and defaults.
- **Storing secrets in the database** — credentials belong in `~/.canonry/config.yaml`.

## See Also

- `packages/contracts/src/config-schema.ts` — Zod schemas for config validation
- `packages/canonry/src/client.ts` — `createApiClient()` uses `loadConfig()`
