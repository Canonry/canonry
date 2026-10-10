# provider-gemini

## Purpose

Gemini adapter — implements `ProviderAdapter` for Google's Gemini API using the `googleSearch` grounding tool. Extracts cited domains from grounding metadata.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `geminiAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Core logic: `validateConfig`, `healthcheck`, `buildTrackedQueryRequest`, `executeTrackedQuery`, `parseTrackedQueryResponse`, `normalizeResult`, `generateText` |
| `src/types.ts` | Gemini-specific config and response types |
| `src/index.ts` | Re-exports public API |

## Patterns

All provider packages follow the same 4-file structure and implement the same `ProviderAdapter` interface from `@ainyc/canonry-contracts`:

- **`validateConfig(config)`** — verify API key and model are valid
- **`healthcheck(config)`** — test connectivity to the provider
- **`executeTrackedQuery(input)`** — send a tracked query and capture raw response with grounding sources
  - It is `buildTrackedQueryRequest` (the exact wire body) → the SDK call → `parseTrackedQueryResponse` (usage and stop reason included). Batch dispatch reuses both halves, so change the request or its reading there, never inline in `executeTrackedQuery`; `test/tracked-query-request.test.ts` pins the built body against the wire.
- **`normalizeResult(raw)`** — convert provider-specific response to standard `NormalizedQueryResult`
- **`generateText(config, prompt)`** — general-purpose text generation

The adapter object in `adapter.ts` wires these functions together with metadata (`name`, `displayName`, `mode`, `keyUrl`).

Retrieval status comes from the first candidate's nonempty search queries or web chunks (`used`). A completed nonempty answer without search evidence is `not-used`; empty or unfinished responses remain `unknown`. The request contract remains `native-auto-v1`. `test/tracked-query-request.test.ts` covers sync, batch parsing, and historical response reconstruction.

- **Answer anchors for competitor auto-aliases.** `extractAnchoredSpans` (`src/anchored-spans.ts`) pairs each grounding support's `segment.text` with the site of every chunk it cites: `web.title` (the source domain), since `web.uri` is a Vertex redirect that is never resolved. Segment offsets are UTF-8 bytes and `startIndex` is omitted when 0, so they are never used to slice. Stored data only.

## Common Mistakes

- **Not normalizing grounding sources to standard `CitedSource` format** — each provider returns different shapes. Normalization must extract domain, URL, and title consistently.
- **Not handling rate limits** — implement retry with exponential backoff for 429 responses.
- **Forgetting to export from `adapter.ts`** — the provider registry imports the adapter object.

## See Also

- `docs/providers/gemini.md` — Gemini-specific API quirks and grounding source behavior
- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition

## Test ownership

Native adapter/SDK wire, credential-file OAuth, endpoint routing, stored-response projection and served identity are owned by `test/base-url.test.ts` and `test/tracked-query-request.test.ts`. `test/embeddings.test.ts` exercises the real SDK with independent HTTP payloads and literal defaults/errors/order. Keep public batch build/parse and historical reparse contracts; constructor internals and injected embedding clients are not production interfaces.
