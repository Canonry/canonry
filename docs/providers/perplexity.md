# Perplexity Provider Design

## Role

`packages/provider-perplexity` is an answer-visibility provider adapter for Perplexity Sonar. It uses Perplexity's OpenAI-compatible Chat Completions surface to determine which domains are cited in AI-generated answers for tracked keywords.

## Provider Contract

### `validateConfig(config: PerplexityConfig): PerplexityHealthcheckResult`

Validates that the config has a non-empty API key. Returns the model name that will be used.

### `executeTrackedQuery(input: PerplexityTrackedQueryInput): Promise<PerplexityRawResult>`

Sends the keyword to Perplexity's Sonar API. Returns:

- `rawResponse` — the full Perplexity API response
- `groundingSources` — extracted `{ uri, title }` pairs from `search_results` when present, otherwise from `citations`
- `searchQueries` — always empty because Perplexity does not document returned search-query telemetry
- `model` — the model used (default: `sonar`)

### `normalizeResult(raw: PerplexityRawResult): PerplexityNormalizedResult`

Extracts analyst-relevant fields from the raw response:

- `answerText` — `choices[0].message.content`
- `citedDomains` — unique domains extracted from grounding source URIs
- `groundingSources` — pass-through of `{ uri, title }` pairs
- `searchQueries` — pass-through of provider-returned search queries, which is currently `[]`

## Search Results & Citation Detection

Perplexity's OpenAI-compatibility docs describe two relevant response fields:

1. `search_results` — the richer source objects with `title`, `url`, and `date`
2. `citations` — the cited URL list used in the response

Canonry prefers `search_results` for `groundingSources` because it preserves titles, and falls back to `citations` when `search_results` are absent. Canonry does not synthesize `searchQueries`, because Perplexity's documented response structure does not include returned search-query telemetry.

### Upstream references

- OpenAI compatibility docs: <https://docs.perplexity.ai/docs/sonar/openai-compatibility>

## Data Stored per Snapshot

The job runner stores the following in `query_snapshots.raw_response` as JSON:

```json
{
  "model": "sonar",
  "groundingSources": [
    { "uri": "https://example.com/page", "title": "Page Title" }
  ],
  "searchQueries": [],
  "apiResponse": {
    "choices": [...],
    "search_results": [...],
    "citations": [...]
  }
}
```

## Implementation Status

Phase 2: Live Perplexity API calls implemented through the OpenAI-compatible Chat Completions interface.
