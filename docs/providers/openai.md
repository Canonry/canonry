# OpenAI Provider Design

## Role

`packages/provider-openai` is one of three answer-visibility provider adapters (alongside Gemini and Claude). It queries the OpenAI Responses API with web search enabled to determine which domains are cited in AI-generated answers for tracked keywords.

## Provider Contract

### `validateConfig(config: OpenAIConfig): OpenAIHealthcheckResult`

Validates that the config has a non-empty API key. Returns the model name that will be used.

### `healthcheck(config: OpenAIConfig): Promise<OpenAIHealthcheckResult>`

Makes a lightweight OpenAI API call to verify the key works. Returns ok/error with a message.

### `executeTrackedQuery(input: OpenAITrackedQueryInput): Promise<OpenAIRawResult>`

Sends the keyword to the OpenAI Responses API with `web_search_preview` tool enabled. The keyword is sent as-is. Returns:

- `rawResponse` — the full OpenAI API response (output items, usage metadata)
- `groundingSources` — extracted `{ uri, title }` pairs from URL citation annotations
- `searchQueries` — web search queries extracted from `web_search_call.action.query` / `action.queries`
- `model` — the model used (default: `gpt-5.4`)

### `normalizeResult(raw: OpenAIRawResult): OpenAINormalizedResult`

Extracts analyst-relevant fields from the raw response:

- `answerText` — concatenated text from `output_text` content items in message outputs
- `citedDomains` — unique domains extracted from URL citation annotations (www. stripped)
- `groundingSources` — pass-through of `{ uri, title }` pairs
- `searchQueries` — pass-through of search queries used

## Model

Default: `gpt-5.4`. Configurable via `OpenAIConfig.model`.

## Web Search & Citation Detection

The provider uses OpenAI's **web search preview** tool (`web_search_preview`). When enabled, the Responses API:

1. Executes web searches relevant to the query (exposed as `web_search_call` output items)
2. Generates a response with inline URL citations
3. URL citations appear as annotations on `output_text` content blocks

Citation detection works by extracting domains from final `output_text.annotations` entries where `type === 'url_citation'`. The provider intentionally does not treat `web_search_call.action.sources` as citations, because those are retrieval/search telemetry rather than final answer citations. The job runner then matches the cited domains against the project's canonical domain and competitor domains to determine citation state.

### Upstream references

- Web search guide: <https://developers.openai.com/api/docs/guides/tools-web-search>
- Responses web search type: <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_function_web_search.py>
- Output text annotation type: <https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_text.py>

### Domain extraction

- URIs are parsed with `new URL()`
- `www.` prefix is stripped
- Duplicates are removed
- Invalid URIs are silently skipped

## Quota Defaults

- max 2 in-flight requests per workspace
- 10 requests per minute
- 1000 requests per day

Quota policy is passed via `OpenAIConfig.quotaPolicy` but enforcement is handled by the job runner (not the provider itself).

## Data Stored per Snapshot

The job runner stores the following in `query_snapshots.raw_response` as JSON:

```json
{
  "model": "gpt-4o",
  "groundingSources": [
    { "uri": "https://example.com/page", "title": "Page Title" }
  ],
  "searchQueries": ["keyword related search"],
  "apiResponse": { "output": [...] }
}
```

## Implementation Status

Phase 2: Live OpenAI API calls implemented with Responses API web search. The `openai` SDK is used for API communication.
