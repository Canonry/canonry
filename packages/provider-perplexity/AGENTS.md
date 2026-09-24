# provider-perplexity

## Purpose

Perplexity adapter — implements `ProviderAdapter` over Perplexity's Agent API (`POST /v1/agent`). Extracts cited domains from the `search_results` output item. Full behavior: `docs/providers/perplexity.md`.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `perplexityAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `executeTrackedQuery`, `normalizeResult`, `generateText`, plus the Agent and stored-Sonar parsers |
| `test/fixtures/` | Agent API response fixtures (schema-derived, not live captures — see its README) |
| `src/types.ts` | Perplexity-specific config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

All provider packages follow the same 4-file structure and implement the same `ProviderAdapter` interface from `@ainyc/canonry-contracts`:

- **`validateConfig(config)`** — verify API key and model are valid
- **`healthcheck(config)`** — test connectivity to the provider
- **`executeTrackedQuery(input)`** — send a tracked query and capture citations
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(config, prompt)`** — general-purpose text generation

## Rules

- **The Agent API is strict.** Any unknown request field, top-level or nested, is a 400. Send only fields in `PerplexityAgentRequest` (`src/types.ts`).
- **Branch on `status`, not the HTTP code.** Failed and cancelled runs return HTTP 200.
- **Keep the Sonar parser.** Stored rows are Sonar Chat Completions; `reparseStoredResult` dispatches on the `output` array.
- **Retired model ids resolve in one table.** Add a rename or retirement to `PROVIDER_MODEL_ALIASES` in `packages/contracts/src/models.ts`, never inline here, and keep `validationPattern` accepting every key (a test pins it). Mirror registry changes in `apps/api/src/app.ts`.

## Common Mistakes

- **Not normalizing grounding sources to standard `CitedSource` format** — each provider returns different shapes.
- **Not handling rate limits** — implement retry with exponential backoff for 429 responses.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
