# provider-claude

## Purpose

The Claude adapter uses Anthropic's Messages API with `web_search_20250305`. It extracts cited domains from the final answer's `text.citations`.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `claudeAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `buildTrackedQueryRequest`, `executeTrackedQuery`, `parseTrackedQueryResponse`, `normalizeResult`, `generateText` |
| `src/batch.ts` | `claudeBatch` — the Message Batches capability (`adapter.batch`): submit/poll/results/cancel. Retries are canonry's (SDK `maxRetries: 0`); a submit is retried only on a 429, and its error is `definite` only when nothing was sent or the provider answered a 4xx other than 408/409 |
| `src/types.ts` | Claude-specific config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

`claudeAdapter` implements `ProviderAdapter` from `@canonry/canonry-contracts`.

- **`validateConfig(config)`** — require an API key and resolve the model
- **`healthcheck(config, signal?)`** — check connectivity with a short Messages request
- **`executeTrackedQuery(input, config)`** — build the request with `buildTrackedQueryRequest`, make the SDK call, and read it with `parseTrackedQueryResponse`
  - Batch dispatch shares both functions. Change the request in the builder and the response handling in the parser.
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(prompt, config)`** — general-purpose text generation

- **Answer anchors for competitor auto-aliases.** `extractAnchoredSpans` (`src/anchored-spans.ts`) pairs each `web_search_result_location` citation URL with its cited text block plus the last line of the uncited block before it (where `**Name** -` usually sits). `cited_text` and `title` are the source page's words and are never read. Stored data only.

## Retrieval contract

Each tracked query records `retrievalContract`. `claudeRetrievalContractForModel(model)` in `src/normalize.ts` picks it, and `tool_choice` comes from the contract, so the stored contract always describes the request that was sent. Models in `CLAUDE_MODELS_REJECTING_FORCED_TOOL_CHOICE` return 400 for a forced `tool_choice`, so they run `native-auto-v1` (`tool_choice: auto`). Every other model runs `search-required-v1` (forced `web_search`). Details: `docs/providers/claude.md` → "Retrieval contract".

## Common Mistakes

- **Adding a per-model request rule outside the contract table** — model-specific `tool_choice` behavior goes in `CLAUDE_MODELS_REJECTING_FORCED_TOOL_CHOICE` (exact ids from Anthropic's docs, no family-prefix guesses) so the request and the recorded contract cannot disagree.
- Return grounding sources in the shared `GroundingSource` format.
- **Not handling rate limits** — implement retry with exponential backoff for 429 responses.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/claude.md` — Claude-specific API quirks
- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
