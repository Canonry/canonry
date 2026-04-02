# config

## Purpose

Typed environment and configuration parsing. Single-file package that provides `loadConfig()` for reading `~/.canonry/config.yaml` and environment variables into a strongly-typed config object.

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Everything — config schema (Zod), `loadConfig()`, `saveConfigPatch()`, env var mapping |

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
