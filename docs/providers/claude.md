# Claude Provider Design

## Role

`packages/provider-claude` sends tracked queries to the Anthropic Messages API with web search. Canonry uses the answer text for mentions and the answer citations for cited domains.

## Provider Contract

### `validateConfig(config: ClaudeConfig): ClaudeHealthcheckResult`

Checks for a nonempty API key and returns the resolved model. The adapter accepts the `claude-` prefix and falls back to its default for other prefixes. For a model that rejects forced `tool_choice`, the message identifies `native-auto-v1`. See [Retrieval contract](#retrieval-contract).

### `healthcheck(config: ClaudeConfig, signal?: AbortSignal): Promise<ClaudeHealthcheckResult>`

Makes a lightweight Anthropic API call to verify the key works. Returns ok/error with a message.

### `executeTrackedQuery(input: ClaudeTrackedQueryInput): Promise<ClaudeRawResult>`

Sends the unchanged query to the Anthropic Messages API with `web_search_20250305` (`max_uses: 5`). A requested location goes in the tool's `user_location`. The adapter sends no system prompt. The model's [retrieval contract](#retrieval-contract) selects `tool_choice`. The result includes these fields.

- `rawResponse` — the full Anthropic API response (content blocks, usage metadata)
- `groundingSources` — extracted `{ uri, title }` pairs from final `text.citations` entries of type `web_search_result_location`
- `searchQueries` — search queries extracted from `server_tool_use` blocks where `name === 'web_search'`
- `model` — the model used (default: `claude-sonnet-4-6`)
- `retrievalStatus` — `used` when the response carries a `web_search` `server_tool_use` block, `not-used` when the response is intact and has none, `unknown` when the content is empty or absent
- `retrievalContract` — the search policy the request was built under (below)

### `normalizeResult(raw: ClaudeRawResult): ClaudeNormalizedResult`

Extracts analyst-relevant fields from the raw response:

- `answerText` — concatenated text from `text` content blocks
- `citedDomains` — unique domains from the final answer's web citations (`www.` stripped)
- `groundingSources` — pass-through of `{ uri, title }` pairs
- `searchQueries` — pass-through of search queries used
- `retrievalStatus` — re-read from the stored response, as in `executeTrackedQuery`

## Retrieval contract

Every Claude snapshot stores `retrieval_contract`, the search policy of the request that produced it. The model decides the contract, and the contract decides `tool_choice`, so a stored row always describes the request that was sent. The rule lives in one place: `CLAUDE_MODELS_REJECTING_FORCED_TOOL_CHOICE` and `claudeRetrievalContractForModel` in `packages/provider-claude/src/normalize.ts`. `buildTrackedQueryRequest` applies it and `parseTrackedQueryResponse` records it, so a batch line ([batch mode](../batch-mode.md)) sends the same `tool_choice` and stores the same contract as the sync call for that model.

| Models | Contract | `tool_choice` | Retrieval |
|--------|----------|---------------|-----------|
| Every other `claude-*` model, including the default | `search-required-v1` | `{ "type": "tool", "name": "web_search" }` | Required by the API control |
| `claude-opus-5-5`, `claude-fable-5-1`, `claude-mythos-5-1` | `native-auto-v1` | `{ "type": "auto" }` | Claude decides; not guaranteed |

Under `native-auto-v1`, Claude decides whether the query needs a search. Canonry still measures mentions in the answer text when Claude skips retrieval. Under `search-required-v1`, the request requires a `web_search` call.

Anthropic documents that Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1 return HTTP 400 for a forced `tool_choice` (`any` or `tool`): `tool_choice: type "tool" and "any" are not supported for this model.` ([Forcing tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use), [error reference](https://platform.claude.com/docs/en/api/errors#forced-tool-use-not-supported)). Those models run `native-auto-v1`: the same query, the same tool and no system prompt, with the search left to Claude. This is also what the adapter sent before `search-required-v1` existed.

On these models, visibility numbers can include answers written without a search. Two fields keep that visible:

- `retrieval_contract = native-auto-v1` shows that retrieval was not required.
- `retrieval_status = not-used` marks answers with an intact response and no search call. Frozen measurement comparisons exclude these answers from their cited denominator and keep them in their mention denominator.

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
