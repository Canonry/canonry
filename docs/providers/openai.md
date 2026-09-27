# OpenAI Provider Design

## Role

`packages/provider-openai` is one of three answer-visibility provider adapters (alongside Gemini and Claude). It queries the OpenAI Responses API with web search enabled to determine which domains are cited in AI-generated answers for tracked queries.

## Provider Contract

### `validateConfig(config: OpenAIConfig): OpenAIHealthcheckResult`

Validates that the config has a non-empty API key. Returns the model name that will be used.

### `healthcheck(config: OpenAIConfig): Promise<OpenAIHealthcheckResult>`

Makes a lightweight OpenAI API call to verify the key works. Returns ok/error with a message.

### `executeTrackedQuery(input: OpenAITrackedQueryInput): Promise<OpenAIRawResult>`

Sends the query to the OpenAI Responses API with `web_search` as the only tool and `tool_choice: "required"`, so the model must search before it answers (see [Retrieval contract](#retrieval-contract)). The query is sent as-is, with no `instructions`. Returns:

- `rawResponse` — the full OpenAI API response (output items, usage metadata)
- `groundingSources` — extracted `{ uri, title }` pairs from URL citation annotations
- `searchQueries` — web search queries extracted from `web_search_call.action.query` / `action.queries`
- `model` — the model used (default: `gpt-5.4`)
- `retrievalStatus` — whether the response shows a search (see [Retrieval detection](#retrieval-detection))
- `retrievalContract` — always `search-required-v1` (`OPENAI_RETRIEVAL_CONTRACT`)

### `normalizeResult(raw: OpenAIRawResult): OpenAINormalizedResult`

Extracts analyst-relevant fields from the raw response:

- `answerText` — concatenated text from `output_text` content items in message outputs
- `citedDomains` — unique domains extracted from URL citation annotations (www. stripped)
- `groundingSources` — pass-through of `{ uri, title }` pairs
- `searchQueries` — pass-through of search queries used
- `retrievalStatus` — re-derived from the response output when present, otherwise the recorded value

## Retrieval contract

Every snapshot records the search policy its request was built under (`query_snapshots.retrieval_contract`; definitions in `packages/contracts/src/retrieval.ts`). OpenAI runs **`search-required-v1`**: the unmodified query as `input`, no `instructions`, and `tool_choice: "required"` with `web_search` as the only tool. `required` forces a call to *some* tool, so it forces a search only because no other tool is offered; adding a tool to this request changes the contract. It measures a search-grounded answer, not a reproduction of ChatGPT, whose system instructions, routing, and search policy are not public. Claude runs the same contract through `tool_choice: { type: "tool", name: "web_search" }`.

### Retrieval detection

`retrievalStatus` is read from the response, not assumed from the contract:

| Response | `retrievalStatus` |
|---|---|
| any `web_search_call` output item (any action: `search`, `open_page`, `find_in_page`; with or without a query) | `used` |
| `status: "completed"` and no `web_search_call` item | `not-used` (the contract did not hold for this answer) |
| no search call and `status` is `incomplete`, `failed`, or any other unfinished state | `unknown` |
| `output` missing, not an array, or empty | `unknown` |

`unknown` never collapses into `not-used`: only an intact response can prove that no search happened. Under forced search nearly every row reads `used`; that is the contract holding, and a `not-used` row is the visible breach.

### Stored rows labelled `native-auto-v1`

Releases 4.139.0 (the first to record a contract) through 5.19.0 labelled OpenAI rows `native-auto-v1` and `retrievalStatus: unknown`, although every one of those releases sent the identical forced-search request above. The label was wrong, not merely old, and left alone it would show a contract change at the upgrade where the method never changed. `canonry backfill answer-visibility` corrects those rows: `native-auto-v1` becomes `search-required-v1`, and the status is re-derived from the stored `apiResponse` (left `unknown` when no payload was stored). It reports the count as `retrievalRelabeled`, touches no other provider, and never moves a row already on `search-required-v1`. Rows with a NULL contract predate the field and stay NULL: early releases wrapped the query in a search prompt, so those rows were not all built one way.

## Model

Default: `gpt-5.4`. Configurable via `OpenAIConfig.model`.

## Custom Endpoint

Optional. Set `OpenAIConfig.baseUrl` — via the `OPENAI_BASE_URL` env var or `providers.openai.baseUrl` in `~/.canonry/config.yaml` — to route requests through a proxy or gateway in front of the OpenAI API. It maps to the SDK's `baseURL`. When unset, the SDK uses its default endpoint (`https://api.openai.com/v1`).

## Web Search & Citation Detection

The provider uses OpenAI's **web search** tool (`web_search`, the current GA tool — released 2025-08-26 in the SDK as `web_search_2025_08_26`). When enabled, the Responses API:

1. Executes web searches relevant to the query (exposed as `web_search_call` output items)
2. Generates a response with inline URL citations
3. URL citations appear as annotations on `output_text` content blocks

Citation detection works by extracting domains from final `output_text.annotations` entries where `type === 'url_citation'`. The provider intentionally does not treat `web_search_call.action.sources` as citations, because those are retrieval/search telemetry rather than final answer citations. The job runner then matches the cited domains against the project's canonical domain and competitor domains to determine citation state.

We deliberately do **not** set the new `web_search` tool's `filters.allowed_domains` — Canonry tracks who actually gets cited across the open web, so allow-listing would defeat the point. `web_search` (GA) is used over the legacy `web_search_preview` for the same reason: measure the open web as users see it.

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

`retrieval_status` and `retrieval_contract` are separate `query_snapshots` columns, not part of this envelope.

## Implementation Status

Live OpenAI API calls implemented with Responses API web search. The `openai` SDK is used for API communication.
