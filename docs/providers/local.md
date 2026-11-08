# Local LLM Provider Design

## Role

`packages/provider-local` is a provider adapter for local LLMs running an OpenAI-compatible chat completions API. It supports Ollama, LM Studio, llama.cpp, vLLM, and any other server that implements `POST /chat/completions` per the OpenAI spec.

Unlike the cloud providers (Gemini, OpenAI, Claude), local LLMs have no built-in web search, so their answers carry no sources. Canonry measures a local answer's **mention** (the brand or domain in the answer text) and records its **citation** as not measured. See [Citations](#citations).

## Provider Contract

### `validateConfig(config: LocalConfig): LocalHealthcheckResult`

Validates that `baseUrl` is present and non-empty. Returns the model name that will be used (default: `llama3`).

### `healthcheck(config: LocalConfig): Promise<LocalHealthcheckResult>`

Calls `GET /models` on the configured endpoint to verify connectivity. Returns ok/error with the number of models detected. Does not require a specific model to be present.

### `executeTrackedQuery(input: LocalTrackedQueryInput): Promise<LocalRawResult>`

Sends a chat completion request to the local server with a system prompt instructing the model to include domain names in its answer. Returns:

- `rawResponse` — the full chat completions API response
- `groundingSources` — always `[]` (local LLMs have no structured grounding)
- `searchQueries` — always `[]`
- `model` — the model name used
- `retrievalStatus` — `not-applicable`: there is no retrieval step to report
- `citationMeasurable` — `false`: with no sources, whether the answer cites a domain is never observed

### `normalizeResult(raw: LocalRawResult): LocalNormalizedResult`

Extracts analyst-relevant fields:

- `answerText` — the first choice's message content
- `citedDomains` — always `[]`: a domain written in the answer text is a mention, never a citation
- `groundingSources` — pass-through of `[]`
- `searchQueries` — pass-through of `[]`
- `citationMeasurable` — `false`, as above

## Configuration

| Field      | Required | Description                                       |
|------------|----------|---------------------------------------------------|
| `baseUrl`  | Yes      | Base URL of the OpenAI-compatible server, e.g. `http://localhost:11434/v1` |
| `apiKey`   | No       | API key if the server requires one (most local servers do not) |
| `model`    | No       | Model name to use. Default: `llama3`              |

## Citations

A local model cannot search the web, so its answers have no source links and a citation can never be observed. The sweep stores `citation_state = 'not-measured'` for every local answer (`determineCitationState` in `packages/canonry/src/citation-utils.ts` reads the adapter's `citationMeasurable: false`). Every citation figure leaves these answers out of both the cited count and its denominator, and the API, CLI, MCP and dashboard show them as "Not measured", never "not cited".

Answers recorded before `not-measured` existed are not rewritten, and `readCitationState` (`packages/contracts/src/citation-measurement.ts`) reads every stored Local row as not measured, whatever it holds. The adapter has never returned a source link, and its older rows were stored three ways:

- Until #871 (2026-07-28) it filled `citedDomains` with domains written in the answer text, so a row could hold `cited`. A domain written in prose is a mention, never a source link.
- Until migration 112 (2026-07-30) rows held `not-cited` with no retrieval status.
- After that, `not-cited` with `retrieval_status = 'not-applicable'`.

Reading all of them the same way keeps one method across a Local series, so a trend, comparison or run diff that spans the upgrade never mixes rows that counted as misses with rows that are not measured.

The answer text is still checked for the brand and the project's domains, so local answers count toward mention rates like any other engine. The system prompt asks the model to write domain names, which helps that match. A local model answers from its training data, not a live search, so treat its mentions as a rough signal.

## Model

Default: `llama3`. Configurable via `LocalConfig.model`. Any model name accepted by the local server can be used — the adapter passes the value directly to the completions request.

## Quota Defaults

- max 2 in-flight requests per workspace
- 10 requests per minute
- 1000 requests per day

Quota policy is passed via `LocalConfig.quotaPolicy` but enforcement is handled by the job runner.

## Data Stored per Snapshot

The job runner stores the following in `query_snapshots.raw_response` as JSON:

```json
{
  "model": "llama3",
  "groundingSources": [],
  "searchQueries": [],
  "apiResponse": {
    "id": "...",
    "choices": [{ "message": { "role": "assistant", "content": "..." } }],
    "usage": { "prompt_tokens": 42, "completion_tokens": 180 }
  }
}
```

## Implementation Status

Live local LLM calls implemented using the `openai` npm package pointed at a configurable `baseUrl`. Cloud API keys are not required.
