# provider-claude

## Purpose

Claude/Anthropic adapter — implements `ProviderAdapter` for Anthropic's Messages API using the `web_search_20250305` tool. Extracts cited domains from search result blocks.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `claudeAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `executeTrackedQuery`, `normalizeResult`, `generateText` |
| `src/types.ts` | Claude-specific config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

All provider packages follow the same 4-file structure and implement the same `ProviderAdapter` interface from `@ainyc/canonry-contracts`:

- **`validateConfig(config)`** — verify API key and model are valid
- **`healthcheck(config)`** — test connectivity to the provider
- **`executeTrackedQuery(input)`** — send a tracked query and capture raw response with web search results
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(config, prompt)`** — general-purpose text generation

## Retrieval contract

Each tracked query records `retrievalContract`. `claudeRetrievalContractForModel(model)` in `src/normalize.ts` picks it, and `tool_choice` comes from the contract, so the stored contract always describes the request that was sent. Models in `CLAUDE_MODELS_REJECTING_FORCED_TOOL_CHOICE` return 400 for a forced `tool_choice`, so they run `native-auto-v1` (`tool_choice: auto`). Every other model runs `search-required-v1` (forced `web_search`). Details: `docs/providers/claude.md` → "Retrieval contract".

## Common Mistakes

- **Adding a per-model request rule outside the contract table** — model-specific `tool_choice` behavior goes in `CLAUDE_MODELS_REJECTING_FORCED_TOOL_CHOICE` (exact ids from Anthropic's docs, no family-prefix guesses) so the request and the recorded contract cannot disagree.
- **Not normalizing grounding sources to standard `CitedSource` format** — each provider returns different shapes.
- **Not handling rate limits** — implement retry with exponential backoff for 429 responses.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/claude.md` — Claude-specific API quirks
- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
