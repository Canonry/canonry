# Local LLM Provider Design

## Role

`packages/provider-local` is a provider adapter for local LLMs running an OpenAI-compatible chat completions API. It supports Ollama, LM Studio, llama.cpp, vLLM, and any other server that implements `POST /chat/completions` per the OpenAI spec.

Unlike the cloud providers (Gemini, OpenAI, Claude), local LLMs have no built-in web search. Citation detection is therefore heuristic — the adapter scans the model's answer text for domain mentions rather than reading structured grounding metadata.

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

### `normalizeResult(raw: LocalRawResult): LocalNormalizedResult`

Extracts analyst-relevant fields:

- `answerText` — the first choice's message content
- `citedDomains` — domains extracted from the answer text via heuristic scanning (see below)
- `groundingSources` — pass-through of `[]`
- `searchQueries` — pass-through of `[]`

## Configuration

| Field      | Required | Description                                       |
|------------|----------|---------------------------------------------------|
| `baseUrl`  | Yes      | Base URL of the OpenAI-compatible server, e.g. `http://localhost:11434/v1` |
| `apiKey`   | No       | API key if the server requires one (most local servers do not) |
| `model`    | No       | Model name to use. Default: `llama3`              |

## Citation Detection

Because local LLMs cannot search the web, `citedDomains` is built by scanning the answer text with two patterns:

1. **URL pattern** — matches `https?://example.com/...` and extracts the hostname
2. **Bare domain pattern** — matches tokens like `example.com` adjacent to whitespace or punctuation, for common TLDs (`.com`, `.org`, `.net`, `.io`, `.co`, `.dev`, `.ai`, `.app`, `.edu`, `.gov`, `.health`, `.dental`, `.legal`, `.law`, `.med`)

Both patterns strip `www.` and lowercase the result. Duplicates are removed.

**Reliability caveat:** the extracted domains reflect the model's training data, not a live web search. A model may mention well-known domains regardless of whether they currently rank for the keyword. Treat local provider citation data as a rough signal, not a ground truth.

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
