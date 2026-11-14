# provider-openai

## Purpose

OpenAI adapter — implements `ProviderAdapter` for OpenAI's Responses API using the `web_search` tool (the current GA tool, chosen over the legacy `web_search_preview`; its new knobs — e.g. `filters.allowed_domains` — stay off because allow-listing would defeat measuring who actually gets cited). Extracts cited domains from URL annotations.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `openaiAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `buildTrackedQueryRequest`, `executeTrackedQuery`, `parseTrackedQueryResponse`, `normalizeResult`, `generateText` |
| `src/types.ts` | OpenAI-specific config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

`openaiAdapter` implements `ProviderAdapter` from `@canonry/canonry-contracts`.

- **`validateConfig(config)`** — require an API key and resolve the model
- **`healthcheck(config, signal?)`** — check connectivity with a short Responses request
- **`executeTrackedQuery(input, config)`** — build the request with `buildTrackedQueryRequest`, make the SDK call, and read it with `parseTrackedQueryResponse`
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(prompt, config)`** — general-purpose text generation

Retrieval contract: every tracked query runs `search-required-v1` (`OPENAI_RETRIEVAL_CONTRACT` in `src/normalize.ts`): verbatim query, no `instructions`, `tool_choice: "required"` with `web_search` as the only tool. Adding any other tool to that request makes `required` stop forcing a search, so it is a contract change. `retrievalStatus` is read from `web_search_call` output items; a missing/empty output or an unfinished response without a search call is `unknown`, never `not-used`. Details and the history of the mislabelled `native-auto-v1` rows: `docs/providers/openai.md` → "Retrieval contract".

OpenAI Responses API runs and `cdp:chatgpt` runs measure separate surfaces. The [browser adapter](../provider-cdp/AGENTS.md) captures answers and citations from a Chrome session.

- **Answer anchors for competitor auto-aliases.** `extractAnchoredSpans` (`src/anchored-spans.ts`) reads a stored response's `url_citation` annotations. The annotation span is the citation chip itself, so the window is the text before it on the same line (from the previous annotation's end at most); offsets are UTF-16, which `String.slice` counts. Stored data only; it never resolves a URL.

## Common Mistakes

- Return grounding sources in the shared `GroundingSource` format.
- **Not handling rate limits** — implement retry with exponential backoff for 429 responses.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/openai.md` — OpenAI-specific API quirks
- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition

## Test ownership

- `test/base-url.test.ts` drives the real Responses SDK through the adapter for proxy, unset, empty and prefixed URLs.
- `test/tracked-query-request.test.ts` independently pins request bytes and full sync/batch result projections, including captured model disclosures and the SDK-only `output_text` field.
- `test/web-search-retrieval.test.ts` owns response-driven retrieval and stored-response reconstruction; malformed and unfinished results remain distinct from a completed no-search answer.
