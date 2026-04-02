# provider-openai

## Purpose

OpenAI adapter — implements `ProviderAdapter` for OpenAI's Responses API using the `web_search_preview` tool. Extracts cited domains from URL annotations.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `openaiAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `executeTrackedQuery`, `normalizeResult`, `generateText` |
| `src/types.ts` | OpenAI-specific config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

All provider packages follow the same 4-file structure and implement the same `ProviderAdapter` interface from `@ainyc/canonry-contracts`:

- **`validateConfig(config)`** — verify API key and model are valid
- **`healthcheck(config)`** — test connectivity to the provider
- **`executeTrackedQuery(input)`** — send a keyword query and capture raw response with web search results
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(config, prompt)`** — general-purpose text generation

Note: The OpenAI `web_search_preview` API returns fewer/different results than the ChatGPT UI search.

## Common Mistakes

- **Not normalizing grounding sources to standard `CitedSource` format** — each provider returns different shapes.
- **Not handling rate limits** — implement retry with exponential backoff for 429 responses.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/openai.md` — OpenAI-specific API quirks
- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
