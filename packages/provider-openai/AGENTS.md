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

All provider packages follow the same 4-file structure and implement the same `ProviderAdapter` interface from `@ainyc/canonry-contracts`:

- **`validateConfig(config)`** — verify API key and model are valid
- **`healthcheck(config)`** — test connectivity to the provider
- **`executeTrackedQuery(input)`** — send a tracked query and capture raw response with web search results
  - It is `buildTrackedQueryRequest` (the exact wire body) → the SDK call → `parseTrackedQueryResponse` (usage and stop reason included). Batch dispatch reuses both halves, so change the request or its reading there, never inline in `executeTrackedQuery`; `test/tracked-query-request.test.ts` pins the built body against the wire.
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(config, prompt)`** — general-purpose text generation

Retrieval contract: every tracked query runs `search-required-v1` (`OPENAI_RETRIEVAL_CONTRACT` in `src/normalize.ts`): verbatim query, no `instructions`, `tool_choice: "required"` with `web_search` as the only tool. Adding any other tool to that request makes `required` stop forcing a search, so it is a contract change. `retrievalStatus` is read from `web_search_call` output items; a missing/empty output or an unfinished response without a search call is `unknown`, never `not-used`. Details and the history of the mislabelled `native-auto-v1` rows: `docs/providers/openai.md` → "Retrieval contract".

Note: The OpenAI `web_search` API returns fewer/different results than the ChatGPT UI search. That gap is structural (the API does not carry logged-in user context, conversation history, or personalization) and is addressed separately by a planned browser provider (drive the ChatGPT UI itself), not by switching API tool flavors.

- **Answer anchors for competitor auto-aliases.** `extractAnchoredSpans` (`src/anchored-spans.ts`) reads a stored response's `url_citation` annotations. The annotation span is the citation chip itself, so the window is the text before it on the same line (from the previous annotation's end at most); offsets are UTF-16, which `String.slice` counts. Stored data only; it never resolves a URL.

## Common Mistakes

- **Not normalizing grounding sources to standard `CitedSource` format** — each provider returns different shapes.
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
