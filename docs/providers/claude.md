# Claude Provider Design

## Role

`packages/provider-claude` is one of three answer-visibility provider adapters (alongside Gemini and OpenAI). It queries the Anthropic Messages API with web search enabled to determine which domains are cited in AI-generated answers for tracked keywords.

## Provider Contract

### `validateConfig(config: ClaudeConfig): ClaudeHealthcheckResult`

Validates that the config has a non-empty API key. Returns the model name that will be used.

### `healthcheck(config: ClaudeConfig): Promise<ClaudeHealthcheckResult>`

Makes a lightweight Anthropic API call to verify the key works. Returns ok/error with a message.

### `executeTrackedQuery(input: ClaudeTrackedQueryInput): Promise<ClaudeRawResult>`

Sends the keyword to the Anthropic Messages API with `web_search_20250305` tool enabled (`max_uses: 5`). The keyword is sent as-is. Returns:

- `rawResponse` — the full Anthropic API response (content blocks, usage metadata)
- `groundingSources` — extracted `{ uri, title }` pairs from `web_search_tool_result` blocks
- `searchQueries` — search queries extracted from `server_tool_use` blocks where `name === 'web_search'`
- `model` — the model used (default: `claude-sonnet-4-20250514`)

### `normalizeResult(raw: ClaudeRawResult): ClaudeNormalizedResult`

Extracts analyst-relevant fields from the raw response:

- `answerText` — concatenated text from `text` content blocks
- `citedDomains` — unique domains extracted from web search result URLs (www. stripped)
- `groundingSources` — pass-through of `{ uri, title }` pairs
- `searchQueries` — pass-through of search queries used

## Model

Default: `claude-sonnet-4-20250514`. Configurable via `ClaudeConfig.model`.

## Web Search & Citation Detection

The provider uses Anthropic's **web search** tool (`web_search_20250305`). When enabled, the Messages API:

1. Executes web searches via `server_tool_use` blocks (with `name: 'web_search'` and `input.query`)
2. Returns search results in `web_search_tool_result` content blocks containing `web_search_result` items with URLs and titles
3. Generates a text response synthesizing the search results

Citation detection works by extracting domains from the search result URLs in `web_search_tool_result` blocks. The job runner then matches these against the project's canonical domain and competitor domains to determine citation state.

### Domain extraction

- URIs are parsed with `new URL()`
- `www.` prefix is stripped
- Duplicates are removed
- Invalid URIs are silently skipped

## Quota Defaults

- max 2 in-flight requests per workspace
- 10 requests per minute
- 1000 requests per day

Quota policy is passed via `ClaudeConfig.quotaPolicy` but enforcement is handled by the job runner (not the provider itself).

## Data Stored per Snapshot

The job runner stores the following in `query_snapshots.raw_response` as JSON:

```json
{
  "model": "claude-sonnet-4-20250514",
  "groundingSources": [
    { "uri": "https://example.com/page", "title": "Page Title" }
  ],
  "searchQueries": ["keyword related search"],
  "apiResponse": { "content": [...] }
}
```

## Implementation Status

Phase 2: Live Anthropic API calls implemented with Messages API web search. The `@anthropic-ai/sdk` SDK is used for API communication.
