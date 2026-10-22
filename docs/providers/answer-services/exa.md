# Exa Answer

[Exa Answer](https://exa.ai/docs/reference/answer) (`POST https://api.exa.ai/answer`) searches the web and returns an answer with the pages it used. Canonry runs it through the shared [search answer services](../answer-services.md) layer, so everything on that page applies here: it is never selected implicitly, only complete answers are measured, and unknown counts and costs stay unknown.

## Setup

Create a key at [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) and save it once:

```bash
cnry settings provider exa --api-key <key>
```

`EXA_API_KEY` is read by `cnry bootstrap`. Exa documents no free request that proves a key, so a saved key shows as "saved, not verified" until the first real query. Saving a key never sends one.

Then name a profile wherever you choose engines. The bare `exa` connection is not an engine.

```bash
cnry research run my-site --provider exa:standard --query "best roofer in springfield"
cnry project update my-site --provider gemini --provider exa:standard
```

## Profiles

Each profile sends one documented `model` value. Results are stored under the route, so two profiles never share history.

| Route | Exa `model` | Deadline per request | Workflows |
|---|---|---|---|
| `exa:fast` | `exa-fast` | 60 seconds | research, snapshot, visibility sweep |
| `exa:standard` | `exa` (Exa's default) | 120 seconds | research, snapshot, visibility sweep |
| `exa:pro` | `exa-pro` | 180 seconds | research, snapshot, visibility sweep |
| `exa:research` | `exa-research` | 300 seconds | research, snapshot, visibility sweep |

Exa does not publish latency for these models. The deadlines are Canonry's limits, not Exa figures. A request that reaches its deadline is not sent again, because Exa may already have charged for it.

## What is sent

```json
{ "query": "<the tracked query, unchanged>", "model": "exa", "stream": false, "text": false }
```

With a location, Canonry adds `"userLocation": { "country": "US" }`. Exa takes a country and nothing finer, so a city location is stored as `partial` and the row does not claim the answer was measured from that city. No system prompt, output schema or user identifier is sent. Exa documents no query length limit, so queries are never shortened.

## Evidence

| Exa response | Stored as |
|---|---|
| `answer` (text) | The answer. An empty answer is a failed query. |
| `answer` (object) | A failed query. Exa returns an object only for an output schema, which Canonry never sends, and Canonry does not turn it into text. |
| `citations[]` | Sources with the relationship `answer-support`: Exa describes them as the search results used to write the answer, with no markers in the text. They feed cited domains. `title`, `publishedDate` and `id` are mapped; `author`, `image` and `favicon` stay in the raw response. |
| No citations | A complete answer with no sources. Retrieval stays `unknown`, because Exa reports no search events. |
| `costDollars.total` | Cost with the basis `estimated` by the provider. Exa calls it an estimate, not an invoice. The breakdown stays in the raw response. Without `costDollars`, cost is unknown, never zero. |
| `requestId` or the `x-request-id` header | The upstream request id. |
| (nothing) | The served model. Exa's response names no model, so only the requested `model` is recorded and `servedModel` stays empty. Token, search and page-read counts are unknown. |

Exa documents no partial or pending state for a non-streamed answer, so a 200 response is either a complete answer or a failed query.

## Errors and retries

Error bodies carry `requestId`, `error` and `tag`. The failure message keeps Exa's message and tag, and adds a plain explanation for a missing or invalid key (`INVALID_API_KEY`), credits or budget (`NO_MORE_CREDITS`, `API_KEY_BUDGET_EXCEEDED`, `TEAM_BUDGET_EXCEEDED` on HTTP 402) and plan access (`FEATURE_DISABLED`).

Only HTTP 429 and 503 are retried, at most twice, honoring `Retry-After`. Exa documents a 503 as not processed and not billed. HTTP 500 and 504 are not retried, because Exa does not say those requests went unbilled. 400, 401, 402 and 403 need a fix first.

The `exa` connection uses Canonry's default limits (2 at a time, 10 a minute, 1,000 a day), shared by every Exa profile. Change them with `cnry settings provider exa --max-per-minute <n>`.

## Not used

Streaming, `outputSchema`, `systemPrompt`, `text`, coordinates in `userLocation`, Exa's OpenAI compatible interface, `/search`, `/contents`, Agent and Websets are outside this adapter. Fixtures in `packages/provider-answer-services/test/services/exa/` follow Exa's documented response shapes; they were not captured from live responses.
