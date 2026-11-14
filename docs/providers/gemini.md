# Gemini Provider Design

## Role

`packages/provider-gemini` sends tracked queries to Gemini with Google Search grounding. Canonry uses the answer text for mentions and grounding sources for cited domains.

## Provider Contract

### `validateConfig(config: GeminiConfig): GeminiHealthcheckResult`

Checks for an AI Studio API key or a Vertex AI project ID. It returns the resolved model.

### `healthcheck(config: GeminiConfig, signal?: AbortSignal): Promise<GeminiHealthcheckResult>`

Sends a short generation request to the configured backend without Google Search. It returns the result and a message.

### `executeTrackedQuery(input: GeminiTrackedQueryInput): Promise<GeminiRawResult>`

Sends the query to Gemini with the `googleSearch` tool enabled. The query is sent as-is aside from optional location context. Returns:

- `rawResponse` — selected Gemini response fields, including candidate content, grounding metadata, usage, and the reported model version
- `groundingSources` — `{ uri, title }` pairs from supported chunks, or all grounding chunks when the response has no usable support mapping
- `searchQueries` — the web search queries Gemini used internally
- `model` — the model used (default: `gemini-flash-latest`)

### `normalizeResult(raw: GeminiRawResult): GeminiNormalizedResult`

Extracts analyst-relevant fields from the raw response:

- `answerText` — concatenated text from the first candidate's parts
- `citedDomains` — unique domains extracted from grounding source URIs (www. stripped)
- `groundingSources` — pass-through of `{ uri, title }` pairs
- `searchQueries` — pass-through of search queries used

## Model

Default: `gemini-flash-latest`, Google's alias for the newest Flash model (2 weeks' email notice before a breaking change behind it). The served model is recorded per snapshot as `servedModel`, so trends show when it moved. Pin an exact ID such as `gemini-3.8-flash` for a fixed model. Google limits the 2.5 models to projects that already used them. Configurable via `GeminiConfig.model`.

