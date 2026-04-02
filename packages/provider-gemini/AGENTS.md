# provider-gemini

## Purpose

Gemini adapter — implements `ProviderAdapter` for Google's Gemini API using the `googleSearch` grounding tool. Extracts cited domains from grounding metadata.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `geminiAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `executeTrackedQuery`, `normalizeResult`, `generateText` |
| `src/types.ts` | Gemini-specific config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

All provider packages follow the same 4-file structure and implement the same `ProviderAdapter` interface from `@ainyc/canonry-contracts`:

- **`validateConfig(config)`** — verify API key and model are valid
- **`healthcheck(config)`** — test connectivity to the provider
- **`executeTrackedQuery(input)`** — send a keyword query and capture raw response with grounding sources
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(config, prompt)`** — general-purpose text generation

The adapter object in `adapter.ts` wires these functions together with metadata (`name`, `displayName`, `mode`, `keyUrl`).

## Common Mistakes

- **Not normalizing grounding sources to standard `CitedSource` format** — each provider returns different shapes. Normalization must extract domain, URL, and title consistently.
- **Not handling rate limits** — implement retry with exponential backoff for 429 responses.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/gemini.md` — Gemini-specific API quirks and grounding source behavior
- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
