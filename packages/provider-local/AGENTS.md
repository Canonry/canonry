# provider-local

## Purpose

Local LLM adapter — implements `ProviderAdapter` for any OpenAI-compatible local API endpoint (e.g., Ollama, LM Studio, vLLM). Uses the same request format as OpenAI but targets a user-configured base URL.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `localAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `buildTrackedQueryRequest`, `executeTrackedQuery`, `parseTrackedQueryResponse`, `normalizeResult`, `generateText` |
| `src/types.ts` | Local provider config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

`localAdapter` implements `ProviderAdapter` from `@canonry/canonry-contracts`.

- **`validateConfig(config)`** — require a base URL and resolve the requested model or `llama3`
- **`healthcheck(config, signal?)`** — check connectivity through `GET /models`
- **`executeTrackedQuery(input, config)`** — build the request with `buildTrackedQueryRequest`, make the SDK call, and read it with `parseTrackedQueryResponse`
- **`normalizeResult(raw)`** — convert response to standard `NormalizedQueryResult`
- **`generateText(prompt, config)`** — general-purpose text generation

## Common Mistakes

- Keep `citationMeasurable: false` and `retrievalStatus: 'not-applicable'`. The adapter sends plain chat completions and captures no grounding sources.
- Measure mentions from answer prose. Keep `citedDomains` empty for live Local answers.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/local.md` — local LLM setup and supported backends
- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
