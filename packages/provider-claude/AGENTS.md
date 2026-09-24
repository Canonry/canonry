# provider-claude

## Purpose

Claude/Anthropic adapter — implements `ProviderAdapter` for Anthropic's Messages API using the `web_search_20250305` tool. Extracts cited domains from search result blocks.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `claudeAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `buildTrackedQueryRequest`, `executeTrackedQuery`, `parseTrackedQueryResponse`, `normalizeResult`, `generateText` |
| `src/types.ts` | Claude-specific config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

All provider packages follow the same 4-file structure and implement the same `ProviderAdapter` interface from `@ainyc/canonry-contracts`:

- **`validateConfig(config)`** — verify API key and model are valid
- **`healthcheck(config)`** — test connectivity to the provider
- **`executeTrackedQuery(input)`** — send a tracked query and capture raw response with web search results
  - It is `buildTrackedQueryRequest` (the exact wire body) → the SDK call → `parseTrackedQueryResponse` (usage and stop reason included). Batch dispatch reuses both halves, so change the request or its reading there, never inline in `executeTrackedQuery`; `test/tracked-query-request.test.ts` pins the built body against the wire.
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(config, prompt)`** — general-purpose text generation

## Common Mistakes

- **Not normalizing grounding sources to standard `CitedSource` format** — each provider returns different shapes.
- **Not handling rate limits** — implement retry with exponential backoff for 429 responses.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/claude.md` — Claude-specific API quirks
- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
