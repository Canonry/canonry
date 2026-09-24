# Claude Provider Design

## Role

`packages/provider-claude` is one of three answer-visibility provider adapters (alongside Gemini and OpenAI). It queries the Anthropic Messages API with web search enabled to determine which domains are cited in AI-generated answers for tracked queries.

## Provider Contract

### `validateConfig(config: ClaudeConfig): ClaudeHealthcheckResult`

Validates that the config has a non-empty API key. Returns the model name that will be used. Every `claude-*` model is accepted. For a model that rejects forced `tool_choice` (see [Retrieval contract](#retrieval-contract)) the message says that tracked queries run under `native-auto-v1` and that retrieval is not guaranteed.

### `healthcheck(config: ClaudeConfig): Promise<ClaudeHealthcheckResult>`

Makes a lightweight Anthropic API call to verify the key works. Returns ok/error with a message.

### `executeTrackedQuery(input: ClaudeTrackedQueryInput): Promise<ClaudeRawResult>`

Sends the query to the Anthropic Messages API with `web_search_20250305` tool enabled (`max_uses: 5`). The query is sent as-is, with no system prompt. `tool_choice` depends on the model's [retrieval contract](#retrieval-contract). Returns:

- `rawResponse` — the full Anthropic API response (content blocks, usage metadata)
- `groundingSources` — extracted `{ uri, title }` pairs from final `text.citations` entries of type `web_search_result_location`
- `searchQueries` — search queries extracted from `server_tool_use` blocks where `name === 'web_search'`
- `model` — the model used (default: `claude-sonnet-4-6`)
- `retrievalStatus` — `used` when the response carries a `web_search` `server_tool_use` block, `not-used` when the response is intact and has none, `unknown` when the content is empty or absent
- `retrievalContract` — the search policy the request was built under (below)

### `normalizeResult(raw: ClaudeRawResult): ClaudeNormalizedResult`

Extracts analyst-relevant fields from the raw response:

- `answerText` — concatenated text from `text` content blocks
- `citedDomains` — unique domains extracted from web search result URLs (www. stripped)
- `groundingSources` — pass-through of `{ uri, title }` pairs
- `searchQueries` — pass-through of search queries used
- `retrievalStatus` — re-read from the stored response, as in `executeTrackedQuery`

## Retrieval contract

Every Claude snapshot stores `retrieval_contract`, the search policy of the request that produced it. The model decides the contract, and the contract decides `tool_choice`, so a stored row always describes the request that was sent. The rule lives in one place: `CLAUDE_MODELS_REJECTING_FORCED_TOOL_CHOICE` and `claudeRetrievalContractForModel` in `packages/provider-claude/src/normalize.ts`.

| Models | Contract | `tool_choice` | Retrieval |
|--------|----------|---------------|-----------|
| Every other `claude-*` model, including the default | `search-required-v1` | `{ "type": "tool", "name": "web_search" }` | Required by the API control |
| `claude-opus-5-5`, `claude-fable-5-1`, `claude-mythos-5-1` | `native-auto-v1` | `{ "type": "auto" }` | Claude decides; not guaranteed |

Claude decides for itself whether a query needs a search, and newer models search less often. An answer written without retrieval stores zero cited domains and zero mentions, so at rest it looks like a searched answer that did not cite the brand. `search-required-v1` prevents that by forcing the `web_search` call instead of adding a system prompt, which would also steer tone and source choice.

Anthropic documents that Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1 return HTTP 400 for a forced `tool_choice` (`any` or `tool`): `tool_choice: type "tool" and "any" are not supported for this model.` ([Forcing tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use), [error reference](https://platform.claude.com/docs/en/api/errors#forced-tool-use-not-supported)). Those models run `native-auto-v1`: the same query, the same tool and no system prompt, with the search left to Claude. This is also what the adapter sent before `search-required-v1` existed.

On these models, visibility numbers can include answers written without a search. Two fields keep that visible:

- `retrieval_contract = native-auto-v1` shows that retrieval was not required.
- `retrieval_status = not-used` marks each answer that did not search, so it is not read as a real miss.

A trend that spans a model switch between the two groups also spans a change of contract, and the rows show where it happened.

The list contains exact model ids from Anthropic's documentation. It does not match family prefixes: `claude-opus-5` and `claude-fable-5` still accept forcing. If a model that rejects forcing is missing from the list, its tracked queries fail with the 400 above, so no row records the wrong contract. Add an id only after Anthropic documents it.

## Model

Default: `claude-sonnet-4-6`. Configurable via `ClaudeConfig.model`.

## Web Search & Citation Detection

The provider uses Anthropic's **web search** tool (`web_search_20250305`). When enabled, the Messages API:

1. Executes web searches via `server_tool_use` blocks (with `name: 'web_search'` and `input.query`)
2. Returns search results in `web_search_tool_result` content blocks
3. Generates a text response whose `text.citations` identify which results actually support the final answer

Citation detection works by extracting domains from the final answer's `text.citations`, not from every raw search result returned by the tool. Tool-result error payloads such as `too_many_requests` and `max_uses_exceeded` are treated as provider failures rather than silent misses.

### Upstream references

- Web search tool docs: <https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool>
- Messages SDK types: <https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts>

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
  "searchQueries": ["query related search"],
  "apiResponse": { "content": [...] }
}
```

## Implementation Status

Live Anthropic API calls implemented with Messages API web search. The `@anthropic-ai/sdk` SDK is used for API communication.
