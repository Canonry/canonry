# Gemini Provider Design

## Role

`packages/provider-gemini` is one of three answer-visibility provider adapters (alongside OpenAI and Claude). It queries the Gemini API with Google Search grounding enabled to determine which domains are cited in AI-generated answers for tracked keywords.

## Provider Contract

### `validateConfig(config: GeminiConfig): GeminiHealthcheckResult`

Validates that the config has a non-empty API key. Returns the model name that will be used.

### `healthcheck(config: GeminiConfig): Promise<GeminiHealthcheckResult>`

Makes a lightweight Gemini API call to verify the key works. Returns ok/error with a message.

### `executeTrackedQuery(input: GeminiTrackedQueryInput): Promise<GeminiRawResult>`

Sends the keyword to Gemini with `google_search_retrieval` tool enabled. The keyword is sent as-is — no prompt engineering wrapping. Returns:

- `rawResponse` — the full Gemini API response (candidates, usage metadata)
- `groundingSources` — extracted `{ uri, title }` pairs from grounding chunks
- `searchQueries` — the web search queries Gemini used internally
- `model` — the model used (default: `gemini-2.0-flash`)

### `normalizeResult(raw: GeminiRawResult): GeminiNormalizedResult`

Extracts analyst-relevant fields from the raw response:

- `answerText` — concatenated text from all candidate parts
- `citedDomains` — unique domains extracted from grounding source URIs (www. stripped)
- `groundingSources` — pass-through of `{ uri, title }` pairs
- `searchQueries` — pass-through of search queries used

## Model

Default: `gemini-2.0-flash`. Configurable via `GeminiConfig.model`.

## Grounding & Citation Detection

The provider uses Gemini's built-in **Google Search grounding** (`google_search_retrieval` tool). When enabled, Gemini:

1. Searches the web for information relevant to the query
2. Returns grounding metadata with source URIs and titles
3. Includes the search queries it used

Citation detection works by extracting domains from grounding source URIs. The job runner then matches these against the project's canonical domain and competitor domains to determine citation state.

### Domain extraction

- URIs are parsed with `new URL()`
- `www.` prefix is stripped
- Duplicates are removed
- Invalid URIs are silently skipped

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

With full-jitter exponential backoff up to 4 total attempts. Fail non-429 `4xx` responses immediately.

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
- The full API response for debugging
- The model version for reproducibility

## API Response

The `GET /runs/:id` endpoint returns snapshots enriched with grounding data:

```json
{
  "id": "...",
  "keyword": "best dentist brooklyn",
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

## Implementation Status

Phase 2: Live Gemini API calls implemented with Google Search grounding. The `@google/generative-ai` SDK is used for API communication.
