# provider-perplexity

## Purpose

The Perplexity adapter uses the Agent API (`POST /v1/agent`). It extracts domains from search results, fetched pages, and message annotations. See `docs/providers/perplexity.md`.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `perplexityAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `buildTrackedQueryRequest`, `executeTrackedQuery`, `parseTrackedQueryResponse`, `normalizeResult`, `generateText`, plus the Agent and stored-Sonar parsers |
| `test/fixtures/` | Agent API response fixtures (schema-derived, not live captures — see its README) |
| `src/types.ts` | Perplexity-specific config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

`perplexityAdapter` implements `ProviderAdapter` from `@canonry/canonry-contracts`.

- **`validateConfig(config)`** — require an API key and resolve the model
- **`healthcheck(config, signal?)`** — check connectivity with a short Agent API request
- **`executeTrackedQuery(input, config)`** — build the request with `buildTrackedQueryRequest`, make the SDK call, and read it with `parseTrackedQueryResponse`
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(prompt, config)`** — general-purpose text generation

- **Answer anchors for competitor auto-aliases.** `extractAnchoredSpans` (in `src/normalize.ts`, next to the parsers it reuses) pairs each `[N]` marker group with the text before it on the same line: Agent responses resolve N to the `search_results` entry with `id` N (ids run on across items), Sonar history to `citations[N - 1]`. Stored data only.

## Rules

- **The Agent API is strict.** Any unknown request field, top-level or nested, is a 400. Send only fields in `PerplexityAgentRequest` (`src/types.ts`).
- **Branch on `status`, not the HTTP code.** Failed and cancelled runs return HTTP 200.
- **Keep the Sonar parser.** Stored rows are Sonar Chat Completions; `reparseStoredResult` dispatches on the `output` array.
- **Retired model ids resolve in one table.** Add a rename or retirement to `PROVIDER_MODEL_ALIASES` in `packages/contracts/src/models.ts`, never inline here, and keep `validationPattern` accepting every key (a test pins it). Mirror registry changes in `apps/api/src/app.ts`.

## Common Mistakes

- Return grounding sources in the shared `GroundingSource` format.
- **Not handling rate limits** — implement retry with exponential backoff for 429 responses.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition

## Test ownership

`tracked-query-request.test.ts` owns native SDK request delivery, complete public
sync/batch result projections, and served identity. `agent-api.test.ts` owns
Agent output parsing, retrieval, run-status errors, health and text generation.
`normalize.test.ts` owns historical Sonar and stored-envelope compatibility.
HTTP support only records SDK requests and serves independent literal bodies;
fixtures remain schema-derived examples, not live provider captures.
