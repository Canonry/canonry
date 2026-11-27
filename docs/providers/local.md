# Local LLM Provider Design

## Role

`packages/provider-local` is a provider adapter for local LLMs running an OpenAI-compatible chat completions API. It supports Ollama, LM Studio, llama.cpp, vLLM, and any other server that implements `POST /chat/completions` per the OpenAI spec.

Canonry sends plain chat completions to the configured server without a web search tool. It measures **mentions** of the brand or domain in the answer text. See [Citations](#citations) for how Canonry records citation state.

## Provider Contract

### `validateConfig(config: LocalConfig): LocalHealthcheckResult`

Validates that `baseUrl` is present and non-empty. Returns the model name that will be used (default: `llama3`).

### `healthcheck(config: LocalConfig, signal?: AbortSignal): Promise<LocalHealthcheckResult>`

Calls `GET /models` on the configured endpoint to check connectivity. The check counts up to five model entries and accepts any successful response.

### `executeTrackedQuery(input: LocalTrackedQueryInput): Promise<LocalRawResult>`

Sends a chat completion with a system message that asks for domain names. The user message includes the tracked query and any requested location. The result includes these fields.

- `rawResponse` — the full chat completions API response
- `groundingSources` — always `[]`
- `searchQueries` — always `[]`
- `model` — the model name used

### `normalizeResult(raw: LocalRawResult): LocalNormalizedResult`

Extracts analyst-relevant fields:

- `answerText` — the first choice's message content
- `citedDomains` — always `[]`: a domain written in the answer text is a mention, never a citation
- `groundingSources` — pass-through of `[]`
- `searchQueries` — pass-through of `[]`

### Adapter (`adapter.ts`)

`localAdapter` wraps these functions in the shared provider contract: it takes a `TrackedQueryInput` and returns a `RawQueryResult` and a `NormalizedQueryResult`. The functions above set neither of these fields; the wrapper adds both to each result:

- `retrievalStatus` — `not-applicable`: there is no retrieval step to report
- `citationMeasurable` — `false`: with no sources, whether the answer cites a domain is never observed

## Configuration

| Field      | Required | Description                                       |
|------------|----------|---------------------------------------------------|
| `baseUrl`  | Yes      | Base URL of the OpenAI-compatible server, e.g. `http://localhost:11434/v1` |
| `apiKey`   | No       | API key if the server requires one (most local servers do not) |
| `model`    | No       | Model name to use. Default: `llama3`              |

## Citations

The Local adapter captures no structured sources. The sweep stores `citation_state = 'not-measured'` for each local answer. Citation figures exclude these answers from the cited count and denominator. The API, CLI, MCP, and dashboard identify them as not measured.

Answers recorded before `not-measured` existed are not rewritten, and `readCitationState` (`packages/contracts/src/citation-measurement.ts`) reads every stored Local row as not measured, whatever it holds. The adapter has never returned a source link, and its older rows were stored three ways:

- Until #871 (2026-07-28) it filled `citedDomains` with domains written in the answer text, so a row could hold `cited`. A domain written in prose is a mention, never a source link.
- Until migration 112 (2026-07-30) rows held `not-cited` with no retrieval status.
- After that, `not-cited` with `retrieval_status = 'not-applicable'`.

Reading all of them the same way keeps one method across a Local series, so a trend, comparison or run diff that spans the upgrade never mixes rows that counted as misses with rows that are not measured.

Research runs on Local follow the same rule. Each answer reads `citationState: null` with `citationMeasured: false`, whatever its row stored. The CLI prints `n/m` and the dashboard shows "Not measured".

Canonry checks the answer text for the brand and the project's domains. Local answers count toward mention rates.

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