Model dropdowns recommend general-purpose Flash and Pro models from the shared curated catalog, intersected with the provider's live list when available. Specialist models do not become default suggestions simply because they support `generateContent`. You can still enter a custom model ID. The recommendations follow Google's [model descriptions](https://ai.google.dev/gemini-api/docs/models) and [search-grounding guidance](https://ai.google.dev/gemini-api/docs/google-search); they are not an exhaustive capability list.

## Custom Endpoint

Optional. Set `GeminiConfig.baseUrl` — via the `GEMINI_BASE_URL` env var or `providers.gemini.baseUrl` in `~/.canonry/config.yaml` — to route requests through a proxy or gateway in front of the Gemini API. It maps to the SDK's `httpOptions.baseUrl` and applies to both AI Studio (API key) and Vertex AI auth. When unset, the SDK uses its default endpoint. The same `baseUrl` is threaded into discovery's embeddings client (`embedQueries` → the native SDK), so a proxy captures both tracked-query sweeps and discovery embeddings. A path-prefix base URL (e.g. `https://proxy/gemini`) is preserved — the SDK appends the API path to it rather than swapping only the host.

In Vertex AI mode, use a proxy that accepts Vertex AI request paths such as `/v1beta1/projects/.../locations/...`.

## Grounding & Citation Detection

The provider uses Gemini's built-in **Google Search grounding** (`googleSearch` tool). When enabled, Gemini:

1. Searches the web for information relevant to the query
2. Returns grounding metadata with retrieved chunks and support mappings
3. Includes the search queries it used

Citation detection uses the chunk indices in `groundingSupports`. When the first candidate has no valid support indices, the adapter falls back to its grounding chunks.

The adapter records retrieval separately from citations. A positive `usageMetadata.toolUsePromptTokenCount`, nonempty `webSearchQueries`, or a web source URI marks retrieval as `used`. Without that evidence, `not-used` requires a nonempty answer that ends with `STOP` and a prompt count from 1 to 60 tokens. Other responses remain `unknown`. The adapter applies the same rules to stored responses. Under `native-auto-v1`, Gemini chooses whether to search.

**Searches without grounding metadata.** Gemini 3.5 and 3.6 never report `toolUsePromptTokenCount`; they count search input as prompt tokens instead. A few of their answers run a search yet return no `groundingMetadata`, and the prompt count is the only trace. In stored answers, a query alone took at most 20 prompt tokens, and every Gemini 3.5 or 3.6 answer that listed its searches took 95 or more. So a completed answer with no grounding metadata and a prompt count above 60, or no count at all, is `unknown`: the evidence suggests a search but does not record one. Recording it as `not-used` would read as an answer written from memory and drop it from cited-rate denominators. Its `searchQueries` stay empty and `usage.searchCount` stays 0, since only listed queries are counted.

Two limits follow from reading the prompt size. A query long enough to pass 60 tokens on its own (around 200 characters with a location clause) reads `unknown` even when Gemini did not search. And a model that counts search input nowhere hides such a search completely: Gemini 3 Flash Preview reported some of its listed searches with a 5-token prompt and no tool-result tokens.

### Upstream references

- Grounding with Google Search docs: <https://ai.google.dev/gemini-api/docs/google-search>
- GenAI JS SDK types: <https://github.com/googleapis/js-genai/blob/main/src/types.ts>

### Domain extraction

- Canonry extracts hosts from valid source URIs and removes the `www.` prefix and duplicate hosts.
- For a Vertex grounding redirect, Canonry reads a URL in the decoded path or falls back to a domain in the source title.

## Quota Defaults

- max 2 in-flight requests per workspace
- 10 requests per minute
- 1000 requests per day

Quota policy is passed via `GeminiConfig.quotaPolicy` but enforcement is handled by the job runner (not the provider itself).

## Retry Policy

Retry:

- `429`
- timeouts
- `5xx`

The adapter makes at most four attempts. Its default retry delays are one, two, and four seconds, without jitter. If Gemini supplies `RetryInfo.retryDelay` of at most 65 seconds, Canonry waits that delay plus 500 milliseconds. Daily quota errors and requests for longer delays fail immediately.

## Data Stored per Snapshot

The job runner stores the following in `query_snapshots.raw_response` as JSON:

```json
{
  "model": "gemini-2.0-flash",
  "groundingSources": [
    { "uri": "https://example.com/page", "title": "Page Title" }
  ],
  "searchQueries": ["keyword related search"],
  "apiResponse": { "candidates": [...], "usageMetadata": {...} }
}
```

This gives analysts access to:

- Which sources Gemini cited (grounding evidence)
- What search queries Gemini used (search intent)
- The retained API response fields for debugging
- The model version for reproducibility

The stored Gemini payload now preserves `groundingSupports` so historical snapshots can be reparsed with the same citation-selection logic used for live runs.

Older Gemini snapshots can only be fully reprocessed if their stored `apiResponse` already contains `groundingSupports`. If that mapping was discarded in older data, Canonry can only fall back to the retrieved `groundingChunks`.

## API Response

The `GET /runs/:id` endpoint returns snapshots enriched with grounding data:

```json
{
  "id": "...",
  "query": "best dentist brooklyn",
  "citationState": "cited",
  "answerText": "...",
  "citedDomains": ["example.com", "competitor.com"],
  "competitorOverlap": ["competitor.com"],
  "groundingSources": [
    { "uri": "https://example.com/page", "title": "Example" }
  ],
  "searchQueries": ["best dentist brooklyn"],
  "model": "gemini-2.0-flash"
}
```

`competitorOverlap` is a legacy mixed field: a domain can appear because it was named in the answer, linked as a source, or both. Use `citedDomains` and grounding-source hosts for citation claims, and answer text with Canonry's shared matcher for mention claims.

## Implementation Status

Live Gemini API calls implemented with Google Search grounding. The `@google/genai` SDK is used for API communication.
