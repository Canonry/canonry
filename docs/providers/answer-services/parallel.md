# Parallel Responses

[Parallel Responses](https://docs.parallel.ai/responses-api/responses-quickstart) (`POST https://api.parallel.ai/v1/responses`) researches the live web and returns an answer with URL citations, plus the searches it ran and the pages it read. Canonry runs it through the shared [search answer services](../answer-services.md) layer, so everything on that page applies here: it is never selected implicitly, only complete answers are measured, and unknown counts and costs stay unknown.

## Setup

Create a key at [platform.parallel.ai](https://platform.parallel.ai) and save it once:

```bash
cnry settings provider parallel --api-key <key>
```

`PARALLEL_API_KEY` is read by `cnry bootstrap`. Parallel documents no free request that proves a key, so a saved key shows as "saved, not verified" until the first real query. Saving a key never sends one.

Then name a profile wherever you choose engines. The bare `parallel` connection is not an engine.

```bash
cnry research run my-site --provider parallel:low --query "best roofer in springfield"
cnry project update my-site --provider gemini --provider parallel:medium
```

## Profiles

Parallel has one model, `parallel`, and a reasoning effort that sets how much research runs. Each profile sends one effort. The effort is part of the stored identity, so two profiles never share history.

| Route | `reasoning.effort` | Parallel's stated latency | Deadline per request | Workflows |
|---|---|---|---|---|
| `parallel:low` | `low` | about 5 to 10 seconds | 60 seconds | research, snapshot, visibility sweep |
| `parallel:medium` | `medium` (Parallel's default) | about 15 to 20 seconds | 120 seconds | research, snapshot, visibility sweep |
| `parallel:high` | `high` | about 30 to 60 seconds | 180 seconds | research, snapshot, visibility sweep |

The deadlines are Canonry's limits and leave room above Parallel's figures, because a request Canonry stops waiting for may still finish, and be charged, upstream. A request that reaches its deadline is not sent again.

## What is sent

```json
{ "model": "parallel", "input": "<the tracked query, unchanged>", "reasoning": { "effort": "low" }, "stream": false }
```

The key goes in `Authorization: Bearer`, as in Parallel's Responses examples. No `instructions`, `tools`, `data_sources`, `text`, `metadata`, `previous_response_id` or `background` is sent. Parallel takes no location (the `web_search` tool's `user_location` is documented as accepted and ignored), so a requested location is stored as `ignored` and the row does not claim the answer was measured from there. Parallel accepts at most 20,000 characters of input, so a longer query is refused before any request and never shortened.

## Evidence

Canonry reads the `output` array by item type, not the `output_text` shortcut.

| Parallel response | Stored as |
|---|---|
| `message` items, `output_text` parts | The answer, joined in order. A message whose `phase` is `commentary` is an interim note and stays in the raw response only. |
| `url_citation` annotations | Sources with the relationship `explicit-citation`, one per URL, each with every `start_index` and `end_index` span it supports. Several sources on one span each keep that span. They feed cited domains. |
| `web_search_call` with `action.type: "open_page"` | Sources with the relationship `page-read`, one per item (reading a page twice is two reads), with the item id and status. Never counted as cited. |
| `web_search_call` with `action.type: "search"` | Search queries (`action.queries`, or `action.query` when that is all there is), and a search count derived from these items. `action.sources` is documented as always null. |
| No `web_search_call` items in a complete response | Retrieval `not-used`: Parallel reports every search and page read as an item. |
| `usage` | Token counts with the basis `approximate`: Parallel calls them estimates and bills per request, not per token. They are never used as billable usage. |
| (nothing) | Cost. The response carries no amount, so cost is unknown, never zero. |
| `model` | Kept as a disclosed service tier. It is always `parallel`, which names the service, not a model, so `servedModel` stays empty. |
| `id` | The upstream request id. |
| `mcp_call`, `mcp_list_tools` | Not read; kept in the raw response. Canonry sends no MCP tools. |

## Completion

| `status` | Result |
|---|---|
| `completed` with a completed answer message | A complete answer. |
| `completed` with an unfinished message | Partial. |
| `incomplete` | Partial, with `incomplete_details.reason` (`max_output_tokens` or `content_filter`) as the finish reason. |
| `failed` | Failed, with Parallel's `error.message`. |
| `cancelled` | Failed. |
| `queued` or `in_progress` | Pending, with the response id kept as its handle. The Responses API is synchronous and offers no way to fetch the answer later, so the query is recorded as failed and never read as an answer. |
| absent | The answer message's status decides: completed is complete, incomplete is partial, anything else failed. |

Only a complete answer is measured. Partial, failed and pending answers are stored as failed queries with their evidence and any partial text.

## Errors and retries

Error bodies use the OpenAI envelope `{ "error": { "message", "type", "param", "code" } }`; validation errors carry `detail` entries with `loc` and `msg`. The failure message keeps Parallel's message and type. A model other than `parallel` is a 400 ("The Responses API only supports model 'parallel'."), which these profiles never send.

Only HTTP 429 is retried, at most twice, honoring `Retry-After`: the Responses pages say to back off and retry when over quota. Parallel's general error table also lists 500, 502 and 503 as retryable, but it describes the Task API, so Canonry does not resend them. 400, 401, 402, 403 and 422 need a fix first.

Parallel publishes no Responses rate limit. The `parallel` connection uses Canonry's default limits (2 at a time, 10 a minute, 1,000 a day), shared by every Parallel profile. Change them with `cnry settings provider parallel --max-per-minute <n>`.

## Not used

Streaming, structured output (`text.format`), `instructions`, domain filters on the `web_search` tool, MCP tools, data connectors, `previous_response_id` and the Task, Search, Extract and FindAll APIs are outside this adapter. Fixtures in `packages/provider-answer-services/test/services/parallel/` follow Parallel's documented response shapes; they were not captured from live responses.
