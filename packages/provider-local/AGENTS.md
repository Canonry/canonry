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

All provider packages follow the same 4-file structure and implement the same `ProviderAdapter` interface from `@ainyc/canonry-contracts`:

- **`validateConfig(config)`** — verify base URL and model are configured
- **`healthcheck(config)`** — test connectivity to the local endpoint
- **`executeTrackedQuery(input)`** — send a tracked query to the local model
  - It is `buildTrackedQueryRequest` (the exact wire body) → the SDK call → `parseTrackedQueryResponse` (usage and stop reason included). Batch dispatch reuses both halves, so change the request or its reading there, never inline in `executeTrackedQuery`; `test/tracked-query-request.test.ts` pins the built body against the wire.
- **`normalizeResult(raw)`** — convert response to standard `NormalizedQueryResult`
- **`generateText(config, prompt)`** — general-purpose text generation

## Common Mistakes

- **Not normalizing grounding sources to standard `CitedSource` format** — local models may not provide web search grounding at all.
- **Deriving citations from answer prose** — a domain written in `answerText` is a mention only. Populate `citedDomains` exclusively from structured grounding sources; mention and citation are independent signals.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/local.md` — local LLM setup and supported backends
- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
